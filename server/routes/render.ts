import express, { Request, Response } from "express";
import { db } from "../db.js";
import { projects, scenes } from "../../shared/schema.js";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import archiver from "archiver";
import { animateWhiskImage } from "../lib/whisk.js";

const router = express.Router();

// ── Ken Burns effect types ─────────────────────────────────────────────────
type KBEffect = "zoom-in" | "zoom-out" | "pan-right" | "pan-left" | "pan-up" | "pan-down";
const KB_EFFECTS: KBEffect[] = ["zoom-in", "zoom-out", "pan-right", "pan-left", "pan-up", "pan-down"];

function pickEffect(prev?: KBEffect): KBEffect {
  const pool = prev ? KB_EFFECTS.filter(e => e !== prev) : KB_EFFECTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Ken Burns using scale+crop with FFmpeg `t` (timestamp) expressions.
 * Works reliably on both still images and video — unlike zoompan which
 * was designed for stills only and fails silently on video inputs.
 *
 * @param maxZoom  max zoom factor: 1.3 for still images, 1.15 for Veo clips
 */
function buildKB(effect: KBEffect, dur: number, width: number, height: number, maxZoom = 1.3): string {
  const d = dur.toFixed(3);
  const zm = maxZoom.toFixed(3);
  const inc = (maxZoom - 1).toFixed(3);
  const panW = Math.round(width * maxZoom / 2) * 2;
  const panH = Math.round(height * maxZoom / 2) * 2;
  switch (effect) {
    case "zoom-in":
      // Scale grows 1.0× → maxZoom× over the clip; crop holds center W×H
      return `scale='${width}*(1+${inc}*min(t,${d})/${d})':'${height}*(1+${inc}*min(t,${d})/${d})':flags=lanczos,` +
             `crop=${width}:${height}:'(iw-ow)/2':'(ih-oh)/2'`;
    case "zoom-out":
      // Scale shrinks maxZoom× → 1.0×
      return `scale='${width}*(${zm}-${inc}*min(t,${d})/${d})':'${height}*(${zm}-${inc}*min(t,${d})/${d})':flags=lanczos,` +
             `crop=${width}:${height}:'(iw-ow)/2':'(ih-oh)/2'`;
    case "pan-right":
      return `scale=${panW}:${panH}:flags=lanczos,` +
             `crop=${width}:${height}:'min((iw-ow)*min(t,${d})/${d},iw-ow)':'(ih-oh)/2'`;
    case "pan-left":
      return `scale=${panW}:${panH}:flags=lanczos,` +
             `crop=${width}:${height}:'max((iw-ow)*(1-min(t,${d})/${d}),0)':'(ih-oh)/2'`;
    case "pan-up":
      return `scale=${panW}:${panH}:flags=lanczos,` +
             `crop=${width}:${height}:'(iw-ow)/2':'max((ih-oh)*(1-min(t,${d})/${d}),0)'`;
    case "pan-down":
      return `scale=${panW}:${panH}:flags=lanczos,` +
             `crop=${width}:${height}:'(iw-ow)/2':'min((ih-oh)*min(t,${d})/${d},ih-oh)'`;
  }
}

const RESOLUTIONS: Record<string, [number, number]> = {
  "480p": [854, 480],
  "720p": [1280, 720],
};

// ── In-memory job stores ───────────────────────────────────────────────────
type ClipJob = {
  status: "generating" | "done" | "failed";
  progress: number; // 0–100
  done: number;
  total: number;
  resolution: string;
  error?: string;
};

type MergeJob = {
  status: "rendering" | "done" | "failed";
  progress: number; // 0–100
  total: number;
  resolution: string;
  error?: string;
};

const clipJobs: Record<string, ClipJob> = {};
const mergeJobs: Record<string, MergeJob> = {};

type AnimateJob = {
  status: "animating" | "done" | "failed";
  progress: number;
  done: number;
  total: number;
  error?: string;
  sceneErrors: Record<number, string>; // scene_number → error message
};
const animateJobs: Record<string, AnimateJob> = {};

// ── FFmpeg helpers ─────────────────────────────────────────────────────────

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", d => (stderr += d.toString()));
    proc.on("close", code =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-800)}`))
    );
  });
}

function getAudioDuration(file: string): number {
  try {
    const val = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`
    ).toString().trim();
    return Math.max(parseFloat(val) || 3, 0.5);
  } catch { return 3; }
}

