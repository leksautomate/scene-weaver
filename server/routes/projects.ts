import { Router, Request, Response } from "express";
import { db } from "../db";
import { projects, scenes } from "../../shared/schema";
import { eq, desc, or, gt } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";
import { generateWhiskImageWithRefs, getStyleImagePaths } from "../lib/whisk";

const router = Router();

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const projectId = req.body.projectId || "temp";
    const dir = path.join("uploads", projectId, "style");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    cb(null, file.fieldname + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

const DEFAULT_STYLE_SUMMARY = {
  palette: "desaturated, muted, slightly dark, historical documentary tone",
  lighting: "natural window light, candlelight, torchlight, overcast daylight, dim interiors",
  framing: "wide establishing shots, over-the-shoulder views, close details, behind-the-back framing",
  people: "anonymous figures, obscured faces, silhouettes, backs turned",
  mood: "tense, reflective, investigative, cinematic",
  historicalLook: "realistic period atmosphere, grounded environments, era-appropriate architecture, clothing, and objects",
};

function generateProjectId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "proj_";
  for (let i = 0; i < 8; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await db.select().from(projects).orderBy(desc(projects.created_at));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const projectScenes = await db.select().from(scenes)
      .where(eq(scenes.project_id, req.params.id))
      .orderBy(scenes.scene_number);
    res.json({ project, scenes: projectScenes });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", upload.fields([{ name: "style1", maxCount: 1 }, { name: "style2", maxCount: 1 }]), async (req: Request, res: Response) => {
  try {
    const { title, script, imageProvider, ttsProvider, voiceId, modelId, splitMode } = req.body;
    if (!title || !script) return res.status(400).json({ error: "Title and script are required" });

    const projectId = generateProjectId();

    const dir = path.join("uploads", projectId, "style");
    fs.mkdirSync(dir, { recursive: true });

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    if (files?.style1?.[0]) {
      const dest = path.join("uploads", projectId, "style", "style1.png");
      fs.renameSync(files.style1[0].path, dest);
    }
    if (files?.style2?.[0]) {
      const dest = path.join("uploads", projectId, "style", "style2.png");
      fs.renameSync(files.style2[0].path, dest);
    }

    await db.insert(projects).values({
      id: projectId,
      title,
      mode: "history",
      status: "processing",
      settings: {
        imageProvider: imageProvider || "mock",
        ttsProvider: ttsProvider || "mock",
        voiceId: voiceId || "Dennis",
        modelId: modelId || "inworld-tts-1.5-max",
        imageConcurrency: 2,
        audioConcurrency: 2,
        historyMode: true,
        splitMode: splitMode || "smart",
      },
      style_summary: DEFAULT_STYLE_SUMMARY,
      stats: { sceneCount: 0, imagesCompleted: 0, audioCompleted: 0, imagesFailed: 0, audioFailed: 0, needsReviewCount: 0 },
    });

    res.json({ projectId });
  } catch (e: any) {
    console.error("create-project error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:id/stop", async (req: Request, res: Response) => {
  try {
    await db.update(projects).set({ status: "stopped" }).where(eq(projects.id, req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db.delete(scenes).where(eq(scenes.project_id, req.params.id));
    await db.delete(projects).where(eq(projects.id, req.params.id));
    const dir = path.join("uploads", req.params.id);
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/split-scene", async (req: Request, res: Response) => {
  try {
    const { sceneNumber, splitAfterSentence } = req.body;
    const projectId = req.params.id;

    const [scene] = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .where(eq(scenes.scene_number, sceneNumber));
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    const sentences = scene.script_text.match(/[^.!?]+[.!?]+/g)?.map((s: string) => s.trim()) || [scene.script_text];
    const ttsSentences = scene.tts_text.match(/[^.!?]+[.!?]+/g)?.map((s: string) => s.trim()) || [scene.tts_text];

    const firstScript = sentences.slice(0, splitAfterSentence).join(" ");
    const secondScript = sentences.slice(splitAfterSentence).join(" ");
    const firstTts = ttsSentences.slice(0, splitAfterSentence).join(" ");
    const secondTts = ttsSentences.slice(splitAfterSentence).join(" ");

    await db.update(scenes).set({ script_text: firstScript, tts_text: firstTts })
      .where(eq(scenes.project_id, projectId))
      .where(eq(scenes.scene_number, sceneNumber));

    const laterScenes = await db.select({ id: scenes.id, scene_number: scenes.scene_number })
      .from(scenes)
      .where(eq(scenes.project_id, projectId))
      .where(gt(scenes.scene_number, sceneNumber))
      .orderBy(desc(scenes.scene_number));

    for (const s of laterScenes) {
      await db.update(scenes).set({ scene_number: s.scene_number + 1 }).where(eq(scenes.id, s.id));
    }

    const newNum = sceneNumber + 1;
    await db.insert(scenes).values({
      project_id: projectId,
      scene_number: newNum,
      scene_type: scene.scene_type,
      historical_period: scene.historical_period,
      visual_priority: scene.visual_priority,
      script_text: secondScript,
      tts_text: secondTts,
      image_prompt: scene.image_prompt,
      fallback_prompts: scene.fallback_prompts,
      image_file: `${newNum}.png`,
      audio_file: `${newNum}.mp3`,
      image_status: "pending",
      audio_status: "pending",
    });

    const allScenes = await db.select().from(scenes).where(eq(scenes.project_id, projectId));
    await db.update(projects).set({
      stats: {
        sceneCount: allScenes.length,
        imagesCompleted: allScenes.filter((s: any) => s.image_status === "completed").length,
        audioCompleted: allScenes.filter((s: any) => s.audio_status === "completed").length,
        imagesFailed: allScenes.filter((s: any) => s.image_status === "failed").length,
        audioFailed: allScenes.filter((s: any) => s.audio_status === "failed").length,
        needsReviewCount: allScenes.filter((s: any) => s.needs_review).length,
      },
    }).where(eq(projects.id, projectId));

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

async function runAssetPipeline(projectId: string) {
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return;

    const settings = (project.settings as any) || {};
    const imageProvider: string = settings.imageProvider || "mock";
    const ttsProvider: string = settings.ttsProvider || "mock";
    const voiceId: string = settings.voiceId || "Dennis";
    const modelId: string = settings.modelId || "inworld-tts-1.5-max";

    const sceneList = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .orderBy(scenes.scene_number);

    if (sceneList.length === 0) {
      console.log(`${projectId}: No scenes to process`);
      return;
    }

    console.log(`${projectId}: Starting asset pipeline for ${sceneList.length} scenes (image=${imageProvider}, tts=${ttsProvider})`);

    let imagesCompleted = 0, audioCompleted = 0, imagesFailed = 0, audioFailed = 0;

    for (const scene of sceneList) {
      const [projCheck] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId));
      if (projCheck?.status === "stopped") {
        console.log(`${projectId}: Pipeline stopped by user`);
        return;
      }

      const num = scene.scene_number;
      const imgDir = path.join("uploads", projectId, "images");
      const audioDir = path.join("uploads", projectId, "audio");
      fs.mkdirSync(imgDir, { recursive: true });
      fs.mkdirSync(audioDir, { recursive: true });

      try {
        if (imageProvider === "whisk") {
          const cookie = process.env.WHISK_COOKIE;
          if (!cookie) throw new Error("WHISK_COOKIE not set in environment");
          const stylePaths = getStyleImagePaths(projectId);
          const allPrompts = [scene.image_prompt, ...(scene.fallback_prompts as string[] || [])].filter(Boolean);
          let bytes: Uint8Array | null = null;
          let lastWhiskError = "All Whisk prompts failed";
          for (const prompt of allPrompts) {
            try {
              bytes = await generateWhiskImageWithRefs(prompt, cookie, stylePaths);
              break;
            } catch (e: any) {
              lastWhiskError = e.message;
              console.error(`${projectId} scene ${num}: Whisk prompt failed: ${e.message}`);
              if (e.message.includes("auth expired") || e.message.includes("Unauthorized") || e.message.includes("expired")) break;
            }
          }
          if (!bytes) throw new Error(lastWhiskError);
          fs.writeFileSync(path.join(imgDir, `${num}.png`), bytes);
        } else {
          const svg = generateMockSVG(num, scene.image_prompt || "");
          fs.writeFileSync(path.join(imgDir, `${num}.svg`), svg);
        }
        await db.update(scenes).set({ image_status: "completed", image_attempts: 1 })
          .where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, num));
        imagesCompleted++;
        console.log(`${projectId}: Scene ${num} image done (${imagesCompleted}/${sceneList.length})`);
      } catch (e: any) {
        console.error(`${projectId} scene ${num}: Image failed: ${e.message}`);
        await db.update(scenes).set({ image_status: "failed", image_attempts: 1, image_error: e.message, needs_review: true })
          .where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, num));
        imagesFailed++;
      }

      try {
        const inworldKey = process.env.INWORLD_API_KEY;
        if (ttsProvider === "inworld" && inworldKey) {
          const bytes = await generateInworldAudio(scene.tts_text || scene.script_text || "", inworldKey, voiceId, modelId);
          fs.writeFileSync(path.join(audioDir, `${num}.mp3`), bytes);
        } else {
          const bytes = generateMockAudio();
          fs.writeFileSync(path.join(audioDir, `${num}.mp3`), bytes);
        }
        await db.update(scenes).set({ audio_status: "completed", audio_attempts: 1 })
          .where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, num));
        audioCompleted++;
      } catch (e: any) {
        console.error(`${projectId} scene ${num}: Audio failed: ${e.message}`);
        await db.update(scenes).set({ audio_status: "failed", audio_attempts: 1, audio_error: e.message, needs_review: true })
          .where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, num));
        audioFailed++;
      }

      await db.update(projects).set({
        stats: { sceneCount: sceneList.length, imagesCompleted, audioCompleted, imagesFailed, audioFailed, needsReviewCount: imagesFailed + audioFailed },
      }).where(eq(projects.id, projectId));

      if (imageProvider === "whisk" && sceneList.indexOf(scene) < sceneList.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const allImagesAccountedFor = (imagesCompleted + imagesFailed) === sceneList.length;
    const allAudioAccountedFor = (audioCompleted + audioFailed) === sceneList.length;
    const hasFailures = imagesFailed > 0 || audioFailed > 0;
    const finalStatus = (allImagesAccountedFor && allAudioAccountedFor && !hasFailures) ? "completed" : "partial";
    await db.update(projects).set({ status: finalStatus }).where(eq(projects.id, projectId));
    console.log(`${projectId}: Asset pipeline complete. Status: ${finalStatus} (img ok=${imagesCompleted} fail=${imagesFailed}, aud ok=${audioCompleted} fail=${audioFailed})`);
  } catch (e: any) {
    console.error(`${projectId}: Asset pipeline error:`, e.message);
    await db.update(projects).set({ status: "failed" }).where(eq(projects.id, projectId));
  }
}

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
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" /><stop offset="100%" style="stop-color:#16213e;stop-opacity:1" /></linearGradient></defs>
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

