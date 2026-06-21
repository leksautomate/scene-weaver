import express, { Request, Response } from "express";
import { db } from "../db.js";
import { projects, scenes, renderJobs } from "../../shared/schema.js";
import { eq, and, desc } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import archiver from "archiver";
import { generateVeoClip } from "../lib/veo.js";
import { scanBgMusicTracks, BG_MUSIC_DIR } from "../lib/bgMusic.js";

const router = express.Router();

async function upsertJobStatus(
  projectId: string,
  type: "clip" | "merge" | "animate" | "auto",
  status: "running" | "done" | "failed",
  opts: { resolution?: string; total?: number; error?: string | null } = {}
): Promise<void> {
  try {
    await db.insert(renderJobs).values({
      project_id: projectId,
      type,
      status,
      resolution: opts.resolution ?? null,
      total: opts.total ?? null,
      error: opts.error ?? null,
      updated_at: new Date(),
    }).onConflictDoUpdate({
      target: [renderJobs.project_id, renderJobs.type],
      set: {
        status,
        resolution: opts.resolution ?? null,
        total: opts.total ?? null,
        error: opts.error ?? null,
        updated_at: new Date(),
      },
    });
  } catch (e) {
    console.error(`[render-jobs] upsert failed for ${projectId}/${type}:`, e);
  }
}

// ── Ken Burns effect types ─────────────────────────────────────────────────
type KBEffect = "zoom-in" | "zoom-out" | "pan-right" | "pan-left" | "pan-up" | "pan-down";
const KB_EFFECTS: KBEffect[] = ["zoom-in", "zoom-out", "pan-right", "pan-left", "pan-up", "pan-down"];

function pickEffect(prev?: KBEffect): KBEffect {
  const pool = prev ? KB_EFFECTS.filter(e => e !== prev) : KB_EFFECTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

const KB_TO_API: Record<KBEffect, string> = {
  "zoom-in":   "zoom_in",
  "zoom-out":  "zoom_out",
  "pan-right": "pan_right",
  "pan-left":  "pan_left",
  "pan-up":    "pan_zoom",
  "pan-down":  "pan_zoom",
};

/**
 * Ken Burns using fixed scale + per-frame crop with `t` expressions.
 *
 * `scale` evaluates w/h only at init (no `t` support) — so we pre-scale
 * to a fixed larger size, then use `crop` (which re-evaluates per frame
 * and fully supports `t`) to produce the zoom/pan motion, then post-scale
 * zoom clips back to the target resolution.
 *
 * @param maxZoom  zoom factor: 1.3 for stills, 1.15 for Veo clips
 */
function buildKB(effect: KBEffect, dur: number, width: number, height: number, maxZoom = 1.3): string {
  const d = dur.toFixed(3);
  // Pre-scaled dimensions — must be even for libx264
  const pW = Math.round(width * maxZoom / 2) * 2;
  const pH = Math.round(height * maxZoom / 2) * 2;
  const dx = pW - width;   // extra horizontal pixels
  const dy = pH - height;  // extra vertical pixels
  switch (effect) {
    case "zoom-in":
      return `scale=${pW}:${pH}:flags=lanczos,` +
             `crop=${pW}-${dx}*min(t\\,${d})/${d}:${pH}-${dy}*min(t\\,${d})/${d}:(iw-out_w)/2:(ih-out_h)/2,` +
             `scale=${width}:${height}:flags=lanczos`;
    case "zoom-out":
      return `scale=${pW}:${pH}:flags=lanczos,` +
             `crop=${width}+${dx}*min(t\\,${d})/${d}:${height}+${dy}*min(t\\,${d})/${d}:(iw-out_w)/2:(ih-out_h)/2,` +
             `scale=${width}:${height}:flags=lanczos`;
    case "pan-right":
      return `scale=${pW}:${pH}:flags=lanczos,` +
             `crop=${width}:${height}:min(${dx}*min(t\\,${d})/${d}\\,${dx}):${dy / 2}`;
    case "pan-left":
      return `scale=${pW}:${pH}:flags=lanczos,` +
             `crop=${width}:${height}:max(${dx}*(1-min(t\\,${d})/${d})\\,0):${dy / 2}`;
    case "pan-up":
      return `scale=${pW}:${pH}:flags=lanczos,` +
             `crop=${width}:${height}:${dx / 2}:max(${dy}*(1-min(t\\,${d})/${d})\\,0)`;
    case "pan-down":
      return `scale=${pW}:${pH}:flags=lanczos,` +
             `crop=${width}:${height}:${dx / 2}:min(${dy}*min(t\\,${d})/${d}\\,${dy})`;
  }
}

const RESOLUTIONS: Record<string, [number, number]> = {
  "480p":  [854,  480],
  "720p":  [1280, 720],
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
};

function resolveOutputSize(resKey: string, aspectRatio: string): [number, number] {
  const [baseW, baseH] = RESOLUTIONS[resKey] ?? [1280, 720];
  if (aspectRatio === "1:1") {
    const side = Math.round(baseH / 2) * 2;
    return [side, side];
  }
  if (aspectRatio === "9:16") {
    const w = Math.round(baseH * 9 / 16 / 2) * 2;
    return [w, baseH];
  }
  return [baseW, baseH];
}

const CONCURRENCY = Math.max(1, parseInt(process.env.CLIP_CONCURRENCY ?? "3", 10));

// ── In-memory job stores ───────────────────────────────────────────────────
type AutoJob = {
  status: "waiting_assets" | "animating" | "generating_clips" | "merging" | "done" | "failed";
  resolution: string;
  error?: string;
};
const autoJobs: Record<string, AutoJob> = {};

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

function findFontFile(preferredFont?: string): string | null {
  const fontsDir = path.join(process.cwd(), "fonts");

  // Scan bundled fonts/ directory first
  if (fs.existsSync(fontsDir)) {
    const files = fs.readdirSync(fontsDir).filter(f => /\.(ttf|otf|woff)$/i.test(f));
    if (preferredFont) {
      const match = files.find(f =>
        f.replace(/\.(ttf|otf|woff)$/i, "").toLowerCase() === preferredFont.toLowerCase()
      );
      if (match) return path.join(fontsDir, match);
    }
    // Default: first bundled font (Tox Typewriter)
    if (files.length > 0) return path.join(fontsDir, files[0]);
  }

  // Legacy path for Tox Typewriter specifically
  const bundled = path.join(process.cwd(), "fonts", "Tox Typewriter.ttf");
  if (fs.existsSync(bundled)) return bundled;

  const windowsPaths = [
    "C:/Windows/Fonts/courbd.ttf",
    "C:/Windows/Fonts/cour.ttf",
    "C:/Windows/Fonts/consolab.ttf",
    "C:/Windows/Fonts/lucon.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ];
  const linuxPaths = [
    // truetype subdirs (Debian/Ubuntu with fonts-liberation or fonts-dejavu)
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/freefont/FreeMonoBold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Courier_New_Bold.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Courier_New.ttf",
    // flat dirs (some distros / Docker images)
    "/usr/share/fonts/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/dejavu-sans-mono/DejaVuSansMono-Bold.ttf",
    // Alpine / musl
    "/usr/share/fonts/ttf-dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/ttf-liberation/LiberationMono-Bold.ttf",
  ];

  const paths = process.platform === "win32" ? windowsPaths : linuxPaths;
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  // Cross-platform fallback — check both lists
  for (const p of [...windowsPaths, ...linuxPaths]) {
    if (fs.existsSync(p)) return p;
  }

  // Last resort on Linux: ask fontconfig — try preferred font first, then monospace fallbacks
  if (process.platform !== "win32") {
    const fcQueries = preferredFont
      ? [preferredFont, ":spacing=mono", "monospace", ""]
      : [":spacing=mono", "monospace", ""];
    for (const query of fcQueries) {
      try {
        const result = execSync(`fc-match --format="%{file}" ${query}`, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (result && fs.existsSync(result)) return result;
      } catch { /* fc-match not available or no fonts */ }
    }
  }

  console.warn("[render] No font file found — overlay text will not be burned into the video. Install fonts-liberation or fonts-dejavu on the server.");
  return null;
}

function escapeFFmpegPath(filePath: string): string {
  let p = filePath.replace(/\\/g, "/");
  p = p.replace(/:/g, "\\:");
  p = p.replace(/'/g, "'\\\\''");
  return p;
}

function escapeDrawtextText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n");
}

function getOverlayX(position: string, width: number): string {
  const marginX = Math.round(width * 0.04);
  if (position.includes("center") && !position.includes("left") && !position.includes("right")) {
    return `x=(w-tw)/2`;
  }
  if (position.includes("right")) {
    return `x=w-tw-${marginX}`;
  }
  return `x=${marginX}`; // default left
}

function getOverlayYForWrappedItems(
  position: string,
  height: number,
  itemLineCounts: number[],
  itemIdx: number,
  fontSize: number
): number {
  const lineSpacing = fontSize * 1.4;
  const totalLines = itemLineCounts.reduce((a, b) => a + b, 0);
  const precedingLines = itemLineCounts.slice(0, itemIdx).reduce((a, b) => a + b, 0);

  if (position.includes("top")) {
    const startY = Math.round(height * 0.08);
    return Math.round(startY + precedingLines * lineSpacing);
  }
  if (position.includes("center")) {
    const blockHeight = totalLines * lineSpacing;
    const startY = (height - blockHeight) / 2;
    return Math.round(startY + precedingLines * lineSpacing);
  }
  // default bottom
  const blockHeight = totalLines * lineSpacing;
  const startY = height - blockHeight - Math.round(height * 0.12);
  return Math.round(startY + precedingLines * lineSpacing);
}

interface OverlayItem {
  text: string;
  trigger?: string;
}

function parseOverlayText(overlayText: string): OverlayItem[] {
  const trimmed = overlayText.trim();
  if (!trimmed) return [];

  // Try parsing as JSON array
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(item => {
          if (typeof item === "string") {
            return { text: item };
          }
          if (item && typeof item === "object") {
            return {
              text: String(item.text || ""),
              trigger: item.trigger !== undefined ? String(item.trigger) : undefined
            };
          }
          return { text: "" };
        }).filter(item => item.text.trim().length > 0);
      }
    } catch {
      // If parsing fails, fall back to treating it as plain text
    }
  }

  // Treat as plain text
  return [{ text: trimmed }];
}

