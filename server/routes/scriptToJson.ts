import { Router, Request, Response } from "express";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import {
  type OutputScene,
  type ScriptToJsonResult,
  type SplitScene,
  WORDS_PER_MINUTE,
  PASS1_CHUNK_MAX_WORDS,
  GROQ_BATCH_SIZE,
  INWORLD_BATCH_SIZE,
  chunkScript,
  parseJsonResponse,
  recoverScenesRegex,
  recoverPromptsRegex,
  buildContinuityAnchor,
  buildPass1SystemPrompt,
  rebalanceScenesByDuration,
  assignVisualTypes,
  type VisualType,
  PASS2_IMPASTO_SYSTEM,
  PASS2_WWII_SYSTEM,
  getGroqModelConfig,
} from "../../shared/scriptToJsonUtils";
import { PROJECT_ID, getAccessToken } from "../lib/gemini.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface JobProgress {
  phase: "pass1" | "pass2";
  done: number;
  total: number;
  partialScenes?: OutputScene[];
}

interface Job {
  id: string;
  status: "running" | "completed" | "failed";
  progress: JobProgress;
  result: ScriptToJsonResult | null;
  error: string | null;
  createdAt: number;
  params?: Omit<JobParams, "apiKey">;
}

interface JobParams {
  title: string;
  script: string;
  secondsPerScene: number;
  style: "impasto" | "ww2";
  provider: "groq" | "inworld" | "claude" | "gemini";
  apiKey: string;
  groqApiKeys?: string[];
  claudeModel?: string;
  groqModel?: string;
  geminiModel?: string;
  stylePrompt?: string;
}

// ── Job store ─────────────────────────────────────────────────────────────────

const jobs = new Map<string, Job>();
const JOBS_FILE_PATH = path.join(process.cwd(), "uploads", "script_to_json_jobs.json");

function saveJobsToDisk() {
  try {
    const dir = path.dirname(JOBS_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = Array.from(jobs.entries());
    fs.writeFileSync(JOBS_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (e: any) {
    console.error("[scriptToJson] Failed to save jobs to disk:", e.message);
  }
}

function loadJobsFromDisk() {
  try {
    if (fs.existsSync(JOBS_FILE_PATH)) {
      const text = fs.readFileSync(JOBS_FILE_PATH, "utf-8");
      const data = JSON.parse(text) as Array<[string, Job]>;
      let updated = false;
      for (const [id, job] of data) {
        if (job.status === "running") {
          job.status = "failed";
          job.error = "Job interrupted by server restart";
          updated = true;
        }
        jobs.set(id, job);
      }
      console.log(`[scriptToJson] Loaded ${jobs.size} jobs from history.`);
      if (updated) {
        saveJobsToDisk();
      }
    }
  } catch (e: any) {
    console.error("[scriptToJson] Failed to load jobs from disk:", e.message);
  }
}

// Load jobs on startup
loadJobsFromDisk();

// ── Direct API call ───────────────────────────────────────────────────────────

async function callApi(
  provider: "groq" | "inworld" | "claude" | "gemini",
  apiKey: string,
  payload: any
): Promise<{ status: number; data: any }> {
  if (provider === "gemini") {
    try {
      const geminiKey = apiKey || process.env.GEMINI_API_KEY;
      const ai = geminiKey
        ? new GoogleGenAI({ apiKey: geminiKey })
        : new GoogleGenAI({
            vertexai: true,
            project: PROJECT_ID,
            location: process.env.VERTEX_LOCATION_ID || "europe-west4",
          });

      const model = payload?.model || "gemini-3.1-pro-preview";
      const systemInstruction = payload.systemInstruction?.parts?.[0]?.text || payload.systemInstruction;

      const response = await ai.models.generateContent({
        model: model,
        contents: payload.contents,
        config: {
          systemInstruction: systemInstruction,
          temperature: payload.generationConfig?.temperature ?? 1,
          maxOutputTokens: 65535,
          topP: payload.generationConfig?.topP ?? 0.95,
          responseMimeType: payload.generationConfig?.responseMimeType,
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }
          ]
        }
      });

      return {
        status: 200,
        data: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: response.text || ""
                  }
                ]
              }
            }
          ]
        }
      };
    } catch (e: any) {
      console.error("[scriptToJson] gemini SDK error:", e.message);
      return { status: 500, data: { error: e.message } };
    }
  }

  if (provider === "claude") {
    const modelName = payload?.model || "claude-sonnet-4-6";
    try {
      const modelPath = modelName.startsWith("publishers/") 
        ? modelName 
        : `publishers/anthropic/models/${modelName}`;
      
      const region = "global";
      const host = "aiplatform.googleapis.com";
      const url = `https://${host}/v1/projects/${PROJECT_ID}/locations/${region}/${modelPath}:rawPredict`;
      const accessToken = getAccessToken();

      const { model, ...bodyWithoutModel } = payload;
      const vertexPayload = {
        ...bodyWithoutModel,
        max_tokens: bodyWithoutModel.max_tokens || 65535,
        anthropic_version: "vertex-2023-10-16"
      };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(vertexPayload)
      });

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 1000) }; }
      return { status: r.status, data };
    } catch (e: any) {
      console.error("[scriptToJson] Vertex Claude call failed:", e.message);
      return { status: 500, data: { error: e.message } };
    }
  }

  if (provider === "inworld") {
    const key = apiKey || process.env.INWORLD_API_KEY || "";
    const url = "https://api.inworld.ai/v1/chat/completions";
    const r = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Authorization": `Basic ${key}` 
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.substring(0, 1000) };
    }
    return { status: r.status, data };
  }

  const key = apiKey || (provider === "groq" ? process.env.GROQ_API_KEY : "") || "";
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.substring(0, 1000) };
  }
  return { status: r.status, data };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Pass 1 ────────────────────────────────────────────────────────────────────

