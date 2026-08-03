import { Router, Request, Response } from "express";
import { generateGeminiImage, getArkDailyUsage, PROJECT_ID, getAccessToken } from "../lib/gemini.js";
import { GoogleGenAI } from "@google/genai";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { action, payload, apiKey } = req.body;

    if (action === "ark-usage") {
      return res.json({ status: 200, data: getArkDailyUsage() });
    }

    if (action === "generate") {
      const promptText: string = payload?.userInput?.prompts?.[0] || payload?.prompt || "";
      if (!promptText) return res.json({ status: 400, data: { error: "prompt required" } });

      try {
        const imageBase64 = await generateGeminiImage(promptText, payload?.aspectRatio, {
          apiKey: payload?.arkApiKey || apiKey,
        });
        return res.json({
          status: 200,
          data: { imagePanels: [{ generatedImages: [{ encodedImage: imageBase64 }] }] },
        });
      } catch (e: any) {
        console.error("[gemini-proxy] generate error:", e.message);
        return res.json({ status: 500, data: { error: e.message } });
      }
    }

    if (action === "groq-chat") {
      const key = apiKey || process.env.GROQ_API_KEY;
      if (!key) return res.json({ status: 500, data: { error: "GROQ_API_KEY not configured" } });
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 1000) }; }
      return res.json({ status: r.status, data });
    }

    if (action === "deepseek-chat") {
      const key = apiKey || process.env.ARK_API_KEY;
      if (!key) return res.json({ status: 500, data: { error: "ARK_API_KEY not configured" } });
      const r = await fetch("https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 1000) }; }
      return res.json({ status: r.status, data });
    }

    if (action === "inworld-chat") {
      const key = apiKey || process.env.INWORLD_API_KEY;
      if (!key) return res.json({ status: 500, data: { error: "INWORLD_API_KEY not configured" } });
      const r = await fetch("https://api.inworld.ai/v1/chat/completions", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          "Authorization": `Basic ${key}` 
        },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 1000) }; }
      return res.json({ status: r.status, data });
    }

    if (action === "claude-chat") {
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
        return res.json({ status: r.status, data });
      } catch (e: any) {
        console.error("[gemini-proxy] claude-vertex error:", e.message);
        return res.json({ status: 500, data: { error: e.message } });
      }
    }

    if (action === "gemini-chat") {
      try {
        const gCloudKey = apiKey || process.env.GOOGLE_CLOUD_API_KEY;
        const ai = new GoogleGenAI({
          apiKey: gCloudKey,
          vertexai: true,
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

        return res.json({
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
        });
      } catch (e: any) {
        console.error("[gemini-proxy] gemini-sdk error:", e.message);
        return res.json({ status: 500, data: { error: e.message } });
      }
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