function findImageFile(projectId: string, sceneNumber: number, dbFile?: string | null): string | null {
  const imgDir = path.join("uploads", projectId, "images");
  const candidates = [
    dbFile ? path.join(imgDir, dbFile) : null,
    path.join(imgDir, `${sceneNumber}.png`),
    path.join(imgDir, `${sceneNumber}.jpg`),
    path.join(imgDir, `${sceneNumber}.jpeg`),
    path.join(imgDir, `${sceneNumber}.svg`),
  ].filter(Boolean) as string[];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

function hasAudioStream(file: string): boolean {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams a -show_entries stream=codec_type -of default=noprint_wrappers=1 "${file}"`
    ).toString().trim();
    return out.length > 0;
  } catch { return false; }
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/render/:id/clips
 * Phase 1: generate individual MP4 clips (1.mp4, 2.mp4, …) into uploads/{id}/clips/
 * Each clip duration = audio duration, Ken Burns effect applied.
 */
router.post("/:id/clips", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  try {
    try { execSync("ffmpeg -version", { stdio: "ignore" }); }
    catch { return res.status(500).json({ error: "FFmpeg not installed. Run: apt-get install -y ffmpeg" }); }

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const allScenes = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .orderBy(scenes.scene_number);

    const ready = allScenes.filter(s => s.image_status === "completed" && s.audio_status === "completed");
    if (ready.length === 0)
      return res.status(400).json({ error: "No scenes ready — need completed image AND audio for each scene." });

    const resKey = req.body?.resolution === "480p" ? "480p" : "720p";
    const [W, H] = RESOLUTIONS[resKey];

    clipJobs[projectId] = { status: "generating", progress: 0, done: 0, total: ready.length, resolution: resKey };
    res.json({ success: true, total: ready.length, resolution: resKey });

    generateClips(projectId, ready, W, H).catch(e => {
      console.error(`[clips] ${projectId} failed:`, e.message);
      clipJobs[projectId] = { ...clipJobs[projectId], status: "failed", error: e.message };
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/render/:id/clips/status */
router.get("/:id/clips/status", (req: Request, res: Response) => {
  const job = clipJobs[req.params.id];
  if (job) return res.json(job);
  // Check if clips dir already has files (e.g. after server restart)
  const clipsDir = path.join("uploads", req.params.id, "clips");
  if (fs.existsSync(clipsDir)) {
    const clips = fs.readdirSync(clipsDir).filter(f => f.endsWith(".mp4"));
    if (clips.length > 0) {
      return res.json({ status: "done", progress: 100, done: clips.length, total: clips.length, resolution: "unknown" });
    }
  }
  res.json({ status: "idle" });
});

/**
 * GET /api/render/:id/clips/zip
 * Download all individual clips as a ZIP file.
 */
router.get("/:id/clips/zip", (req: Request, res: Response) => {
  const clipsDir = path.join("uploads", req.params.id, "clips");
  if (!fs.existsSync(clipsDir)) {
    return res.status(404).json({ error: "No clips found. Generate clips first." });
  }
  const clipFiles = fs.readdirSync(clipsDir)
    .filter(f => f.endsWith(".mp4"))
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (clipFiles.length === 0) {
    return res.status(404).json({ error: "No clips found. Generate clips first." });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="clips.zip"`);

  const archive = archiver("zip", { zlib: { level: 0 } }); // level 0 = store only (MP4s already compressed)
  archive.on("error", err => { console.error("[zip] error:", err); res.destroy(); });
  archive.pipe(res);
  for (const f of clipFiles) {
    archive.file(path.join(clipsDir, f), { name: f });
  }
  archive.finalize();
});