function buildTypewriterFilter(
  overlayText: string,
  fontFile: string | null,
  fontSize: number,
  dVal: number,
  position: string,
  width: number,
  height: number,
  audioPath: string,
  dur: number
): { drawtextFilter: string; sfxFilterComplex: string; sfxOutputLabels: string[] } {
  const items = parseOverlayText(overlayText);
  if (items.length === 0) {
    return { drawtextFilter: "", sfxFilterComplex: "", sfxOutputLabels: [] };
  }

  // 1. Load alignment JSON
  let wordsList: { word: string; start: number }[] = [];
  const jsonPath = audioPath.replace(/\.mp3$/i, ".json");
  if (fs.existsSync(jsonPath)) {
    try {
      const alignmentData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const wa = alignmentData?.wordAlignment || alignmentData;
      if (Array.isArray(wa)) {
        wordsList = wa.map((item: any) => {
          let startSec = 0;
          if (item.startOffset !== undefined) {
            if (typeof item.startOffset === "string") {
              startSec = parseFloat(item.startOffset.replace("s", ""));
            } else {
              startSec = item.startOffset;
              if (startSec > 100) startSec = startSec / 1000;
            }
          } else if (item.startTime !== undefined) {
            if (typeof item.startTime === "string") {
              startSec = parseFloat(item.startTime.replace("s", ""));
            } else {
              startSec = item.startTime;
              if (startSec > 100) startSec = startSec / 1000;
            }
          }
          return { word: item.word || "", start: startSec };
        });
      } else if (wa && typeof wa === "object") {
        const words = wa.words || [];
        const starts = wa.wordStartTimeSeconds || wa.wordStartTimes || [];
        wordsList = words.map((w: string, idx: number) => {
          let startSec = starts[idx] || 0;
          if (typeof startSec === "string") {
            startSec = parseFloat(startSec.replace("s", ""));
          } else if (startSec > 100) {
            startSec = startSec / 1000;
          }
          return { word: w, start: startSec };
        });
      }
    } catch (e) {
      console.error(`[typewriter] Failed to parse alignment JSON at ${jsonPath}:`, e);
    }
  }

  const cleanWord = (w: string) => w.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").trim();

  // Helper to match a trigger
  function findTriggerTime(trigger: string | undefined, defaultTime: number): number {
    if (!trigger) return defaultTime;
    const target = cleanWord(trigger);
    if (!target) return defaultTime;
    for (const item of wordsList) {
      if (cleanWord(item.word) === target || cleanWord(item.word).includes(target) || target.includes(cleanWord(item.word))) {
        return item.start;
      }
    }
    return defaultTime;
  }

  const fontOpt = fontFile ? `fontfile='${escapeFFmpegPath(fontFile)}':` : "";
  const xy = getOverlayX(position, width);

  const wrappedItems = items.map(item => wordWrap(item.text.trim().toUpperCase()));
  const itemLineCounts = wrappedItems.map(text => text.split("\n").length);

  let drawtextFilter = "";
  const sfxParts: string[] = [];
  const sfxOutputLabels: string[] = [];

  // For asplit of [2:a]
  sfxParts.push(`[2:a]asplit=${items.length}${items.map((_, idx) => `[sfx_in_${idx}]`).join("")}`);

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const wrappedText = wrappedItems[idx];
    const triggerTime = findTriggerTime(item.trigger, dVal + idx * 1.5);
    const charDelaySec = Math.max(0.030, Math.min(0.080, 1.4 / wrappedText.length));

    // Compute coordinate starting y for this item block
    const lineY = getOverlayYForWrappedItems(position, height, itemLineCounts, idx, fontSize);

    // Render characters
    for (let charIdx = 0; charIdx < wrappedText.length; charIdx++) {
      const charStart = (triggerTime + charIdx * charDelaySec).toFixed(3);
      const charEnd = charIdx < wrappedText.length - 1
        ? (triggerTime + (charIdx + 1) * charDelaySec).toFixed(3)
        : (dur).toFixed(3); // Keep visible until the end of the clip duration

      // Extract slice of text up to charIdx + 1
      const partialRaw = wrappedText.slice(0, charIdx + 1);
      
      // Escape for drawtext text parameter
      const escapedText = escapeDrawtextText(partialRaw);

      drawtextFilter += `,drawtext=${fontOpt}text='${escapedText}':fontcolor=white:fontsize=${fontSize}:shadowcolor=black@0.9:shadowx=3:shadowy=3:${xy}:y=${lineY}:enable='between(t,${charStart},${charEnd})'`;
    }

    // Typewriter SFX audio stream trim and delay
    const typingDuration = wrappedText.length * charDelaySec;
    const startMs = Math.round(triggerTime * 1000);
    sfxParts.push(`[sfx_in_${idx}]atrim=end=${typingDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.4,adelay=${startMs}|${startMs}[sfx_del_${idx}]`);
    sfxOutputLabels.push(`[sfx_del_${idx}]`);
  }

  return {
    drawtextFilter,
    sfxFilterComplex: sfxParts.join(";"),
    sfxOutputLabels
  };
}