async function callPass1(
  chunk: string,
  startId: number,
  wordsPerScene: number,
  secondsPerScene: number,
  provider: "groq" | "inworld" | "claude" | "gemini",
  apiKey: string,
  claudeModel?: string,
  groqModel?: string,
  rateLimitRetries = 3,
  retryOnParseFailure = true,
  geminiModel?: string
): Promise<SplitScene[]> {
  const systemPrompt = buildPass1SystemPrompt(wordsPerScene, secondsPerScene, startId);
  const userPrompt = `Split this script excerpt into scenes:\n\n${chunk}\n\nReturn ONLY the JSON object.`;

  const groqConfig = getGroqModelConfig(groqModel || "llama-3.3-70b-versatile");
  const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 3.8);
  const maxTokens = Math.max(1024, Math.min(4096, groqConfig.tpm - promptTokens - 200));
  const payload =
    provider === "groq"
      ? {
          model: groqConfig.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
        }
      : provider === "claude"
      ? {
          model: claudeModel || "claude-haiku-4-5",
          system: systemPrompt,
          messages: [
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 4096,
        }
      : provider === "gemini"
      ? {
          model: geminiModel || "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            temperature: 1,
            maxOutputTokens: 8192,
            topP: 0.95,
            responseMimeType: "application/json",
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" }
          ]
        }
      : {
          model: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 1000,
          response_format: {
            type: "json_object"
          }
        };

  const result = await callApi(provider, apiKey, payload);

  if (result.status >= 400) {
    const errText =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data || {}).substring(0, 500);
    if (([429, 413, 500, 502, 503, 504].includes(result.status)) && rateLimitRetries > 0) {
      if (result.status === 429 && (errText.includes("tokens per day") || errText.includes("per day (TPD)"))) {
        throw new Error(`Groq free plan daily token limit reached (100K/day for this model). Switch to "Llama 4 Scout 17B" in Settings — it has 500K TPD on the free plan — or try again tomorrow.`);
      }
      const baseWait = provider === "claude" ? 30000 : 15000;
      const waitTime = (4 - rateLimitRetries) * baseWait;
      console.log(`[${provider}] Pass1 rate limited or transient error (${result.status}) — waiting ${waitTime / 1000}s (attempts left: ${rateLimitRetries})...`);
      await delay(waitTime);
      return callPass1(chunk, startId, wordsPerScene, secondsPerScene, provider, apiKey, claudeModel, groqModel, rateLimitRetries - 1, retryOnParseFailure, geminiModel);
    }
    if (result.status === 401)
      throw new Error(`${provider === "groq" ? "Groq" : provider === "claude" ? "Claude" : provider === "gemini" ? "Gemini" : "Inworld"} API key is invalid.`);
    throw new Error(`${provider} Pass 1 error (HTTP ${result.status}): ${errText.substring(0, 200)}`);
  }

  let content = "";
  if (provider === "claude") {
    content = result.data?.content?.[0]?.text ?? "";
  } else if (provider === "gemini") {
    const parts: any[] = result.data?.candidates?.[0]?.content?.parts ?? [];
    const textPart = parts.find((p: any) => !p.thought) ?? parts[parts.length - 1];
    content = textPart?.text ?? "";
    if (!content) {
      content = result.data?.choices?.[0]?.message?.content ?? "";
    }
  } else {
    content = result.data?.choices?.[0]?.message?.content ?? "";
    if (!content && result.data?.choices?.[0]?.message?.reasoning_content) {
      content = result.data.choices[0].message.reasoning_content;
    }
    if (!content && result.data?.choices?.[0]?.message?.reasoning) {
      content = result.data.choices[0].message.reasoning;
    }
  }

  if (!content) {
    console.error(`[${provider}] Pass1 result data:`, JSON.stringify(result.data));
    throw new Error(`No content from ${provider} during scene splitting`);
  }

  try {
    const parsed = parseJsonResponse(content);
    return (parsed.scenes ?? []) as SplitScene[];
  } catch (err: any) {
    const recovered = recoverScenesRegex(content);
    if (recovered.length > 0) {
      console.log(`[${provider}] Pass1: Recovered ${recovered.length} scenes via regex from malformed/truncated output.`);
      return recovered;
    }
    if (retryOnParseFailure) {
      console.warn(`[${provider}] Pass1 JSON parse failed — retrying`);
      return callPass1(chunk, startId, wordsPerScene, secondsPerScene, provider, apiKey, claudeModel, groqModel, rateLimitRetries, false, geminiModel);
    }
    throw new Error(`${provider} returned malformed JSON during scene splitting: ${err.message}`);
  }
}