/**
 * POST /api/render/:id/animate
 * Animate selected scenes using Whisk/Veo. Body: { scenes: number[] }
 * Header: x-whisk-cookie
 */
router.post("/:id/animate", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const cookie = req.headers["x-whisk-cookie"] as string;
  if (!cookie) return res.status(400).json({ error: "Whisk cookie required (x-whisk-cookie header)" });

  const sceneNums = (req.body?.scenes as number[]) || [];
  if (sceneNums.length === 0) return res.status(400).json({ error: "No scenes provided" });

  const allScenes = await db.select().from(scenes).where(eq(scenes.project_id, projectId)).orderBy(scenes.scene_number);
  const toAnimate = allScenes.filter(s => sceneNums.includes(s.scene_number) && s.image_status === "completed");
  if (toAnimate.length === 0) return res.status(400).json({ error: "No scenes with completed images to animate" });

  animateJobs[projectId] = { status: "animating", progress: 0, done: 0, total: toAnimate.length, sceneErrors: {} };
  res.json({ success: true, total: toAnimate.length });

  animateScenes(projectId, sceneNums, allScenes, cookie).catch(e => {
    animateJobs[projectId] = { ...animateJobs[projectId], status: "failed", error: e.message };
  });
});

/** GET /api/render/:id/animate/status */
router.get("/:id/animate/status", (req: Request, res: Response) => {
  const videosDir = path.join("uploads", req.params.id, "videos");
  const getAnimatedNums = (): number[] => {
    if (!fs.existsSync(videosDir)) return [];
    return fs.readdirSync(videosDir)
      .filter(f => f.endsWith(".mp4"))
      .map(f => parseInt(f))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);
  };

  const job = animateJobs[req.params.id];
  if (job) {
    const animatedSceneNums = getAnimatedNums();
    return res.json({ ...job, animatedSceneNums });
  }
  const animatedSceneNums = getAnimatedNums();
  if (animatedSceneNums.length > 0) {
    return res.json({ status: "done", progress: 100, done: animatedSceneNums.length, total: animatedSceneNums.length, sceneErrors: {}, animatedSceneNums });
  }
  res.json({ status: "idle", done: 0, total: 0, sceneErrors: {}, animatedSceneNums: [] });
});

/**
 * GET /api/render/:id/animate/zip
 * Download animated scenes as ZIP. Prefers final clips (with audio), falls back to raw Veo.
 */