function wordWrap(text: string, maxLen = 50): string {
  return text.split("\n").map(paragraph => {
    const words = paragraph.split(" ");
    const lines: string[] = [];
    let currentLine = "";

    for (const word of words) {
      if ((currentLine + (currentLine ? " " : "") + word).length > maxLen) {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine += (currentLine ? " " : "") + word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.join("\n");
  }).join("\n");
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", d => (stderr += d.toString()));
    proc.on("close", (code, signal) => {
      if (code === 0) return resolve();
      if (code === null) {
        // Killed by OS signal — most likely OOM on the render server
        return reject(new Error(`FFmpeg killed by signal ${signal ?? "SIGKILL"} (out of memory or timeout): ${stderr.slice(-400)}`));
      }
      reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
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
    dbFile && !dbFile.endsWith(".svg") ? path.join(imgDir, dbFile) : null,
    path.join(imgDir, `${sceneNumber}.png`),
    path.join(imgDir, `${sceneNumber}.jpg`),
    path.join(imgDir, `${sceneNumber}.jpeg`),
    // .svg are mock placeholders — never use for rendering
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

function isValidVideoClip(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const stats = fs.statSync(file);
    if (stats.size === 0) return false;
    execSync(`ffprobe -v error "${file}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

/** GET /api/render/failures — all failed render jobs, for the ErrorLog page */
router.get("/failures", async (req: Request, res: Response) => {
  try {
    const failed = await db
      .select({
        id: renderJobs.id,
        project_id: renderJobs.project_id,
        project_title: projects.title,
        type: renderJobs.type,
        error: renderJobs.error,
        updated_at: renderJobs.updated_at,
        resolution: renderJobs.resolution,
      })
      .from(renderJobs)
      .innerJoin(projects, eq(renderJobs.project_id, projects.id))
      .where(eq(renderJobs.status, "failed"))
      .orderBy(desc(renderJobs.updated_at));
    res.json(failed);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/render/bgmusic/tracks — list available background-music files */
router.get("/bgmusic/tracks", (_req: Request, res: Response) => {
  const files = scanBgMusicTracks(BG_MUSIC_DIR).map(p => path.basename(p));
  res.json({ count: files.length, files });
});

/**
 * POST /api/render/:id/clips
 * Phase 1: generate individual MP4 clips (1.mp4, 2.mp4, …) into uploads/{id}/clips/
 * Each clip duration = audio duration, Ken Burns effect applied.
 */
router.post("/:id/clips", async (req: Request, res: Response) => {
  const projectId = (req.params.id as string);
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

    const resKey = RESOLUTIONS[req.body?.resolution] ? req.body.resolution : "720p";
    const projectAR: string = (project.settings as any)?.aspectRatio || "16:9";
    const [W, H] = resolveOutputSize(resKey, projectAR);
        const subtitleDelay = req.body?.subtitleDelay !== undefined ? parseFloat(req.body.subtitleDelay) : 0.8;
    const overlayPosition = req.body?.overlayPosition || "bottom-left";
    const overlayFont = req.body?.overlayFont || "Tox Typewriter";
    const overlayFontSize = req.body?.overlayFontSize !== undefined ? parseInt(req.body.overlayFontSize, 10) : 36;
    const veoAudioVolume = req.body?.veoAudioVolume !== undefined ? parseFloat(req.body.veoAudioVolume) : 0.03;

    clipJobs[projectId] = { status: "generating", progress: 0, done: 0, total: ready.length, resolution: resKey };
    await upsertJobStatus(projectId, "clip", "running", { resolution: resKey, total: ready.length });
    res.json({ success: true, total: ready.length, resolution: resKey });

    generateClips(projectId, ready, W, H, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, veoAudioVolume).catch(e => {
      console.error(`[clips] ${projectId} failed:`, e.message);
      clipJobs[projectId] = { ...clipJobs[projectId], status: "failed", error: e.message };
      upsertJobStatus(projectId, "clip", "failed", { error: e.message });
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/render/:id/clips/status */
router.get("/:id/clips/status", async (req: Request, res: Response) => {
  const projectId = req.params.id as string;

  // 1. In-memory job (authoritative during active run)
  const job = clipJobs[projectId];
  if (job) return res.json(job);

  // 2. DB row (survives restarts)
  try {
    const [dbJob] = await db.select().from(renderJobs)
      .where(and(eq(renderJobs.project_id, projectId), eq(renderJobs.type, "clip")));
    if (dbJob) {
      if (dbJob.status === "running") {
        await upsertJobStatus(projectId, "clip", "failed", { error: "Server restarted mid-job — please re-run" });
        return res.json({ status: "failed", error: "Server restarted mid-job — please re-run" });
      }
      if (dbJob.status === "done") {
        return res.json({ status: "done", progress: 100, done: dbJob.total ?? 0, total: dbJob.total ?? 0, resolution: dbJob.resolution ?? "unknown" });
      }
      if (dbJob.status === "failed") {
        return res.json({ status: "failed", error: dbJob.error ?? "Unknown error" });
      }
    }
  } catch { /* fall through to filesystem */ }

  // 3. Filesystem fallback
  const clipsDir = path.join("uploads", projectId, "clips");
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
router.get("/:id/clips/zip", async (req: Request, res: Response) => {
  const projectId = (req.params.id as string);
  const clipsDir = path.join("uploads", projectId, "clips");
  if (!fs.existsSync(clipsDir)) {
    return res.status(404).json({ error: "No clips found. Generate clips first." });
  }
  const clipFiles = fs.readdirSync(clipsDir)
    .filter(f => f.endsWith(".mp4"))
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (clipFiles.length === 0) {
    return res.status(404).json({ error: "No clips found. Generate clips first." });
  }

  let zipName = "clips.zip";
  try {
    const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectId));
    if (project?.title) {
      const safe = project.title.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 80);
      if (safe) zipName = `${safe}.zip`;
    }
  } catch { /* fall back to clips.zip */ }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

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
 * Animate selected scenes. Body: { scenes: number[] }
 */
router.post("/:id/animate", async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  const sceneNumbers: number[] = req.body?.scenes || [];

  try {
    const allScenes = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .orderBy(scenes.scene_number);

    const toAnimate = sceneNumbers.length > 0
      ? allScenes.filter(s => sceneNumbers.includes(s.scene_number) && s.image_status === "completed")
      : allScenes.filter(s => s.image_status === "completed");

    if (toAnimate.length === 0) {
      return res.status(400).json({ error: "No scenes with completed images to animate" });
    }

    animateJobs[projectId] = {
      status: "animating",
      progress: 0,
      done: 0,
      total: toAnimate.length,
      sceneErrors: {},
    };
    await upsertJobStatus(projectId, "animate", "running", { total: toAnimate.length });
    res.json({ success: true, total: toAnimate.length });

    const [veoProject] = await db.select().from(projects).where(eq(projects.id, projectId));
    const veoAR: string = (veoProject?.settings as any)?.aspectRatio || "16:9";
    const animateVeoAudioVolume = req.body?.veoAudioVolume !== undefined ? parseFloat(req.body.veoAudioVolume) : 0.03;
    runVeoAnimation(projectId, toAnimate, veoAR, animateVeoAudioVolume > 0).catch(e => {
      console.error(`[veo] ${projectId} failed:`, e.message);
      if (animateJobs[projectId]) {
        animateJobs[projectId] = { ...animateJobs[projectId], status: "failed", error: e.message };
      }
      upsertJobStatus(projectId, "animate", "failed", { error: e.message });
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/render/:id/animate/status */
router.get("/:id/animate/status", async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  const videosDir = path.join("uploads", projectId, "videos");

  const getAnimatedNums = (): number[] => {
    if (!fs.existsSync(videosDir)) return [];
    return fs.readdirSync(videosDir)
      .filter(f => f.endsWith(".mp4"))
      .map(f => parseInt(f))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);
  };

  const job = animateJobs[projectId];
  if (job) {
    const animatedSceneNums = getAnimatedNums();
    return res.json({ ...job, animatedSceneNums });
  }

  // DB fallback — only used for "running" reboot detection
  try {
    const [dbJob] = await db.select().from(renderJobs)
      .where(and(eq(renderJobs.project_id, projectId), eq(renderJobs.type, "animate")));
    if (dbJob?.status === "running") {
      await upsertJobStatus(projectId, "animate", "failed", { error: "Server restarted mid-job — please re-run" });
      return res.json({ status: "failed", error: "Server restarted mid-job — please re-run", done: 0, total: 0, sceneErrors: {}, animatedSceneNums: [] });
    }
  } catch { /* fall through */ }

  // Filesystem fallback
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
  const projectId = (req.params.id as string);
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
 * POST /api/render/:id/auto
 * Full background pipeline: wait for assets → generate clips → merge.
 * Returns immediately; runs entirely server-side.
 * Body: { resolution? }
 */
router.post("/:id/auto", async (req: Request, res: Response) => {
  const projectId = (req.params.id as string);
  const resKey = RESOLUTIONS[req.body?.resolution] ? req.body.resolution : "720p";
    const subtitleDelay = req.body?.subtitleDelay !== undefined ? parseFloat(req.body.subtitleDelay) : 0.8;
  const overlayPosition = req.body?.overlayPosition || "bottom-left";
  const overlayFont = req.body?.overlayFont || "Tox Typewriter";
  const overlayFontSize = req.body?.overlayFontSize !== undefined ? parseInt(req.body.overlayFontSize, 10) : 36;
  const autoVeoAudioVolume = req.body?.veoAudioVolume !== undefined ? parseFloat(req.body.veoAudioVolume) : 0.1;
  const [autoProject] = await db.select().from(projects).where(eq(projects.id, projectId));
  const autoProjectAR: string = (autoProject?.settings as any)?.aspectRatio || "16:9";
  await upsertJobStatus(projectId, "auto", "running", { resolution: resKey });
  res.json({ success: true, message: "Auto pipeline started in background" });
  runAutoPipeline(projectId, resKey, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, autoProjectAR, autoVeoAudioVolume).catch(e => {
    console.error(`[auto] ${projectId} failed:`, e.message);
    if (autoJobs[projectId]) autoJobs[projectId] = { ...autoJobs[projectId], status: "failed", error: e.message };
    upsertJobStatus(projectId, "auto", "failed", { error: e.message });
  });
});

/** GET /api/render/:id/auto/status */
router.get("/:id/auto/status", async (req: Request, res: Response) => {
  const projectId = req.params.id as string;

  const job = autoJobs[projectId];
  if (job) return res.json(job);

  try {
    const [dbJob] = await db.select().from(renderJobs)
      .where(and(eq(renderJobs.project_id, projectId), eq(renderJobs.type, "auto")));
    if (dbJob) {
      if (dbJob.status === "running") {
        await upsertJobStatus(projectId, "auto", "failed", { error: "Server restarted mid-job — please re-run" });
        return res.json({ status: "failed", error: "Server restarted mid-job — please re-run" });
      }
      if (dbJob.status === "done") return res.json({ status: "done", resolution: dbJob.resolution ?? "unknown" });
      if (dbJob.status === "failed") return res.json({ status: "failed", error: dbJob.error ?? "Unknown error" });
    }
  } catch { /* fall through */ }

  const outPath = path.join("uploads", projectId, "render", "output.mp4");
  if (fs.existsSync(outPath)) return res.json({ status: "done", resolution: "unknown" });
  res.json({ status: "idle" });
});

/**
 * POST /api/render/:id
 * Phase 2: merge clips into a single output.mp4 with smooth transitions.
 * Uses pre-generated clips from clips/ dir if available, otherwise generates inline.
 */
router.post("/:id", async (req: Request, res: Response) => {
  const projectId = (req.params.id as string);
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

    const resKey = RESOLUTIONS[req.body?.resolution] ? req.body.resolution : "720p";
    const projectAR: string = (project.settings as any)?.aspectRatio || "16:9";
    const [W, H] = resolveOutputSize(resKey, projectAR);
        const subtitleDelay = req.body?.subtitleDelay !== undefined ? parseFloat(req.body.subtitleDelay) : 0.8;
    const overlayPosition = req.body?.overlayPosition || "bottom-left";
    const overlayFont = req.body?.overlayFont || "Tox Typewriter";
    const overlayFontSize = req.body?.overlayFontSize !== undefined ? parseInt(req.body.overlayFontSize, 10) : 36;
    const mergeVeoAudioVolume = req.body?.veoAudioVolume !== undefined ? parseFloat(req.body.veoAudioVolume) : 0.1;

    mergeJobs[projectId] = { status: "rendering", progress: 0, total: ready.length, resolution: resKey };
    await upsertJobStatus(projectId, "merge", "running", { resolution: resKey, total: ready.length });
    res.json({ success: true, total: ready.length, resolution: resKey });

    mergeVideo(projectId, ready, W, H, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, mergeVeoAudioVolume).catch(e => {
      console.error(`[merge] ${projectId} failed:`, e.message);
      mergeJobs[projectId] = { ...mergeJobs[projectId], status: "failed", error: e.message };
      upsertJobStatus(projectId, "merge", "failed", { error: e.message });
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/render/:id/status */
router.get("/:id/status", async (req: Request, res: Response) => {
  const projectId = req.params.id as string;

  const job = mergeJobs[projectId];
  if (job) return res.json(job);

  try {
    const [dbJob] = await db.select().from(renderJobs)
      .where(and(eq(renderJobs.project_id, projectId), eq(renderJobs.type, "merge")));
    if (dbJob) {
      if (dbJob.status === "running") {
        await upsertJobStatus(projectId, "merge", "failed", { error: "Server restarted mid-job — please re-run" });
        return res.json({ status: "failed", error: "Server restarted mid-job — please re-run" });
      }
      if (dbJob.status === "done") {
        return res.json({ status: "done", progress: 100, total: dbJob.total ?? 0, resolution: dbJob.resolution ?? "unknown" });
      }
      if (dbJob.status === "failed") {
        return res.json({ status: "failed", error: dbJob.error ?? "Unknown error" });
      }
    }
  } catch { /* fall through to filesystem */ }

  const outPath = path.join("uploads", projectId, "render", "output.mp4");
  if (fs.existsSync(outPath)) return res.json({ status: "done", progress: 100, total: 0, resolution: "unknown" });
  res.json({ status: "idle" });
});

/** GET /api/render/:id/download */
router.get("/:id/download", async (req: Request, res: Response) => {
  const outPath = path.join("uploads", (req.params.id as string), "render", "output.mp4");
  if (!fs.existsSync(outPath)) return res.status(404).json({ error: "Render not found. Start a render first." });
  let filename = "video.mp4";
  try {
    const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, (req.params.id as string)));
    if (project?.title) {
      const safe = project.title.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 80);
      if (safe) filename = `${safe}.mp4`;
    }
  } catch { /* fall back to video.mp4 */ }
  res.download(outPath, filename);
});

/** DELETE /api/render/:id/purge?type=clips|videos|images|audio|render|all */
router.delete("/:id/purge", async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  const type = (req.query.type as string) || "all";

  const base = path.join("uploads", projectId);
  const dirs: Record<string, string> = {
    clips:  path.join(base, "clips"),
    videos: path.join(base, "videos"),
    images: path.join(base, "images"),
    audio:  path.join(base, "audio"),
    render: path.join(base, "render"),
  };

  const targets = type === "all" ? Object.keys(dirs) : [type];
  if (!targets.every(t => t in dirs)) {
    return res.status(400).json({ error: `Invalid type '${type}'. Use: clips, videos, images, audio, render, all` });
  }

  const deleted: string[] = [];
  for (const t of targets) {
    const dir = dirs[t];
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      deleted.push(t);
    }
  }

  // Reset DB status for images/audio so they can be regenerated
  try {
    if (targets.includes("images")) {
      await db.update(scenes)
        .set({ image_status: "pending", image_file: null, image_error: null })
        .where(eq(scenes.project_id, projectId));
    }
    if (targets.includes("audio")) {
      await db.update(scenes)
        .set({ audio_status: "pending", audio_file: null, audio_error: null })
        .where(eq(scenes.project_id, projectId));
    }
  } catch (e: any) {
    console.error("[purge] DB reset error:", e.message);
  }

  res.json({ deleted });
});

// ── Core functions ─────────────────────────────────────────────────────────

// silenceremove removed — stop_periods=1 terminates the stream on any inter-word pause
const AUDIO_FILTER = `loudnorm=I=-16:LRA=11:TP=-1.5`;

async function buildVeoClip(
  veoPath: string, audioPath: string, dur: number,
  width: number, height: number, outPath: string,
  overlayText?: string | null, delay?: number,
  overlayPosition?: string, overlayFont?: string,
  overlayFontSize = 36,
  veoAudioVolume?: number
): Promise<void> {
  const veoDur = getAudioDuration(veoPath);
  const speed  = veoDur / dur; // < 1.0 → Veo shorter than audio

  // If Veo is shorter than audio: loop + slow-motion stretch to fill the duration.
  // If Veo is longer than audio: trim with -t (no extra work needed).
  const shouldSlowDown = speed < 1.0;
  const shouldLoop     = shouldSlowDown; // enable stream loop so we never run out of frames

  const veoInputArgs: string[] = shouldLoop
    ? ["-stream_loop", "-1", "-i", veoPath]
    : ["-i", veoPath];

  const veoAudio = hasAudioStream(veoPath);
  const FPS = 25;
  const fadeOutStart = Math.max(0, dur - 0.5).toFixed(3);
  const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p`;

  const vBase = shouldSlowDown
    ? `setpts=PTS/${speed.toFixed(6)},fps=${FPS},${scaleFilter}`
    : `fps=${FPS},${scaleFilter}`;

  const dVal = delay ?? 0.8;
  const typewriter = overlayText?.trim()
    ? buildTypewriterFilter(overlayText, findFontFile(overlayFont), overlayFontSize, dVal, overlayPosition, width, height, audioPath, dur)
    : null;

  const drawtextFilter = typewriter ? typewriter.drawtextFilter : "";
  const vFilter = `${vBase},fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutStart}:d=0.5${drawtextFilter}`;

  const encArgs = [
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
  ];

  const sfxPath = path.join(process.cwd(), "sfx", "whoosh.MP3");
  const hasSfx = !!(typewriter && typewriter.sfxOutputLabels.length > 0) && fs.existsSync(sfxPath);

  if (veoAudio) {
    const veoVol = (veoAudioVolume ?? 0.03).toFixed(4);
    // atempo range is [0.5, 2.0] per stage — chain stages for extreme slow-down
    const buildAtempo = (s: number): string => {
      const stages: string[] = [];
      let r = s;
      while (r < 0.5) { stages.push("atempo=0.5"); r /= 0.5; }
      stages.push(`atempo=${r.toFixed(4)}`);
      return stages.join(",");
    };
    const veoAudioFilter = shouldSlowDown
      ? `${buildAtempo(speed)},volume=${veoVol}`
      : `volume=${veoVol}`;
    if (hasSfx && typewriter) {
      const aFilter =
        `[0:a]${veoAudioFilter}[va];` +
        `[1:a]${AUDIO_FILTER},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=0.5[na];` +
        `${typewriter.sfxFilterComplex};` +
        `[va][na]${typewriter.sfxOutputLabels.join("")}amix=inputs=${2 + typewriter.sfxOutputLabels.length}:duration=first,afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=0.5[a]`;
      await ffmpeg([
        "-y", ...veoInputArgs, "-i", audioPath, "-i", sfxPath,
        "-filter_complex", `[0:v]${vFilter}[v];${aFilter}`,
        "-map", "[v]", "-map", "[a]", "-t", `${dur}`,
        ...encArgs, outPath,
      ]);
    } else {
      await ffmpeg([
        "-y", ...veoInputArgs, "-i", audioPath,
        "-filter_complex",
          `[0:v]${vFilter}[v];` +
          `[0:a]${veoAudioFilter}[va];[1:a]${AUDIO_FILTER}[na];[va][na]amix=inputs=2:duration=first,afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=0.5[a]`,
        "-map", "[v]", "-map", "[a]", "-t", `${dur}`,
        ...encArgs, outPath,
      ]);
    }
  } else {
    if (hasSfx && typewriter) {
      const aFilter =
        `[1:a]${AUDIO_FILTER},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=0.5[na];` +
        `${typewriter.sfxFilterComplex};` +
        `[na]${typewriter.sfxOutputLabels.join("")}amix=inputs=${1 + typewriter.sfxOutputLabels.length}:duration=first[a]`;
      await ffmpeg([
        "-y", ...veoInputArgs, "-i", audioPath, "-i", sfxPath,
        "-filter_complex", `[0:v]${vFilter}[v];${aFilter}`,
        "-map", "[v]", "-map", "[a]", "-t", `${dur}`,
        ...encArgs, outPath,
      ]);
    } else {
      await ffmpeg([
        "-y", ...veoInputArgs, "-i", audioPath,
        "-filter_complex", `[0:v]${vFilter}[v];[1:a]${AUDIO_FILTER},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=0.5[a]`,
        "-map", "[v]", "-map", "[a]", "-t", `${dur}`,
        ...encArgs, outPath,
      ]);
    }
  }
}

async function buildImageClip(
  imagePath: string, audioPath: string, dur: number,
  width: number, height: number, outPath: string, effect: KBEffect,
  overlayText?: string | null, delay?: number,
  overlayPosition?: string, overlayFont?: string,
  overlayFontSize = 36
): Promise<void> {
  const FPS = 25;
  const kbFilter = buildKB(effect, dur, width, height, 1.3);

  const encArgs = [
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
  ];

  const dVal = delay ?? 0.8;
  const typewriter = overlayText?.trim()
    ? buildTypewriterFilter(overlayText, findFontFile(overlayFont), overlayFontSize, dVal, overlayPosition, width, height, audioPath, dur)
    : null;

  const drawtextFilter = typewriter ? typewriter.drawtextFilter : "";
  const fadeOutStart = Math.max(0, dur - 0.5).toFixed(3);
  const vFilter = `[0:v]${kbFilter},fps=${FPS},setsar=1,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutStart}:d=0.5${drawtextFilter}[v]`;

  const sfxPath = path.join(process.cwd(), "sfx", "whoosh.MP3");
  const hasSfx = !!(typewriter && typewriter.sfxOutputLabels.length > 0) && fs.existsSync(sfxPath);

  if (hasSfx && typewriter) {
    const aFilter =
      `[1:a]${AUDIO_FILTER},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=0.5[na];` +
      `${typewriter.sfxFilterComplex};` +
      `[na]${typewriter.sfxOutputLabels.join("")}amix=inputs=${1 + typewriter.sfxOutputLabels.length}:duration=first[a]`;
    await ffmpeg([
      "-y", "-loop", "1", "-framerate", `${FPS}`, "-i", imagePath, "-i", audioPath, "-i", sfxPath,
      "-filter_complex", `${vFilter};${aFilter}`,
      "-map", "[v]", "-map", "[a]", "-t", `${dur}`,
      ...encArgs, outPath,
    ]);
  } else {
    const aFilter = `[1:a]${AUDIO_FILTER},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart}:d=0.5[a]`;
    await ffmpeg([
      "-y", "-loop", "1", "-framerate", `${FPS}`, "-i", imagePath, "-i", audioPath,
      "-filter_complex", `${vFilter};${aFilter}`,
      "-map", "[v]", "-map", "[a]", "-t", `${dur}`,
      ...encArgs, outPath,
    ]);
  }
}

/**
 * Phase 1: generate one MP4 per scene, named by scene number (1.mp4, 2.mp4, …).
 * Duration = audio duration. Ken Burns effect applied at random (no repeat).
 */
async function generateClips(
  projectId: string,
  sceneList: any[],
  width: number,
  height: number,
  subtitleDelay = 0.8,
  overlayPosition = "bottom-left",
  overlayFont = "Tox Typewriter",
  overlayFontSize = 36,
  veoAudioVolume = 0.03
) {
  const clipsDir = path.join("uploads", projectId, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });

  const total = sceneList.length;
  const counters = { done: 0, processed: 0 };
  let head = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = head++;
      if (idx >= sceneList.length) break;
      const s = sceneList[idx];
      const num = s.scene_number;

      const img = findImageFile(projectId, num, s.image_file);
      const audioPath = path.join("uploads", projectId, "audio", s.audio_file ?? `${num}.mp3`);

      if (!img || !fs.existsSync(audioPath)) {
        console.warn(`[clips] scene ${num}: missing files, skipping`);
      } else {
        const dur = parseFloat(getAudioDuration(audioPath).toFixed(3));
        const clipPath = path.join(clipsDir, `${num}.mp4`);
        const veoPath = path.join("uploads", projectId, "videos", `${num}.mp4`);

        try {
          if (fs.existsSync(veoPath)) {
            console.log(`[clips] scene ${num}: using Veo video`);
            await buildVeoClip(veoPath, audioPath, dur, width, height, clipPath, s.overlay_text, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, veoAudioVolume);
          } else {
            const effect = KB_EFFECTS[idx % KB_EFFECTS.length];
            console.log(`[clips] scene ${num}: generating locally (${effect}, ${dur}s)`);
            await buildImageClip(img, audioPath, dur, width, height, clipPath, effect, s.overlay_text, subtitleDelay, overlayPosition, overlayFont, overlayFontSize);
          }

          if (!isValidVideoClip(clipPath)) {
            throw new Error("Generated clip is invalid or corrupted (e.g. missing moov atom)");
          }

          clipJobs[projectId].done = ++counters.done;
          console.log(`[clips] ${projectId}: scene ${num} done (${counters.done}/${total})`);
        } catch (e: any) {
          console.error(`[clips] scene ${num} failed — skipping:`, e.message);
          try { fs.unlinkSync(clipPath); } catch {}
        }
      }

      clipJobs[projectId].progress = Math.round((++counters.processed / total) * 100);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  clipJobs[projectId] = { ...clipJobs[projectId], status: "done", progress: 100 };
  await upsertJobStatus(projectId, "clip", "done", { total: total });
  console.log(`[clips] ${projectId}: all clips done → ${clipsDir}`);
}

async function runVeoAnimation(projectId: string, sceneList: any[], veoAspectRatio?: string, generateAudio?: boolean): Promise<void> {
  const total = sceneList.length;
  let done = 0;
  let head = 0;
  const VEO_CONCURRENCY = 2;
  const job = animateJobs[projectId];

  async function worker(): Promise<void> {
    while (true) {
      const idx = head++;
      if (idx >= sceneList.length) break;
      const s = sceneList[idx];
      const num = s.scene_number;

      const imgPath = findImageFile(projectId, num, s.image_file);
      if (!imgPath) {
        job.sceneErrors[num] = "Image file not found";
        job.progress = Math.round((++done / total) * 100);
        await db.update(scenes)
          .set({ video_status: "failed", video_error: "Image file not found" })
          .where(eq(scenes.id, s.id));
        continue;
      }

      const outPath = path.join("uploads", projectId, "videos", `${num}.mp4`);

      try {
        await db.update(scenes)
          .set({ video_status: "animating", video_error: null })
          .where(eq(scenes.id, s.id));
        console.log(`[veo] ${projectId}: scene ${num} animating`);
        await generateVeoClip(imgPath, s.motion_prompt || s.image_prompt || "", outPath, veoAspectRatio, generateAudio);

        await db.update(scenes)
          .set({ video_status: "completed", video_error: null })
          .where(eq(scenes.id, s.id));

        const d = ++done;
        job.done = d;
        job.progress = Math.round((d / total) * 100);
        console.log(`[veo] ${projectId}: scene ${num} done (${d}/${total})`);
      } catch (e: any) {
        console.error(`[veo] ${projectId}: scene ${num} failed:`, e.message);
        job.sceneErrors[num] = e.message;
        job.progress = Math.round((++done / total) * 100);

        await db.update(scenes)
          .set({ video_status: "failed", video_error: e.message })
          .where(eq(scenes.id, s.id));
      }
    }
  }

  await Promise.all(Array.from({ length: VEO_CONCURRENCY }, worker));
  job.status = "done";
  job.progress = 100;
  await upsertJobStatus(projectId, "animate", "done", { total: total });
  console.log(`[veo] ${projectId}: animation complete`);
}

/**
 * Build an FFmpeg filter_complex string that chains xfade (video) and
 * acrossfade (audio) dissolves across N pre-encoded clips.
 *
 * Each clip has its own 0.5 s fade-in/out baked in. Using xd=1.0 s means
 * the dissolve starts 1 s before the clip ends — the first 0.5 s is a clean
 * blend, and the last 0.5 s the outgoing clip also fades, producing a gentle
 * cinematic dip that resolves fully into the incoming clip.
 */
function buildXfadeFilter(durations: number[], xd: number): string {
  const n = durations.length;
  const padParts: string[] = [];
  const vParts: string[] = [];
  const aParts: string[] = [];

  // Pad each input stream at the end so they can overlap in transition without overlapping active narration
  for (let i = 0; i < n; i++) {
    padParts.push(`[${i}:v]tpad=stop_mode=clone:stop_duration=${xd.toFixed(3)}[pv${i}]`);
    padParts.push(`[${i}:a]apad=pad_dur=${xd.toFixed(3)}[pa${i}]`);
  }

  // Video: xfade chain — offset-based, using padded video inputs
  let vOffset = 0;
  for (let i = 1; i < n; i++) {
    const inV  = i === 1     ? "[pv0]"  : `[xv${i}]`;
    const outV = i === n - 1 ? "[vout]" : `[xv${i + 1}]`;
    vOffset += durations[i - 1];
    vParts.push(
      `${inV}[pv${i}]xfade=transition=fade:duration=${xd.toFixed(3)}:offset=${Math.max(0, vOffset).toFixed(3)}${outV}`
    );
  }

  // Audio: adelay each padded clip to its absolute start position (sequentially), then amix.
  let audioOffset = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      aParts.push(`[pa0]asetpts=PTS-STARTPTS[ad0]`);
    } else {
      const delayMs = Math.round(audioOffset * 1000);
      aParts.push(`[pa${i}]adelay=${delayMs}|${delayMs}[ad${i}]`);
    }
    if (i < n - 1) audioOffset += durations[i];
  }
  const adInputs = Array.from({ length: n }, (_, i) => `[ad${i}]`).join("");
  aParts.push(`${adInputs}amix=inputs=${n}:duration=longest:normalize=0[aout]`);

  return [...padParts, ...vParts, ...aParts].join(";");
}

/**
 * Phase 2: merge clips into output.mp4 with xfade transitions.
 * Reads from clips/ dir if pre-generated; otherwise generates clips inline.
 */
async function mergeVideo(
  projectId: string,
  sceneList: any[],
  width: number,
  height: number,
  subtitleDelay = 0.8,
  overlayPosition = "bottom-left",
  overlayFont = "Tox Typewriter",
  overlayFontSize = 36,
  veoAudioVolume = 0.03
) {
  const clipsDir = path.join("uploads", projectId, "clips");
  const renderDir = path.join("uploads", projectId, "render");
  fs.mkdirSync(renderDir, { recursive: true });

  const clips: string[] = [];
  const durations: number[] = [];

  let prevEffect: KBEffect | undefined;
  for (let i = 0; i < sceneList.length; i++) {
    const s = sceneList[i];
    const num = s.scene_number;
    const clip = path.join(clipsDir, `${num}.mp4`);
    let isValid = false;

    if (fs.existsSync(clip)) {
      if (isValidVideoClip(clip)) {
        // Re-burn clips that have overlay text so the drawtext is always current.
        // Clips without overlay text are safe to reuse from cache.
        if (s.overlay_text) {
          console.log(`[merge] scene ${num}: has overlay_text, forcing clip regeneration`);
          try { fs.unlinkSync(clip); } catch {}
        } else {
          isValid = true;
        }
      } else {
        console.warn(`[merge] clip ${clip} is corrupted (e.g. missing moov atom). Deleting and regenerating.`);
        try { fs.unlinkSync(clip); } catch {}
      }
    }

    if (!isValid) {
      const img = findImageFile(projectId, num, s.image_file);
      const audioPath = path.join("uploads", projectId, "audio", s.audio_file ?? `${num}.mp3`);
      if (!img || !fs.existsSync(audioPath)) {
        console.warn(`[merge] scene ${num}: missing image or audio, cannot generate clip. Skipping scene.`);
        mergeJobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 78);
        continue;
      }

      const dur = parseFloat(getAudioDuration(audioPath).toFixed(3));
      const veoPath = path.join("uploads", projectId, "videos", `${num}.mp4`);

      try {
        if (fs.existsSync(veoPath)) {
          console.log(`[merge] scene ${num}: regenerating Veo video clip inline`);
          await buildVeoClip(veoPath, audioPath, dur, width, height, clip, s.overlay_text, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, veoAudioVolume);
        } else {
          const effect = pickEffect(prevEffect);
          prevEffect = effect;
          console.log(`[merge] scene ${num}: regenerating Ken Burns clip inline (${effect}, ${dur}s)`);
          await buildImageClip(img, audioPath, dur, width, height, clip, effect, s.overlay_text, subtitleDelay, overlayPosition, overlayFont, overlayFontSize);
        }
        isValid = true;
      } catch (e: any) {
        console.error(`[merge] failed to regenerate clip for scene ${num}:`, e.message);
        mergeJobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 78);
        continue;
      }
    }

    if (isValid) {
      clips.push(clip);
      // Use source audio duration for offset math — avoids container-rounding
      // drift that accumulates when reading duration from encoded MP4 clips.
      const audioSrcPath = path.join("uploads", projectId, "audio", s.audio_file ?? `${s.scene_number}.mp3`);
      durations.push(fs.existsSync(audioSrcPath)
        ? parseFloat(getAudioDuration(audioSrcPath).toFixed(3))
        : getAudioDuration(clip));
    }
    mergeJobs[projectId].progress = Math.round(((i + 1) / sceneList.length) * 78);
  }

  if (clips.length === 0) throw new Error("No clips available — check scenes have image and audio.");

  const outPath = path.join(renderDir, "output.mp4");

  mergeJobs[projectId].progress = 90;

  try {
    if (clips.length === 1) {
      fs.copyFileSync(clips[0], outPath);
    } else {
      const XD = 1.0; // crossfade duration in seconds
      // Use xfade when all clips are long enough; fall back to simple concat for edge cases
      const canXfade = clips.length <= 200 && durations.every(d => d > XD * 2);

      if (canXfade) {
        console.log(`[merge] ${projectId}: xfade dissolve (${clips.length} clips, ${XD}s crossfade)`);
        const filterComplex = buildXfadeFilter(durations, XD);
        const inputs = clips.flatMap(c => ["-i", c]);
        try {
          await ffmpeg([
            "-y", ...inputs,
            "-filter_complex", filterComplex,
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "fast", "-crf", "22",
            "-max_muxing_queue_size", "9999",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
            outPath,
          ]);
        } catch (xfadeErr: any) {
          // xfade killed by OOM — fall back to simple concat
          if (xfadeErr.message?.includes("SIGKILL") || xfadeErr.message?.includes("signal")) {
            console.warn(`[merge] ${projectId}: xfade OOM-killed, retrying with concat fallback`);
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
            // fall through to concat below
          } else {
            throw xfadeErr;
          }
          const listPath = path.join(renderDir, "concat_list.txt");
          const listContent = clips.map(c => `file '${path.resolve(c).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
          fs.writeFileSync(listPath, listContent);
          try {
            await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
          } finally {
            try { fs.unlinkSync(listPath); } catch {}
          }
        }
      } else {
        console.log(`[merge] ${projectId}: simple concat (${clips.length} clips)`);
        const listPath = path.join(renderDir, "concat_list.txt");
        const listContent = clips.map(c => `file '${path.resolve(c).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
        fs.writeFileSync(listPath, listContent);
        try {
          await ffmpeg([
            "-y", "-f", "concat", "-safe", "0", "-i", listPath,
            "-c", "copy", outPath,
          ]);
        } finally {
          try { fs.unlinkSync(listPath); } catch {}
        }
      }
    }
  } catch (e: any) {
    console.error(`[merge] FFmpeg merging failed, deleting corrupt output file:`, e.message);
    try {
      if (fs.existsSync(outPath)) {
        fs.unlinkSync(outPath);
      }
    } catch {}
    throw e;
  }

  // Pre-generated and regenerated clips are stored persistently in clipsDir. No tempClips to clean up.

  mergeJobs[projectId] = { status: "done", progress: 100, total: sceneList.length, resolution: mergeJobs[projectId].resolution };
  await upsertJobStatus(projectId, "merge", "done", { total: sceneList.length });
  console.log(`[merge] ${projectId}: done → ${outPath}`);
}

/**
 * Full auto-pipeline: poll until all assets ready → generate clips → merge.
 * Runs entirely in-process; browser can be closed.
 */
async function runAutoPipeline(
  projectId: string,
  resKey: string,
  subtitleDelay = 0.8,
  overlayPosition = "bottom-left",
  overlayFont = "Tox Typewriter",
  overlayFontSize = 36,
  aspectRatio = "16:9",
  veoAudioVolume = 0.03
) {
  const [W, H] = resolveOutputSize(resKey, aspectRatio);
  autoJobs[projectId] = { status: "waiting_assets", resolution: resKey };
  console.log(`[auto] ${projectId}: waiting for assets (${resKey})`);

  // Poll up to 2 hours for all scenes to finish generating
  const MAX_POLLS = 2400;
  for (let i = 0; i < MAX_POLLS; i++) {
    const allScenes = await db.select().from(scenes)
      .where(eq(scenes.project_id, projectId))
      .orderBy(scenes.scene_number);
    if (allScenes.length > 0) {
      const pending = allScenes.filter(s =>
        s.image_status === "pending" || s.image_status === "generating" ||
        s.audio_status === "pending" || s.audio_status === "generating"
      );
      if (pending.length === 0) break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  const allScenes = await db.select().from(scenes)
    .where(eq(scenes.project_id, projectId))
    .orderBy(scenes.scene_number);
  const ready = allScenes.filter(s => s.image_status === "completed" && s.audio_status === "completed");

  if (ready.length === 0) {
    autoJobs[projectId] = { ...autoJobs[projectId], status: "failed", error: "No scenes ready" };
    return;
  }

  console.log(`[auto] ${projectId}: ${ready.length} scenes ready → generating clips`);
  autoJobs[projectId].status = "generating_clips";
  clipJobs[projectId] = { status: "generating", progress: 0, done: 0, total: ready.length, resolution: resKey };
  await generateClips(projectId, ready, W, H, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, veoAudioVolume);

  console.log(`[auto] ${projectId}: clips done → merging`);
  autoJobs[projectId].status = "merging";
  mergeJobs[projectId] = { status: "rendering", progress: 0, total: ready.length, resolution: resKey };
  await mergeVideo(projectId, ready, W, H, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, veoAudioVolume);

  autoJobs[projectId].status = "done";
  await upsertJobStatus(projectId, "auto", "done");
  console.log(`[auto] ${projectId}: pipeline complete`);
}

export default router;
