// Re-export shared utilities so existing imports and tests continue to work
export {
  estimateSceneCount,
  chunkScript,
  parseJsonResponse,
  buildContinuityAnchor,
  recoverScenesRegex,
  recoverPromptsRegex,
  type OutputScene,
  type ScriptToJsonResult,
  type ScriptToJsonParams,
} from "../../shared/scriptToJsonUtils";

import {
  type OutputScene,
  type ScriptToJsonResult,
  type ScriptToJsonParams,
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

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProgressCallback = (
  phase: "pass1" | "pass2",
  done: number,
  total: number,
  partialScenes?: OutputScene[]
) => void;

// ── API proxy helper ──────────────────────────────────────────────────────────

async function apiProxy(body: Record<string, unknown>): Promise<any> {
  const res = await fetch("/api/gemini-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API proxy error (HTTP ${res.status}): ${errText}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from API proxy: ${text.substring(0, 200)}`);
  }
}

async function callPass1(
  chunk: string,
  startId: number,
  wordsPerScene: number,
  secondsPerScene: number,
  provider: "groq" | "inworld" | "claude" | "gemini",
  apiKey: string,
  groqModel?: string,
  claudeModel?: string,
  rateLimitRetries = 3,
  retryOnParseFailure = true,
  geminiModel?: string
): Promise<SplitScene[]> {
  const systemPrompt = buildPass1SystemPrompt(wordsPerScene, secondsPerScene, startId);
  const userPrompt = `Split this script excerpt into scenes:\n\n${chunk}\n\nReturn ONLY the JSON object.`;

  const isGroq = provider === "groq";
  const isClaude = provider === "claude";
  const isGemini = provider === "gemini";
  const groqConfig = getGroqModelConfig(groqModel || "llama-3.3-70b-versatile");
  const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 3.8);
  const maxTokens = Math.max(1024, Math.min(4096, groqConfig.tpm - promptTokens - 200));

  const result = await apiProxy({
    action: isGroq ? "groq-chat" : isClaude ? "claude-chat" : isGemini ? "gemini-chat" : "inworld-chat",
    apiKey,
    payload: isGroq
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
      : isClaude
      ? {
        model: claudeModel || "claude-haiku-4-5-20251001",
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }
      : isGemini
      ? {
        model: geminiModel || "gemini-3.5-flash",
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
        max_tokens: 4096,
        response_format: { type: "json_object" }
      },
  });

  if (result.status && result.status >= 400) {
    const errText =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data || {}).substring(0, 500);
    if ((result.status === 429 || result.status === 413) && rateLimitRetries > 0) {
      if (errText.includes("tokens per day") || errText.includes("per day (TPD)")) {
        throw new Error(`Groq free plan daily token limit reached (100K/day for this model). Switch to "Llama 4 Scout 17B" in Settings — it has 500K TPD on the free plan — or try again tomorrow.`);
      }
      const baseWait = provider === "claude" ? 30000 : 15000;
      const waitTime = (4 - rateLimitRetries) * baseWait;
      console.log(`[${provider}] Pass1 rate limited (${result.status}) — waiting ${waitTime / 1000}s (attempts left: ${rateLimitRetries})...`);
      await delay(waitTime);
      return callPass1(chunk, startId, wordsPerScene, secondsPerScene, provider, apiKey, groqModel, claudeModel, rateLimitRetries - 1, retryOnParseFailure, geminiModel);
    }
    if (result.status === 401)
      throw new Error(`${provider === "groq" ? "Groq" : provider === "claude" ? "Claude" : provider === "gemini" ? "Gemini" : "Inworld"} API key is invalid. Update it in Settings.`);
    throw new Error(`${provider} Pass 1 error (HTTP ${result.status}): ${errText.substring(0, 200)}`);
  }

  let content = "";
  if (isClaude) {
    content = result.data?.content?.[0]?.text ?? "";
  } else if (isGemini) {
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
      console.warn(`[${provider}] Pass1 JSON parse failed — retrying with strict instruction`);
      return callPass1(chunk, startId, wordsPerScene, secondsPerScene, provider, apiKey, groqModel, claudeModel, rateLimitRetries, false, geminiModel);
    }
    throw new Error(`${provider} returned malformed JSON during scene splitting: ${err.message}`);
  }
}

// ── Pass 2 — Prompt generation ────────────────────────────────────────────────