async function runMissingImageGeneration(projectId: string) {
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return;

    const settings = (project.settings as any) || {};
    const imageProvider: string = settings.imageProvider || "mock";

    const allScenes = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .orderBy(scenes.scene_number);

    const targets = allScenes.filter(s => s.image_status !== "completed");
    if (targets.length === 0) {
      const imagesCompleted = allScenes.filter(s => s.image_status === "completed").length;
      const imagesFailed = allScenes.filter(s => s.image_status === "failed").length;
      const audioCompleted = allScenes.filter(s => s.audio_status === "completed").length;
      const audioFailed = allScenes.filter(s => s.audio_status === "failed").length;
      const allDone = (imagesCompleted + imagesFailed) === allScenes.length && (audioCompleted + audioFailed) === allScenes.length;
      const finalStatus = (allDone && imagesFailed === 0 && audioFailed === 0) ? "completed" : "partial";
      await db.update(projects).set({ status: finalStatus }).where(eq(projects.id, projectId));
      return;
    }

    const imgDir = path.join("uploads", projectId, "images");
    fs.mkdirSync(imgDir, { recursive: true });

    for (const scene of targets) {
      const [projCheck] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId));
      if (projCheck?.status === "stopped") {
        console.log(`${projectId}: generate-missing stopped by user`);
        return;
      }

      const num = scene.scene_number;
      try {
        if (imageProvider === "whisk") {
          const cookie = process.env.WHISK_COOKIE;
          if (!cookie) throw new Error("WHISK_COOKIE not set in environment");
          const stylePaths = getStyleImagePaths(projectId);
          const allPrompts = [scene.image_prompt, ...(scene.fallback_prompts as string[] || [])].filter(Boolean);
          let bytes: Uint8Array | null = null;
          let lastError = "All Whisk prompts failed";
          for (const prompt of allPrompts) {
            try {
              bytes = await generateWhiskImageWithRefs(prompt, cookie, stylePaths);
              break;
            } catch (e: any) {
              lastError = e.message;
              console.error(`${projectId} scene ${num}: Whisk prompt failed: ${e.message}`);
              if (e.message.includes("auth expired") || e.message.includes("Unauthorized") || e.message.includes("expired")) break;
            }
          }
          if (!bytes) throw new Error(lastError);
          fs.writeFileSync(path.join(imgDir, `${num}.png`), bytes);
          await db.update(scenes)
            .set({ image_status: "completed", image_file: `${num}.png`, image_attempts: (scene.image_attempts || 0) + 1, image_error: null, needs_review: false })
            .where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, num));
        } else {
          const svg = generateMockSVG(num, scene.image_prompt || "");
          fs.writeFileSync(path.join(imgDir, `${num}.svg`), svg);
          await db.update(scenes)
            .set({ image_status: "completed", image_file: `${num}.svg`, image_attempts: (scene.image_attempts || 0) + 1, image_error: null, needs_review: false })
            .where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, num));
        }
        console.log(`${projectId}: generate-missing scene ${num} image done`);
      } catch (e: any) {
        console.error(`${projectId} scene ${num}: generate-missing failed: ${e.message}`);
        await db.update(scenes)
          .set({ image_status: "failed", image_attempts: (scene.image_attempts || 0) + 1, image_error: e.message, needs_review: true })
          .where(eq(scenes.project_id, projectId)).where(eq(scenes.scene_number, num));
      }

      const updated = await db.select().from(scenes).where(eq(scenes.project_id, projectId));
      const statsUpdate = {
        sceneCount: updated.length,
        imagesCompleted: updated.filter(s => s.image_status === "completed").length,
        audioCompleted: updated.filter(s => s.audio_status === "completed").length,
        imagesFailed: updated.filter(s => s.image_status === "failed").length,
        audioFailed: updated.filter(s => s.audio_status === "failed").length,
        needsReviewCount: updated.filter(s => s.needs_review).length,
        serverPipeline: true,
      };
      await db.update(projects).set({ stats: statsUpdate }).where(eq(projects.id, projectId));
    }

    const final = await db.select().from(scenes).where(eq(scenes.project_id, projectId));
    const ic = final.filter(s => s.image_status === "completed").length;
    const iF = final.filter(s => s.image_status === "failed").length;
    const ac = final.filter(s => s.audio_status === "completed").length;
    const aF = final.filter(s => s.audio_status === "failed").length;
    const allAccounted = (ic + iF) === final.length && (ac + aF) === final.length;
    const finalStatus = (allAccounted && iF === 0 && aF === 0) ? "completed" : "partial";
    await db.update(projects).set({
      status: finalStatus,
      stats: { sceneCount: final.length, imagesCompleted: ic, audioCompleted: ac, imagesFailed: iF, audioFailed: aF, needsReviewCount: final.filter(s => s.needs_review).length, serverPipeline: true },
    }).where(eq(projects.id, projectId));
    console.log(`${projectId}: generate-missing complete. Status: ${finalStatus} (${ic}/${final.length} images ok)`);
  } catch (e: any) {
    console.error(`${projectId}: generate-missing error:`, e.message);
    await db.update(projects).set({ status: "partial" }).where(eq(projects.id, projectId));
  }
}