// ── Pass 2 ────────────────────────────────────────────────────────────────────

async function callPass2Batch(
  title: string,
  scenes: SplitScene[],
  visualTypes: VisualType[],
  style: "impasto" | "ww2",
  provider: "groq" | "inworld" | "claude" | "gemini",
  apiKey: string,
  continuityAnchor: string,
  claudeModel?: string,
  groqModel?: string,
  rateLimitRetries = 3,
  retryOnParseFailure = true,
  geminiModel?: string,
  stylePrompt?: string
): Promise<Array<{ id?: number; scene_number?: number; prompt?: string; image_prompt?: string }>> {
  const baseSystem = style === "ww2" ? PASS2_WWII_SYSTEM : PASS2_IMPASTO_SYSTEM;
  const systemPromptPrompt = stylePrompt
    ? `${baseSystem}\n\n---\nADDITIONAL STYLE DIRECTION (follow these instructions for all image prompts):\n${stylePrompt}`
    : baseSystem;
  const systemPrompt = continuityAnchor ? `${systemPromptPrompt}\n\n${continuityAnchor}` : systemPromptPrompt;

  const scenesText = scenes
    .map((s, i) => `Scene ${s.id} [${visualTypes[i].toUpperCase()}]: "${s.script}"`)
    .join("\n");
  const userPrompt = `Documentary title: "${title}"\n\nGenerate ONE image prompt for each scene below. Return ONLY the JSON object.\n\n${scenesText}`;

  const groqConfig = getGroqModelConfig(groqModel || "llama-3.3-70b-versatile");
  const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 3.8);
  const maxTokens = Math.max(1024, Math.min(4096, groqConfig.tpm - promptTokens - 200));
  const payload =
    provider === "groq"
      ? {
          model: groqConfig.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.4,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
        }
      : provider === "claude"
      ? {
          model: claudeModel || "claude-haiku-4-5",
          system: systemPrompt,
          messages: [
            { role: "user", content: userPrompt },
          ],
          temperature: 0.4,
          max_tokens: 4096,
        }
      : provider === "gemini"
      ? {
          model: geminiModel || "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            temperature: 1,
            maxOutputTokens: 8192,
            topP: 0.95,
            responseMimeType: "application/json",
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" }
          ]
        }
      : {
          model: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.4,
          max_tokens: 1000,
          response_format: {
            type: "json_object"
          }
        };

  const result = await callApi(provider, apiKey, payload);

  if (result.status >= 400) {
    const errText =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data || {}).substring(0, 500);
    if (([429, 413, 500, 502, 503, 504].includes(result.status)) && rateLimitRetries > 0) {
      if (result.status === 429 && (errText.includes("tokens per day") || errText.includes("per day (TPD)"))) {
        throw new Error(`Groq free plan daily token limit reached (100K/day for this model). Switch to "Llama 4 Scout 17B" in Settings — it has 500K TPD on the free plan — or try again tomorrow.`);
      }
      const baseWait = provider === "claude" ? 30000 : 15000;
      const waitTime = (4 - rateLimitRetries) * baseWait;
      console.log(`[${provider}] Pass2 rate limited or transient error (${result.status}) — waiting ${waitTime / 1000}s (attempts left: ${rateLimitRetries})...`);
      await delay(waitTime);
      return callPass2Batch(title, scenes, visualTypes, style, provider, apiKey, continuityAnchor, claudeModel, groqModel, rateLimitRetries - 1, retryOnParseFailure, geminiModel, stylePrompt);
    }
    if (result.status === 401)
      throw new Error(`${provider === "groq" ? "Groq" : provider === "claude" ? "Claude" : provider === "gemini" ? "Gemini" : "Inworld"} API key is invalid.`);
    throw new Error(`${provider} Pass 2 error (HTTP ${result.status}): ${errText.substring(0, 200)}`);
  }

  let content = "";
  if (provider === "claude") {
    content = result.data?.content?.[0]?.text ?? "";
  } else if (provider === "gemini") {
    const parts: any[] = result.data?.candidates?.[0]?.content?.parts ?? [];
    const textPart = parts.find((p: any) => !p.thought) ?? parts[parts.length - 1];
    content = textPart?.text ?? "";
    if (!content) {
      content = result.data?.choices?.[0]?.message?.content ?? "";
    }
  } else {
    content = result.data?.choices?.[0]?.message?.content ?? "";
    if (!content && result.data?.choices?.[0]?.message?.reasoning_content) {
      content = result.data.choices[0].message.reasoning_content;
    }
    if (!content && result.data?.choices?.[0]?.message?.reasoning) {
      content = result.data.choices[0].message.reasoning;
    }
  }

  if (!content) {
    console.error(`[${provider}] Pass2 result data:`, JSON.stringify(result.data));
    throw new Error(`No content from ${provider} during prompt generation`);
  }

  try {
    const parsed = parseJsonResponse(content);
    return parsed.scenes ?? [];
  } catch (err: any) {
    const recovered = recoverPromptsRegex(content);
    if (recovered.length > 0) {
      console.log(`[${provider}] Pass2: Recovered ${recovered.length} prompts via regex from malformed/truncated output.`);
      return recovered;
    }
    if (retryOnParseFailure) {
      console.warn(`[${provider}] Pass2 JSON parse failed — retrying`);
      return callPass2Batch(title, scenes, visualTypes, style, provider, apiKey, continuityAnchor, claudeModel, groqModel, rateLimitRetries, false, geminiModel, stylePrompt);
    }
    console.error(`[${provider}] Pass2 JSON parse failed twice — using placeholders. Error: ${err.message}`);
    return scenes.map((s) => ({ id: s.id, prompt: "[generation failed]" }));
  }
}