async function callPass2Batch(
  title: string,
  scenes: SplitScene[],
  visualTypes: VisualType[],
  style: "impasto" | "ww2",
  provider: "groq" | "inworld" | "claude" | "gemini",
  apiKey: string,
  continuityAnchor: string,
  groqModel?: string,
  claudeModel?: string,
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

  const isGroq = provider === "groq";
  const isClaude = provider === "claude";
  const isGemini = provider === "gemini";
  const groqConfig = getGroqModelConfig(groqModel || "llama-3.3-70b-versatile");
  const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 3.8);
  const maxTokens = Math.max(1024, Math.min(4096, groqConfig.tpm - promptTokens - 200));

  const result = await apiProxy({
    action: isGroq ? "groq-chat" : isClaude ? "claude-chat" : isGemini ? "gemini-chat" : "inworld-chat",
    apiKey,
    payload: isGroq
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
      : isClaude
      ? {
        model: claudeModel || "claude-haiku-4-5-20251001",
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 4096,
      }
      : isGemini
      ? {
        model: geminiModel || "gemini-3.5-flash",
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
        max_tokens: 4096,
        response_format: { type: "json_object" }
      },
  });

  if (result.status && result.status >= 400) {
    const errText =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data || {}).substring(0, 500);
    if ((result.status === 429 || result.status === 413) && rateLimitRetries > 0) {
      if (errText.includes("tokens per day") || errText.includes("per day (TPD)")) {
        throw new Error(`Groq free plan daily token limit reached (100K/day for this model). Switch to "Llama 4 Scout 17B" in Settings — it has 500K TPD on the free plan — or try again tomorrow.`);
      }
      const baseWait = provider === "claude" ? 30000 : 15000;
      const waitTime = (4 - rateLimitRetries) * baseWait;
      console.log(`[${provider}] Pass2 rate limited (${result.status}) — waiting ${waitTime / 1000}s (attempts left: ${rateLimitRetries})...`);
      await delay(waitTime);
      return callPass2Batch(title, scenes, visualTypes, style, provider, apiKey, continuityAnchor, groqModel, claudeModel, rateLimitRetries - 1, retryOnParseFailure, geminiModel, stylePrompt);
    }
    if (result.status === 401)
      throw new Error(`${provider === "groq" ? "Groq" : provider === "claude" ? "Claude" : "gemini" ? "Gemini" : "Inworld"} API key is invalid.`);
    throw new Error(`${provider} Pass 2 error (HTTP ${result.status}): ${errText.substring(0, 200)}`);
  }

  let content = "";
  if (isClaude) {
    content = result.data?.content?.[0]?.text ?? "";
  } else if (isGemini) {
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
      return callPass2Batch(title, scenes, visualTypes, style, provider, apiKey, continuityAnchor, groqModel, claudeModel, rateLimitRetries, false, geminiModel, stylePrompt);
    }
    console.error(`[${provider}] Pass2 JSON parse failed twice — using placeholders. Error: ${err.message}`);
    return scenes.map((s) => ({ id: s.id, prompt: "[generation failed]" }));
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runScriptToJson(
  params: ScriptToJsonParams,
  onProgress: ProgressCallback
): Promise<ScriptToJsonResult> {
  const { title, script, secondsPerScene, style, provider, claudeModel, groqModel, geminiModel } = params;
  const apiKey = (
    provider === "groq"
      ? params.groqApiKey
      : provider === "claude"
      ? params.anthropicApiKey
      : provider === "gemini"
      ? params.geminiApiKey
      : params.inworldApiKey
  ) ?? "";

  const groqKeyPool = provider === "groq"
    ? (params.groqApiKeys?.filter(k => k?.trim()) ?? (apiKey ? [apiKey] : []))
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
          continue;
        }
        throw e;
      }
    }
  }

  // Vertex AI Claude predictions or Vertex AI Gemini predictions do not require a client-side API key
  const isVertex = (provider === "claude" && (
    claudeModel?.startsWith("publishers/") ||
    claudeModel?.includes("@") ||
    claudeModel === "claude-haiku-4-5" ||
    claudeModel === "claude-sonnet-4-6"
  )) || (provider === "gemini" && !apiKey);

  if (!apiKey && !isVertex) throw new Error(`No API key provided for ${provider}`);

  const wordsPerScene = Math.floor((WORDS_PER_MINUTE * secondsPerScene) / 60);
  const batchSize = provider === "groq" 
    ? GROQ_BATCH_SIZE 
    : provider === "claude" 
    ? 5 
    : provider === "gemini"
    ? 10
    : INWORLD_BATCH_SIZE;

  // ── Pass 1: scene splitting ─────────────────────────────────────────────────
  const chunks = chunkScript(script, PASS1_CHUNK_MAX_WORDS);
  onProgress("pass1", 0, chunks.length);

  const allSplitScenes: SplitScene[] = [];
  let nextId = 1;
  const groqConfig = getGroqModelConfig(params.groqModel || "llama-3.3-70b-versatile");

  // Calculate dynamic delays for Groq based on rate limits to prevent TPM 429s
  let delayPass1 = Math.ceil(60000 / groqConfig.rpm);
  if (groqConfig.tpm <= 15000) {
    delayPass1 = Math.max(delayPass1, Math.ceil(90000 / groqConfig.tpm * 1000));
  }
  let delayPass2 = Math.ceil(60000 / groqConfig.rpm);
  if (groqConfig.tpm <= 15000) {
    delayPass2 = Math.max(delayPass2, Math.ceil(90000 / groqConfig.tpm * 1000));
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      // Space out requests to avoid hitting TPM rate limits
      let waitMs = 2000;
      if (provider === "groq") waitMs = delayPass1;
      else if (provider === "claude") waitMs = 20000;
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
      params.groqModel,
      params.claudeModel,
      3,
      true,
      params.geminiModel
    ));
    scenes.forEach((s, idx) => { s.id = nextId + idx; });
    if (scenes.length === 0) {
      console.warn(`[${provider}] Pass1 chunk ${i + 1}/${chunks.length} returned 0 scenes`);
    }
    allSplitScenes.push(...scenes);
    nextId += scenes.length;
    onProgress("pass1", i + 1, chunks.length);
  }

  if (allSplitScenes.length === 0) throw new Error("No scenes were generated from the script");

  const rebalancedScenes = rebalanceScenesByDuration(allSplitScenes, wordsPerScene);
  const visualTypes = assignVisualTypes(rebalancedScenes.length);

  // ── Pass 2: prompt generation ───────────────────────────────────────────────
  const totalBatches = Math.ceil(rebalancedScenes.length / batchSize);
  onProgress("pass2", 0, rebalancedScenes.length);

  const promptMap = new Map<number, string>();
  const completedForAnchor: Array<{ script: string; prompt: string }> = [];

  for (let b = 0; b < totalBatches; b++) {
    if (b > 0) {
      // Space out requests to avoid hitting TPM rate limits
      let waitMs = 1000;
      if (provider === "groq") waitMs = delayPass2;
      else if (provider === "claude") waitMs = 12000;
      else if (provider === "inworld") waitMs = 2000;
      await delay(waitMs);
    }
    const batch = rebalancedScenes.slice(b * batchSize, (b + 1) * batchSize);
    const batchVisualTypes = visualTypes.slice(b * batchSize, (b + 1) * batchSize);
    const anchor = buildContinuityAnchor(completedForAnchor);

    const results = await withGroqRotation(key => callPass2Batch(title, batch, batchVisualTypes, style, provider, key, anchor, params.groqModel, params.claudeModel, 3, true, params.geminiModel, params.stylePrompt));

    for (const r of results) {
      const idVal = r.id ?? r.scene_number ?? (r as any).sceneNumber ?? (r as any).scene_id ?? (r as any).scene_Id;
      const promptVal = r.prompt ?? r.image_prompt ?? (r as any).description ?? (r as any).imagePrompt;
      if (idVal !== undefined && promptVal !== undefined) {
        let numericId: number | undefined;
        if (typeof idVal === "number") {
          numericId = idVal;
        } else {
          const match = String(idVal).match(/\d+/);
          if (match) numericId = parseInt(match[0], 10);
        }
        if (numericId !== undefined) {
          promptMap.set(numericId, promptVal);
        }
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
    onProgress("pass2", doneSoFar, rebalancedScenes.length, partialScenes);
  }

  const scenes: OutputScene[] = rebalancedScenes.map((s) => ({
    image: `${s.id}.png`,
    script: s.script,
    prompt: promptMap.get(s.id) ?? "[generation failed]",
    overlay_text: s.overlay_text,
  }));

  return { title, scenes };
}
