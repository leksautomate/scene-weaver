import express, { Request, Response } from "express";
import { db } from "../db.js";
import { projects, scenes } from "../../shared/schema.js";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";

const router = express.Router();

// ── Ken Burns effect types ─────────────────────────────────────────────────
type KBEffect = "zoom-in" | "zoom-out" | "pan-right" | "pan-left" | "pan-up" | "pan-down";
const KB_EFFECTS: KBEffect[] = ["zoom-in", "zoom-out", "pan-right", "pan-left", "pan-up", "pan-down"];

function pickEffect(prev?: KBEffect): KBEffect {
  const pool = prev ? KB_EFFECTS.filter(e => e !== prev) : KB_EFFECTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Build the zoompan filter string for a given effect, duration and output size.
 * Input is first upscaled so panning/zooming has plenty of pixel data,
 * then zoompan crops+scales to the requested resolution.
 */
function buildZoompan(effect: KBEffect, frames: number, width: number, height: number): string {
  const PAN_FRAC = 0.23077; // (1 - 1/1.3) — fraction of input pannable at z=1.3
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

// ── In-memory job store ────────────────────────────────────────────────────
type RenderJob = {
  status: "rendering" | "done" | "failed";
  progress: number; // 0–100
  total: number;
  resolution: string;
  error?: string;
};
const jobs: Record<string, RenderJob> = {};

// ── Routes ─────────────────────────────────────────────────────────────────

/** POST /api/render/:id — kick off a render */
router.post("/:id", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  try {
    try { execSync("ffmpeg -version", { stdio: "ignore" }); }
    catch { return res.status(500).json({ error: "FFmpeg is not installed. SSH into your VPS and run: apt-get install -y ffmpeg" }); }

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const allScenes = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .orderBy(scenes.scene_number);

    const ready = allScenes.filter(s => s.image_status === "completed" && s.audio_status === "completed");
    if (ready.length === 0)
      return res.status(400).json({ error: "No scenes are fully ready (need completed image AND audio for each scene)." });

    const resKey = req.body?.resolution === "480p" ? "480p" : "720p";
    const [W, H] = RESOLUTIONS[resKey];

    jobs[projectId] = { status: "rendering", progress: 0, total: ready.length, resolution: resKey };
    res.json({ success: true, total: ready.length, resolution: resKey });

    renderVideo(projectId, ready, W, H).catch(e => {
      console.error(`[render] ${projectId} failed:`, e.message);
      jobs[projectId] = { ...jobs[projectId], status: "failed", error: e.message };
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/render/:id/status */
router.get("/:id/status", (req: Request, res: Response) => {
  const job = jobs[req.params.id];
  if (job) return res.json(job);
  // If server restarted but output exists, report done
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

// ── Core render function ───────────────────────────────────────────────────

async function renderVideo(projectId: string, sceneList: any[], width: number, height: number) {
  const FPS = 25;
  const T = 0.5;  // transition duration in seconds
  const dir = path.join("uploads", projectId, "render");
  fs.mkdirSync(dir, { recursive: true });

  const clips: string[] = [];
  const durations: number[] = [];
  let prevEffect: KBEffect | undefined;

  // ── Phase 1: generate per-scene clips ────────────────────────────────────
  for (let i = 0; i < sceneList.length; i++) {
    const s = sceneList[i];
    const num = s.scene_number;

    const img = findImageFile(projectId, num, s.image_file);
    const audioPath = path.join("uploads", projectId, "audio", s.audio_file ?? `${num}.mp3`);

    if (!img || !fs.existsSync(audioPath)) {
      console.warn(`[render] scene ${num}: missing files, skipping`);
      jobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 78);
      continue;
    }

    const rawDur = getAudioDuration(audioPath);
    const dur = parseFloat(rawDur.toFixed(3));
    const frames = Math.round(FPS * dur);
    const effect = pickEffect(prevEffect);
    prevEffect = effect;

    const zp = buildZoompan(effect, frames, width, height);
    const clip = path.join(dir, `clip_${i}.mp4`);

    /**
     * Audio processing per clip:
     *  1. silenceremove – strips leading/trailing silence from TTS output
     *  2. loudnorm – normalises loudness to -16 LUFS (consistent volume)
     *  3. 44100 Hz stereo AAC – consistent format for concat
     */
    const audioFilter =
      `silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:stop_periods=1:stop_silence=0.05:stop_threshold=-50dB,` +
      `loudnorm=I=-16:LRA=11:TP=-1.5`;

    await ffmpeg([
      "-y",
      "-loop", "1", "-framerate", `${FPS}`, "-i", img,
      "-i", audioPath,
      "-filter_complex",
        `[0:v]${zp},fps=${FPS},format=yuv420p[v];` +
        `[1:a]${audioFilter}[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", `${dur}`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      clip,
    ]);

    clips.push(clip);
    durations.push(getAudioDuration(clip)); // re-probe after audio processing (silence removal may have changed duration)
    jobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 78);
  }

  if (clips.length === 0) throw new Error("No clips generated — all scenes had missing files.");

  const outPath = path.join(dir, "output.mp4");

  if (clips.length === 1) {
    fs.copyFileSync(clips[0], outPath);
  } else {
    // ── Phase 2: chain xfade (video) + acrossfade (audio) transitions ──────
    const inputs: string[] = clips.flatMap(c => ["-i", c]);
    const vFilters: string[] = [];
    const aFilters: string[] = [];
    let cumD = 0;

    for (let i = 0; i < clips.length - 1; i++) {
      const vIn  = i === 0 ? `${i}:v`  : `vtmp${i}`;
      const vOut = i === clips.length - 2 ? "vout"  : `vtmp${i + 1}`;
      const aIn  = i === 0 ? `${i}:a`  : `atmp${i}`;
      const aOut = i === clips.length - 2 ? "aout"  : `atmp${i + 1}`;

      cumD += durations[i];
      // offset: when in the combined stream the transition should START
      const offset = parseFloat((cumD - (i + 1) * T).toFixed(3));

      vFilters.push(`[${vIn}][${i + 1}:v]xfade=transition=fade:duration=${T}:offset=${offset}[${vOut}]`);
      // acrossfade creates a smooth audio cross-dissolve between adjacent scenes
      aFilters.push(`[${aIn}][${i + 1}:a]acrossfade=d=${T}:c1=tri:c2=tri[${aOut}]`);
    }

    jobs[projectId].progress = 90;

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

  // Cleanup temp clips
  clips.forEach(c => { try { fs.unlinkSync(c); } catch {} });

  jobs[projectId] = { status: "done", progress: 100, total: sceneList.length };
  console.log(`[render] ${projectId}: done → ${outPath}`);
}

export default router;