router.get("/:id/animate/zip", (req: Request, res: Response) => {
  const projectId = req.params.id;
  const videosDir = path.join("uploads", projectId, "videos");
  const clipsDir = path.join("uploads", projectId, "clips");

  if (!fs.existsSync(videosDir)) return res.status(404).json({ error: "No animated scenes found." });

  const animatedNums = fs.readdirSync(videosDir)
    .filter(f => f.endsWith(".mp4"))
    .map(f => parseInt(f))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  if (animatedNums.length === 0) return res.status(404).json({ error: "No animated scenes found." });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="animated-scenes.zip"`);

  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.on("error", err => { console.error("[zip] error:", err); res.destroy(); });
  archive.pipe(res);

  for (const num of animatedNums) {
    const clip = path.join(clipsDir, `${num}.mp4`);
    const raw = path.join(videosDir, `${num}.mp4`);
    if (fs.existsSync(clip)) {
      archive.file(clip, { name: `scene_${num}_animated.mp4` });
    } else if (fs.existsSync(raw)) {
      archive.file(raw, { name: `scene_${num}_animated_raw.mp4` });
    }
  }
  archive.finalize();
});

/**
 * POST /api/render/:id
 * Phase 2: merge clips into a single output.mp4 with smooth transitions.
 * Uses pre-generated clips from clips/ dir if available, otherwise generates inline.
 */
router.post("/:id", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  try {
    try { execSync("ffmpeg -version", { stdio: "ignore" }); }
    catch { return res.status(500).json({ error: "FFmpeg not installed. Run: apt-get install -y ffmpeg" }); }

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const allScenes = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .orderBy(scenes.scene_number);

    const ready = allScenes.filter(s => s.image_status === "completed" && s.audio_status === "completed");
    if (ready.length === 0)
      return res.status(400).json({ error: "No scenes are fully ready." });

    const resKey = req.body?.resolution === "480p" ? "480p" : "720p";
    const [W, H] = RESOLUTIONS[resKey];

    mergeJobs[projectId] = { status: "rendering", progress: 0, total: ready.length, resolution: resKey };
    res.json({ success: true, total: ready.length, resolution: resKey });

    mergeVideo(projectId, ready, W, H).catch(e => {
      console.error(`[merge] ${projectId} failed:`, e.message);
      mergeJobs[projectId] = { ...mergeJobs[projectId], status: "failed", error: e.message };
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/render/:id/status */
router.get("/:id/status", (req: Request, res: Response) => {
  const job = mergeJobs[req.params.id];
  if (job) return res.json(job);
  const outPath = path.join("uploads", req.params.id, "render", "output.mp4");
  if (fs.existsSync(outPath)) return res.json({ status: "done", progress: 100, total: 0, resolution: "unknown" });
  res.json({ status: "idle" });
});

/** GET /api/render/:id/download */
router.get("/:id/download", async (req: Request, res: Response) => {
  const outPath = path.join("uploads", req.params.id, "render", "output.mp4");
  if (!fs.existsSync(outPath)) return res.status(404).json({ error: "Render not found. Start a render first." });
  let filename = "video.mp4";
  try {
    const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, req.params.id));
    if (project?.title) {
      const safe = project.title.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 80);
      if (safe) filename = `${safe}.mp4`;
    }
  } catch { /* fall back to video.mp4 */ }
  res.download(outPath, filename);
});

// ── Core functions ─────────────────────────────────────────────────────────

// silenceremove removed — stop_periods=1 terminates the stream on any inter-word pause
const AUDIO_FILTER = `loudnorm=I=-16:LRA=11:TP=-1.5`;

async function buildVeoClip(
  veoPath: string, audioPath: string, dur: number,
  width: number, height: number, outPath: string
): Promise<void> {
  const veoAudio = hasAudioStream(veoPath);
  const FPS = 25;
  const effect = pickEffect();
  // Veo clips: subtle zoom (1.15×) so it doesn't fight the AI motion
  const kbFilter = buildKB(effect, dur, width, height, 1.15);
  // fps=25 first normalises input frame rate so t expressions are consistent
  const vScale = `fps=${FPS},${kbFilter},setsar=1,format=yuv420p`;

  if (veoAudio) {
    await ffmpeg([
      "-y",
      "-stream_loop", "-1", "-i", veoPath,
      "-i", audioPath,
      "-filter_complex",
        `[0:v]${vScale}[v];` +
        `[0:a]volume=0.1[va];[1:a]${AUDIO_FILTER}[na];[va][na]amix=inputs=2:duration=first[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", `${dur}`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      outPath,
    ]);
  } else {
    await ffmpeg([
      "-y",
      "-stream_loop", "-1", "-i", veoPath,
      "-i", audioPath,
      "-filter_complex",
        `[0:v]${vScale}[v];[1:a]${AUDIO_FILTER}[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", `${dur}`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      outPath,
    ]);
  }
}

/**
 * Phase 1: generate one MP4 per scene, named by scene number (1.mp4, 2.mp4, …).
 * Duration = audio duration. Ken Burns effect applied at random (no repeat).
 */
async function generateClips(projectId: string, sceneList: any[], width: number, height: number) {
  const FPS = 25;
  const clipsDir = path.join("uploads", projectId, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });

  let prevEffect: KBEffect | undefined;
  let done = 0;

  for (let i = 0; i < sceneList.length; i++) {
    const s = sceneList[i];
    const num = s.scene_number;

    const img = findImageFile(projectId, num, s.image_file);
    const audioPath = path.join("uploads", projectId, "audio", s.audio_file ?? `${num}.mp3`);

    if (!img || !fs.existsSync(audioPath)) {
      console.warn(`[clips] scene ${num}: missing files, skipping`);
      clipJobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 100);
      continue;
    }

    const dur = parseFloat(getAudioDuration(audioPath).toFixed(3));
    const frames = Math.round(FPS * dur);
    const clipPath = path.join(clipsDir, `${num}.mp4`);
    const veoPath = path.join("uploads", projectId, "videos", `${num}.mp4`);

    if (fs.existsSync(veoPath)) {
      // Use Veo-generated video: loop to fill audio duration, mix narration over
      console.log(`[clips] scene ${num}: using Veo video`);
      await buildVeoClip(veoPath, audioPath, dur, width, height, clipPath);
    } else {
      const effect = pickEffect(prevEffect);
      prevEffect = effect;
      const kbFilter = buildKB(effect, dur, width, height, 1.3);
      await ffmpeg([
        "-y",
        "-loop", "1", "-framerate", `${FPS}`, "-t", `${dur}`, "-i", img,
        "-i", audioPath,
        "-filter_complex",
          `[0:v]${kbFilter},setsar=1,fps=${FPS},format=yuv420p[v];` +
          `[1:a]${AUDIO_FILTER}[a]`,
        "-map", "[v]", "-map", "[a]",
        "-t", `${dur}`,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        clipPath,
      ]);
    }

    done++;
    clipJobs[projectId].done = done;
    clipJobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 100);
    console.log(`[clips] ${projectId}: scene ${num} done (${done}/${sceneList.length})`);
  }

  clipJobs[projectId] = { ...clipJobs[projectId], status: "done", progress: 100 };
  console.log(`[clips] ${projectId}: all clips done → ${clipsDir}`);
}

/**
 * Phase 2: merge clips into output.mp4 with xfade transitions.
 * Reads from clips/ dir if pre-generated; otherwise generates clips inline.
 */
async function mergeVideo(projectId: string, sceneList: any[], width: number, height: number) {
  const FPS = 25;
  const T = 0.1; // transition duration in seconds
  const clipsDir = path.join("uploads", projectId, "clips");
  const renderDir = path.join("uploads", projectId, "render");
  fs.mkdirSync(renderDir, { recursive: true });

  const clips: string[] = [];
  const durations: number[] = [];
  const tempClips: string[] = []; // inline-generated, cleaned up after merge

  // Use pre-generated clips if available
  for (const s of sceneList) {
    const clip = path.join(clipsDir, `${s.scene_number}.mp4`);
    if (fs.existsSync(clip)) {
      clips.push(clip);
      durations.push(getAudioDuration(clip));
    }
  }

  // Fallback: generate clips inline (backward-compat when user skips Phase 1)
  if (clips.length === 0) {
    let prevEffect: KBEffect | undefined;
    for (let i = 0; i < sceneList.length; i++) {
      const s = sceneList[i];
      const num = s.scene_number;
      const img = findImageFile(projectId, num, s.image_file);
      const audioPath = path.join("uploads", projectId, "audio", s.audio_file ?? `${num}.mp3`);
      if (!img || !fs.existsSync(audioPath)) {
        mergeJobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 78);
        continue;
      }
      const dur = parseFloat(getAudioDuration(audioPath).toFixed(3));
      const effect = pickEffect(prevEffect);
      prevEffect = effect;
      const kbFilter = buildKB(effect, dur, width, height, 1.3);
      const clip = path.join(renderDir, `tmp_${i}.mp4`);
      await ffmpeg([
        "-y",
        "-loop", "1", "-framerate", `${FPS}`, "-t", `${dur}`, "-i", img,
        "-i", audioPath,
        "-filter_complex",
          `[0:v]${kbFilter},setsar=1,fps=${FPS},format=yuv420p[v];[1:a]${AUDIO_FILTER}[a]`,
        "-map", "[v]", "-map", "[a]",
        "-t", `${dur}`,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        clip,
      ]);
      clips.push(clip);
      tempClips.push(clip);
      durations.push(getAudioDuration(clip));
      mergeJobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 78);
    }
  }

  if (clips.length === 0) throw new Error("No clips available — check scenes have image and audio.");

  const outPath = path.join(renderDir, "output.mp4");

  if (clips.length === 1) {
    fs.copyFileSync(clips[0], outPath);
  } else {
    const inputs = clips.flatMap(c => ["-i", c]);
    const vFilters: string[] = [];
    let cumD = 0;

    for (let i = 0; i < clips.length - 1; i++) {
      const vIn  = i === 0 ? `${i}:v` : `vtmp${i}`;
      const vOut = i === clips.length - 2 ? "vout" : `vtmp${i + 1}`;

      cumD += durations[i];
      const offset = parseFloat((cumD - (i + 1) * T).toFixed(3));

      vFilters.push(`[${vIn}][${i + 1}:v]xfade=transition=fade:duration=${T}:offset=${offset}[${vOut}]`);
    }

    // Concat audio streams in order — chained acrossfade was causing audio to overlap
    // and drop out. Simple concat is reliable; the tiny T-per-transition gap is inaudible.
    const audioConcatIn = clips.map((_, i) => `[${i}:a]`).join("");
    const audioFilter = `${audioConcatIn}concat=n=${clips.length}:v=0:a=1[aout]`;

    mergeJobs[projectId].progress = 90;

    await ffmpeg([
      "-y",
      ...inputs,
      "-filter_complex", [...vFilters, audioFilter].join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-shortest",
      outPath,
    ]);
  }

  // Clean up only inline temp clips (keep clips/ dir intact)
  tempClips.forEach(c => { try { fs.unlinkSync(c); } catch {} });

  mergeJobs[projectId] = { status: "done", progress: 100, total: sceneList.length, resolution: mergeJobs[projectId].resolution };
  console.log(`[merge] ${projectId}: done → ${outPath}`);
}

async function animateScenes(
  projectId: string,
  sceneNumbers: number[],
  sceneList: any[],
  cookie: string
) {
  const videosDir = path.join("uploads", projectId, "videos");
  fs.mkdirSync(videosDir, { recursive: true });

  let done = 0;
  for (const num of sceneNumbers) {
    const s = sceneList.find((sc: any) => sc.scene_number === num);
    if (!s) continue;
    const img = findImageFile(projectId, num, s.image_file);
    if (!img) {
      console.warn(`[animate] scene ${num}: no image, skipping`);
      continue;
    }
    const videoPath = path.join(videosDir, `${num}.mp4`);
    try {
      const buf = await animateWhiskImage(img, cookie, s.image_prompt || "");
      fs.writeFileSync(videoPath, buf);
      done++;
      animateJobs[projectId].done = done;
      animateJobs[projectId].progress = Math.round((done / sceneNumbers.length) * 100);
      console.log(`[animate] ${projectId}: scene ${num} done (${done}/${sceneNumbers.length})`);
    } catch (e: any) {
      console.error(`[animate] scene ${num} failed:`, e.message);
      animateJobs[projectId].sceneErrors[num] = e.message;
    }
  }
  animateJobs[projectId] = { ...animateJobs[projectId], status: "done", progress: 100 };
}

export default router;
