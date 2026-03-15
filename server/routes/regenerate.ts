import { Router, Request, Response } from "express";
import { db } from "../db";
import { projects, scenes } from "../../shared/schema";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { generateWhiskImageWithRefs, getStyleImagePaths } from "../lib/whisk";

const router = Router();

async function generateInworldAudio(text: string, apiKey: string, voiceId: string, modelId: string): Promise<Buffer> {
  const res = await fetch("https://api.inworld.ai/tts/v1/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${apiKey}` },
    body: JSON.stringify({
      text: text.substring(0, 2000),
      voiceId: voiceId || "Dennis",
      modelId: modelId || "inworld-tts-1.5-max",
      audioConfig: { audioEncoding: "MP3", sampleRateHertz: 22050 },
      temperature: 1.0,
      applyTextNormalization: "ON",
    }),
  });
  if (!res.ok) throw new Error(`Inworld TTS failed: ${res.status}`);
  const data = await res.json();
  if (!data.audioContent) throw new Error("No audioContent in Inworld response");
  return Buffer.from(data.audioContent, "base64");
}

function generateMockSVG(sceneNumber: number, prompt: string): string {
  const truncated = prompt.substring(0, 60) + (prompt.length > 60 ? "..." : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e"/><stop offset="100%" style="stop-color:#16213e"/></linearGradient></defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <text x="640" y="300" font-family="serif" font-size="72" fill="#c9a84c" text-anchor="middle" font-weight="bold">${sceneNumber}</text>
  <text x="640" y="380" font-family="sans-serif" font-size="18" fill="#888" text-anchor="middle">MOCK IMAGE</text>
  <text x="640" y="430" font-family="sans-serif" font-size="14" fill="#666" text-anchor="middle">${truncated.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>
</svg>`;
}

function generateMockAudio(): Buffer {
  const header = Buffer.from([
    0xFF, 0xFB, 0x90, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  return Buffer.concat(Array(38).fill(header));
}

router.post("/", async (req: Request, res: Response) => {
  try {
    const { projectId, sceneNumber, type, voiceOverride } = req.body;

    const [scene] = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .where(eq(scenes.scene_number, sceneNumber));
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    const settings = (project?.settings as any) || {};
    const imageProvider = settings.imageProvider || "mock";
    const ttsProvider = settings.ttsProvider || "mock";
    const voiceId = voiceOverride || scene.voice_id || settings.voiceId || "Dennis";
    const modelId = settings.modelId || "inworld-tts-1.5-max";

    if (type === "image") {
      const imgDir = path.join("uploads", projectId, "images");
      fs.mkdirSync(imgDir, { recursive: true });

      const regenStylePrompt: string | undefined = settings.stylePrompt;

      try {
        if (imageProvider === "whisk") {
          const cookie = process.env.WHISK_COOKIE;
          if (!cookie) throw new Error("WHISK_COOKIE not configured");
          const stylePaths = regenStylePrompt ? [] : getStyleImagePaths(projectId);
          const rawPrompts = [scene.image_prompt, ...(scene.fallback_prompts as string[] || [])];
          const allPrompts = regenStylePrompt
            ? rawPrompts.map((p: string) => `${p}, ${regenStylePrompt}`)
            : rawPrompts;
          let bytes: Uint8Array | null = null;
          for (const prompt of allPrompts) {
            try { bytes = await generateWhiskImageWithRefs(prompt, cookie, stylePaths); break; } catch (e: any) { console.error(`Whisk prompt failed: ${e.message}`); }
          }
          if (!bytes) throw new Error("All Whisk prompts failed");
          fs.writeFileSync(path.join(imgDir, `${sceneNumber}.png`), bytes);
        } else {
          const svg = generateMockSVG(sceneNumber, scene.image_prompt || "");
          fs.writeFileSync(path.join(imgDir, `${sceneNumber}.svg`), svg);
        }
        await db.update(scenes).set({
          image_status: "completed",
          image_attempts: (scene.image_attempts || 0) + 1,
          image_error: null,
          needs_review: false,
        }).where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, sceneNumber));
      } catch (e: any) {
        await db.update(scenes).set({
          image_status: "failed",
          image_attempts: (scene.image_attempts || 0) + 1,
          image_error: e.message,
          needs_review: true,
        }).where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, sceneNumber));
        throw e;
      }
    } else if (type === "audio") {
      const audioDir = path.join("uploads", projectId, "audio");
      fs.mkdirSync(audioDir, { recursive: true });

      try {
        const inworldKey = process.env.INWORLD_API_KEY;
        let bytes: Buffer;
        if (ttsProvider === "inworld" && inworldKey) {
          bytes = await generateInworldAudio(scene.tts_text || scene.script_text || "", inworldKey, voiceId, modelId);
        } else {
          bytes = generateMockAudio();
        }
        fs.writeFileSync(path.join(audioDir, `${sceneNumber}.mp3`), bytes);
        await db.update(scenes).set({
          audio_status: "completed",
          audio_attempts: (scene.audio_attempts || 0) + 1,
          audio_error: null,
          needs_review: false,
        }).where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, sceneNumber));
      } catch (e: any) {
        await db.update(scenes).set({
          audio_status: "failed",
          audio_attempts: (scene.audio_attempts || 0) + 1,
          audio_error: e.message,
          needs_review: true,
        }).where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, sceneNumber));
        throw e;
      }
    }

    const allScenes = await db.select().from(scenes).where(eq(scenes.project_id, projectId));
    const stats = {
      sceneCount: allScenes.length,
      imagesCompleted: allScenes.filter((s: any) => s.image_status === "completed").length,
      audioCompleted: allScenes.filter((s: any) => s.audio_status === "completed").length,
      imagesFailed: allScenes.filter((s: any) => s.image_status === "failed").length,
      audioFailed: allScenes.filter((s: any) => s.audio_status === "failed").length,
      needsReviewCount: allScenes.filter((s: any) => s.needs_review).length,
    };
    const status = (stats.imagesFailed > 0 || stats.audioFailed > 0) ? "partial" : "completed";
    await db.update(projects).set({ stats, status }).where(eq(projects.id, projectId));

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
