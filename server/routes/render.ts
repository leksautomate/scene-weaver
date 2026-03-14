import express, { Request, Response } from "express";
import { db } from "../db.js";
import { projects, scenes } from "../../shared/schema.js";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import archiver from "archiver";

const router = express.Router();

// ── Ken Burns effect types ─────────────────────────────────────────────────
type KBEffect = "zoom-in" | "zoom-out" | "pan-right" | "pan-left" | "pan-up" | "pan-down";
const KB_EFFECTS: KBEffect[] = ["zoom-in", "zoom-out", "pan-right", "pan-left", "pan-up", "pan-down"];

function pickEffect(prev?: KBEffect): KBEffect {
  const pool = prev ? KB_EFFECTS.filter(e => e !== prev) : KB_EFFECTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildZoompan(effect: KBEffect, frames: number, width: number, height: number): string {
  const PAN_FRAC = 0.23077;
  const spd_h = (PAN_FRAC / frames).toFixed(6);
  const spd_v = (PAN_FRAC / frames).toFixed(6);
  const size = `${width}x${height}`;
  switch (effect) {
    case "zoom-in": {
      const inc = (0.5 / frames).toFixed(6);
      return `scale=8000:-1,zoompan=z='min(pzoom+${inc},1.5)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}`;
    }
    case "zoom-out": {
      const dec = (0.5 / frames).toFixed(6);
      return `scale=8000:-1,zoompan=z='if(eq(on,1),1.5,max(pzoom-${dec},1.0))':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}`;
    }
    case "pan-right":
      return `scale=8000:-1,zoompan=z=1.3:d=${frames}:x='min(px+iw*${spd_h},iw*(1-1/zoom))':y='ih/2-(ih/zoom/2)':s=${size}`;
    case "pan-left":
      return `scale=8000:-1,zoompan=z=1.3:d=${frames}:x='if(eq(on,1),iw*(1-1/zoom),max(px-iw*${spd_h},0))':y='ih/2-(ih/zoom/2)':s=${size}`;
    case "pan-up":
      return `scale=8000:-1,zoompan=z=1.3:d=${frames}:x='iw/2-(iw/zoom/2)':y='if(eq(on,1),ih*(1-1/zoom),max(py-ih*${spd_v},0))':s=${size}`;
    case "pan-down":
      return `scale=8000:-1,zoompan=z=1.3:d=${frames}:x='iw/2-(iw/zoom/2)':y='min(py+ih*${spd_v},ih*(1-1/zoom))':s=${size}`;
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
router.get("/:id/download", (req: Request, res: Response) => {
  const outPath = path.join("uploads", req.params.id, "render", "output.mp4");
  if (!fs.existsSync(outPath)) return res.status(404).json({ error: "Render not found. Start a render first." });
  res.download(outPath, "video.mp4");
});

// ── Core functions ─────────────────────────────────────────────────────────

const AUDIO_FILTER =
  `silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:stop_periods=1:stop_silence=0.05:stop_threshold=-50dB,` +
  `loudnorm=I=-16:LRA=11:TP=-1.5`;

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
    const effect = pickEffect(prevEffect);
    prevEffect = effect;

    const zp = buildZoompan(effect, frames, width, height);
    const clipPath = path.join(clipsDir, `${num}.mp4`);

    await ffmpeg([
      "-y",
      "-loop", "1", "-framerate", `${FPS}`, "-i", img,
      "-i", audioPath,
      "-filter_complex",
        `[0:v]${zp},fps=${FPS},format=yuv420p[v];` +
        `[1:a]${AUDIO_FILTER}[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", `${dur}`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      clipPath,
    ]);

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
      const frames = Math.round(FPS * dur);
      const effect = pickEffect(prevEffect);
      prevEffect = effect;
      const zp = buildZoompan(effect, frames, width, height);
      const clip = path.join(renderDir, `tmp_${i}.mp4`);
      await ffmpeg([
        "-y",
        "-loop", "1", "-framerate", `${FPS}`, "-i", img,
        "-i", audioPath,
        "-filter_complex",
          `[0:v]${zp},fps=${FPS},format=yuv420p[v];[1:a]${AUDIO_FILTER}[a]`,
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
    const aFilters: string[] = [];
    let cumD = 0;

    for (let i = 0; i < clips.length - 1; i++) {
      const vIn  = i === 0 ? `${i}:v` : `vtmp${i}`;
      const vOut = i === clips.length - 2 ? "vout" : `vtmp${i + 1}`;
      const aIn  = i === 0 ? `${i}:a` : `atmp${i}`;
      const aOut = i === clips.length - 2 ? "aout" : `atmp${i + 1}`;

      cumD += durations[i];
      const offset = parseFloat((cumD - (i + 1) * T).toFixed(3));

      vFilters.push(`[${vIn}][${i + 1}:v]xfade=transition=fade:duration=${T}:offset=${offset}[${vOut}]`);
      aFilters.push(`[${aIn}][${i + 1}:a]acrossfade=d=${T}:c1=tri:c2=tri[${aOut}]`);
    }

    mergeJobs[projectId].progress = 90;

    await ffmpeg([
      "-y",
      ...inputs,
      "-filter_complex", [...vFilters, ...aFilters].join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      outPath,
    ]);
  }

  // Clean up only inline temp clips (keep clips/ dir intact)
  tempClips.forEach(c => { try { fs.unlinkSync(c); } catch {} });

  mergeJobs[projectId] = { status: "done", progress: 100, total: sceneList.length, resolution: mergeJobs[projectId].resolution };
  console.log(`[merge] ${projectId}: done → ${outPath}`);
}

export default router;