router.post("/:id/generate-missing", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  try {
    await db.update(projects).set({ status: "processing" }).where(eq(projects.id, projectId));
    res.status(202).json({ success: true });
    runMissingImageGeneration(projectId).catch(e =>
      console.error(`${projectId}: generate-missing crashed:`, e.message)
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/scenes/append", async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const { scenes: sceneList } = req.body;
    if (!sceneList || !Array.isArray(sceneList)) return res.status(400).json({ error: "scenes array required" });

    const sceneRows = sceneList.map((s: any, i: number) => ({
      project_id: projectId,
      scene_number: s.scene_number || i + 1,
      scene_type: s.scene_type || "location",
      historical_period: s.historical_period || "generic historical",
      visual_priority: s.visual_priority || "environment",
      script_text: s.script_text || "",
      tts_text: s.tts_text || s.script_text || "",
      image_prompt: s.image_prompt || "",
      fallback_prompts: s.fallback_prompts || [],
      image_file: s.image_file || `${s.scene_number || i + 1}.png`,
      audio_file: s.audio_file || `${s.scene_number || i + 1}.mp3`,
      image_status: "pending",
      audio_status: "pending",
    }));

    await db.insert(scenes).values(sceneRows);

    const allScenes = await db.select().from(scenes).where(eq(scenes.project_id, projectId));
    await db.update(projects).set({
      stats: {
        sceneCount: allScenes.length,
        imagesCompleted: allScenes.filter((s: any) => s.image_status === "completed").length,
        audioCompleted: allScenes.filter((s: any) => s.audio_status === "completed").length,
        imagesFailed: allScenes.filter((s: any) => s.image_status === "failed").length,
        audioFailed: allScenes.filter((s: any) => s.audio_status === "failed").length,
        needsReviewCount: allScenes.filter((s: any) => s.needs_review).length,
      },
    }).where(eq(projects.id, projectId));

    res.json({ success: true, appended: sceneList.length, total: allScenes.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/scenes", async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const { scenes: sceneList } = req.body;
    if (!sceneList || !Array.isArray(sceneList)) return res.status(400).json({ error: "scenes array required" });

    const sceneRows = sceneList.map((s: any, i: number) => ({
      project_id: projectId,
      scene_number: s.scene_number || i + 1,
      scene_type: s.scene_type || "location",
      historical_period: s.historical_period || "generic historical",
      visual_priority: s.visual_priority || "environment",
      script_text: s.script_text || "",
      tts_text: s.tts_text || s.script_text || "",
      image_prompt: s.image_prompt || "",
      fallback_prompts: s.fallback_prompts || [],
      image_file: s.image_file || `${s.scene_number || i + 1}.png`,
      audio_file: s.audio_file || `${s.scene_number || i + 1}.mp3`,
      image_status: "pending",
      audio_status: "pending",
    }));

    await db.insert(scenes).values(sceneRows);

    const hasWhiskCookie = !!process.env.WHISK_COOKIE;
    const hasInworldKey = !!process.env.INWORLD_API_KEY;
    const projectSettings = (await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)))[0]?.settings as any;
    const imageProvider = projectSettings?.imageProvider || "mock";
    const ttsProvider = projectSettings?.ttsProvider || "mock";

    const serverCanHandleImages = imageProvider === "mock" || (imageProvider === "whisk" && hasWhiskCookie);
    const serverCanHandleAudio = ttsProvider === "mock" || (ttsProvider === "inworld" && hasInworldKey);
    const serverPipeline = serverCanHandleImages && serverCanHandleAudio;

    await db.update(projects).set({
      status: "processing",
      stats: { sceneCount: sceneList.length, imagesCompleted: 0, audioCompleted: 0, imagesFailed: 0, audioFailed: 0, needsReviewCount: 0, serverPipeline },
    }).where(eq(projects.id, projectId));

    res.json({ success: true, serverPipeline });

    if (serverPipeline) {
      runAssetPipeline(projectId).catch(console.error);
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:id/scenes/:sceneNumber", async (req: Request, res: Response) => {
  try {
    const { id: projectId, sceneNumber } = req.params;
    const updates = req.body;
    await db.update(scenes).set(updates)
      .where(eq(scenes.project_id, projectId))
      .where(eq(scenes.scene_number, Number(sceneNumber)));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const updates = req.body;
    await db.update(projects).set(updates).where(eq(projects.id, req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export { runAssetPipeline, generateInworldAudio, generateMockSVG, generateMockAudio };
export default router;