// ── Pipeline runner ───────────────────────────────────────────────────────────

async function runJob(job: Job, params: JobParams): Promise<void> {
  const { title, script, secondsPerScene, style, provider, apiKey, groqApiKeys: rawGroqKeys, claudeModel, groqModel, geminiModel, stylePrompt } = params;

  const groqKeyPool = provider === "groq"
    ? (rawGroqKeys?.filter(k => k?.trim()) ?? (apiKey ? [apiKey] : []))
    : [];
  let groqKeyIndex = 0;
  const activeKey = () => provider === "groq" ? (groqKeyPool[groqKeyIndex] ?? apiKey) : apiKey;

  async function withGroqRotation<T>(fn: (key: string) => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await fn(activeKey());
      } catch (e: any) {
        if (provider === "groq" && e.message?.includes("daily token limit") && groqKeyIndex + 1 < groqKeyPool.length) {
          groqKeyIndex++;
          console.log(`[groq] Key ${groqKeyIndex} exhausted (TPD), rotating to key ${groqKeyIndex + 1}/${groqKeyPool.length}`);
          continue;
        }
        throw e;
      }
    }
  }
  const wordsPerScene = Math.floor((WORDS_PER_MINUTE * secondsPerScene) / 60);
  const batchSize = provider === "groq" 
    ? GROQ_BATCH_SIZE 
    : provider === "claude" 
    ? 5 
    : provider === "gemini"
    ? 10
    : INWORLD_BATCH_SIZE;

  const groqConfig = getGroqModelConfig(groqModel || "llama-3.3-70b-versatile");
  
  // Calculate dynamic delays for Groq based on rate limits to prevent TPM 429s
  let delayPass1 = Math.ceil(60000 / groqConfig.rpm);
  if (groqConfig.tpm <= 15000) {
    delayPass1 = Math.max(delayPass1, Math.ceil(90000 / groqConfig.tpm * 1000));
  }
  let delayPass2 = Math.ceil(60000 / groqConfig.rpm);
  if (groqConfig.tpm <= 15000) {
    delayPass2 = Math.max(delayPass2, Math.ceil(90000 / groqConfig.tpm * 1000));
  }

  try {
    // Pass 1
    const chunks = chunkScript(script, PASS1_CHUNK_MAX_WORDS);
    job.progress = { phase: "pass1", done: 0, total: chunks.length };
    saveJobsToDisk();

    const allSplitScenes: SplitScene[] = [];
    let nextId = 1;

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        // Space out requests to avoid hitting TPM/RPM rate limits
        let waitMs = 2000;
        if (provider === "groq") waitMs = delayPass1;
        else if (provider === "claude") waitMs = 12000;
        else if (provider === "gemini") waitMs = 6000;
        else if (provider === "inworld") waitMs = 3000;
        await delay(waitMs);
      }
      const scenes = await withGroqRotation(key => callPass1(
        chunks[i],
        nextId,
        wordsPerScene,
        secondsPerScene,
        provider,
        key,
        claudeModel,
        groqModel,
        3,
        true,
        geminiModel
      ));
      scenes.forEach((s, idx) => { s.id = nextId + idx; });
      allSplitScenes.push(...scenes);
      nextId += scenes.length;
      job.progress = { phase: "pass1", done: i + 1, total: chunks.length };
      saveJobsToDisk();
    }

    if (allSplitScenes.length === 0) throw new Error("No scenes were generated from the script");

    const rebalancedScenes = rebalanceScenesByDuration(allSplitScenes, wordsPerScene);
    const visualTypes = assignVisualTypes(rebalancedScenes.length);

    // Pass 2
    const totalBatches = Math.ceil(rebalancedScenes.length / batchSize);
    job.progress = { phase: "pass2", done: 0, total: rebalancedScenes.length };
    saveJobsToDisk();

    const promptMap = new Map<number, string>();
    const completedForAnchor: Array<{ script: string; prompt: string }> = [];

    for (let b = 0; b < totalBatches; b++) {
      if (b > 0) {
        // Space out requests to avoid hitting TPM/RPM rate limits
        let waitMs = 2000;
        if (provider === "groq") waitMs = delayPass2;
        else if (provider === "claude") waitMs = 12000;
        else if (provider === "gemini") waitMs = 6000;
        else if (provider === "inworld") waitMs = 3000;
        await delay(waitMs);
      }
      const batch = rebalancedScenes.slice(b * batchSize, (b + 1) * batchSize);
      const batchVisualTypes = visualTypes.slice(b * batchSize, (b + 1) * batchSize);
      const anchor = buildContinuityAnchor(completedForAnchor);
      const results = await withGroqRotation(key => callPass2Batch(title, batch, batchVisualTypes, style, provider, key, anchor, claudeModel, groqModel, 3, true, geminiModel, stylePrompt));

      for (const r of results) {
        const idVal = r.id ?? r.scene_number ?? (r as any).sceneNumber ?? (r as any).scene_id ?? (r as any).scene_Id;
        const promptVal = r.prompt ?? r.image_prompt ?? (r as any).description ?? (r as any).imagePrompt;
        if (idVal !== undefined && promptVal !== undefined) {
          promptMap.set(Number(idVal), promptVal);
        }
      }
      for (const scene of batch) {
        completedForAnchor.push({ script: scene.script, prompt: promptMap.get(scene.id) ?? "[generation failed]" });
      }

      const doneSoFar = Math.min((b + 1) * batchSize, rebalancedScenes.length);
      const partialScenes: OutputScene[] = rebalancedScenes
        .filter((s) => promptMap.has(s.id))
        .map((s) => ({
          image: `${s.id}.png`,
          script: s.script,
          prompt: promptMap.get(s.id)!,
          overlay_text: s.overlay_text,
        }));
      job.progress = { phase: "pass2", done: doneSoFar, total: rebalancedScenes.length, partialScenes };
      saveJobsToDisk();
    }

    const scenes: OutputScene[] = rebalancedScenes.map((s) => ({
      image: `${s.id}.png`,
      script: s.script,
      prompt: promptMap.get(s.id) ?? "[generation failed]",
      overlay_text: s.overlay_text,
    }));

    job.status = "completed";
    job.result = { title, scenes };
    saveJobsToDisk();
  } catch (e: any) {
    job.status = "failed";
    job.error = e.message ?? "Unknown error";
    console.error(`[scriptToJson] Job ${job.id} failed:`, e.message);
    saveJobsToDisk();
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

const router = Router();

// GET all jobs (history)
router.get("/", (_req: Request, res: Response) => {
  const jobList = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  res.json(jobList);
});

router.post("/", (req: Request, res: Response) => {
  const { title, script, secondsPerScene, style, provider, apiKey, groqApiKeys, claudeModel, groqModel, geminiModel, stylePrompt } = req.body as JobParams;

  if (!title || !script || !provider) {
    return res.status(400).json({ error: "title, script, and provider are required" });
  }
  if (!["groq", "inworld", "claude", "gemini"].includes(provider)) {
    return res.status(400).json({ error: "provider must be groq, inworld, claude, or gemini" });
  }
  if (!apiKey && !process.env.GROQ_API_KEY && provider === "groq") {
    return res.status(400).json({ error: "No Groq API key. Set one in Settings." });
  }
  if (!apiKey && !process.env.INWORLD_API_KEY && provider === "inworld") {
    return res.status(400).json({ error: "No Inworld API key. Set one in Settings." });
  }
  if (provider === "claude") {
    const isVertex = claudeModel?.startsWith("publishers/") || claudeModel?.includes("@") || claudeModel === "claude-haiku-4-5";
    if (!isVertex && !apiKey && !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: "No Anthropic API key. Set one in Settings." });
    }
  }

  const jobId = crypto.randomUUID();
  const job: Job = {
    id: jobId,
    status: "running",
    progress: { phase: "pass1", done: 0, total: 1 },
    result: { title, scenes: [] },
    error: null,
    createdAt: Date.now(),
    params: {
      title: title.trim(),
      script: script.trim(),
      secondsPerScene: secondsPerScene ?? 15,
      style: style ?? "impasto",
      provider,
      claudeModel,
      groqModel,
      geminiModel,
      stylePrompt: stylePrompt?.trim(),
    }
  };
  jobs.set(jobId, job);
  saveJobsToDisk();

  // Fire and forget — runs in background
  runJob(job, { title, script, secondsPerScene: secondsPerScene ?? 15, style: style ?? "impasto", provider, apiKey: apiKey ?? "", groqApiKeys, claudeModel, groqModel, geminiModel, stylePrompt });

  res.json({ jobId });
});

router.get("/:jobId", (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    params: job.params,
  });
});

// DELETE a specific job from history
router.delete("/:jobId", (req: Request, res: Response) => {
  const { jobId } = req.params;
  if (jobs.has(jobId)) {
    jobs.delete(jobId);
    saveJobsToDisk();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Job not found" });
  }
});

export default router;
