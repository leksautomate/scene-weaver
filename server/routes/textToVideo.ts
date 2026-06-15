import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import { generateVeoTextClip } from "../lib/veo.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TtvItem {
  index: number;
  prompt: string;
  status: "pending" | "generating" | "completed" | "failed";
  error?: string;
}

interface TtvJob {
  id: string;
  status: "running" | "done" | "stopped";
  aspectRatio: "16:9" | "9:16";
  items: TtvItem[];
  createdAt: string;
  completedAt?: string;
}

// ── Job store ─────────────────────────────────────────────────────────────────

const jobs = new Map<string, TtvJob>();
const JOBS_FILE = path.join(process.cwd(), "uploads", "text_to_video_jobs.json");

function saveJobs(): void {
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    fs.writeFileSync(JOBS_FILE, JSON.stringify(Array.from(jobs.entries()), null, 2));
  } catch (e: any) {
    console.error("[ttv] save jobs failed:", e.message);
  }
}

function loadJobs(): void {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8")) as Array<[string, TtvJob]>;
    let dirty = false;
    for (const [id, job] of data) {
      if (job.status === "running") {
        job.status = "stopped";
        for (const item of job.items) {
          if (item.status === "pending" || item.status === "generating") {
            item.status = "failed";
            item.error = "Interrupted by server restart";
          }
        }
        dirty = true;
      }
      jobs.set(id, job);
    }
    if (dirty) saveJobs();
    console.log(`[ttv] Loaded ${jobs.size} jobs`);
  } catch (e: any) {
    console.error("[ttv] load jobs failed:", e.message);
  }
}

loadJobs();

// ── Semaphore ─────────────────────────────────────────────────────────────────

const MAX_CONCURRENCY = Math.min(parseInt(process.env.TTV_CONCURRENCY || "1", 10), 2);
let activeCount = 0;
const waitQueue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (activeCount < MAX_CONCURRENCY) {
      activeCount++;
      resolve();
    } else {
      waitQueue.push(() => { activeCount++; resolve(); });
    }
  });
}

function releaseSemaphore(): void {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!;
    next();
  } else {
    activeCount--;
  }
}

// ── Job processor ─────────────────────────────────────────────────────────────

function outputDir(jobId: string): string {
  return path.join(process.cwd(), "uploads", "text-to-video", jobId);
}

function itemFilename(index: number): string {
  return String(index).padStart(3, "0") + ".mp4";
}

async function processJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  fs.mkdirSync(outputDir(jobId), { recursive: true });

  for (const item of job.items) {
    if (item.status !== "pending") continue;

    await acquireSemaphore();
    item.status = "generating";
    saveJobs();

    const outPath = path.join(outputDir(jobId), itemFilename(item.index));
    try {
      await generateVeoTextClip(item.prompt, outPath, job.aspectRatio, true);
      item.status = "completed";
    } catch (e: any) {
      item.status = "failed";
      item.error = e.message || "Unknown error";
    } finally {
      releaseSemaphore();
      saveJobs();
    }
  }

  job.status = "done";
  job.completedAt = new Date().toISOString();
  saveJobs();
}

// ── Routes ────────────────────────────────────────────────────────────────────

const router = Router();

// POST / — create job
router.post("/", async (req: Request, res: Response) => {
  const { prompts, aspectRatio } = req.body as { prompts: string[]; aspectRatio: "16:9" | "9:16" };

  if (!Array.isArray(prompts) || prompts.length === 0) {
    res.status(400).json({ error: "prompts must be a non-empty array" });
    return;
  }
  if (prompts.length > 100) {
    res.status(400).json({ error: "Maximum 100 prompts per batch" });
    return;
  }
  if (aspectRatio !== "16:9" && aspectRatio !== "9:16") {
    res.status(400).json({ error: "aspectRatio must be '16:9' or '9:16'" });
    return;
  }

  const id = crypto.randomUUID();
  const job: TtvJob = {
    id,
    status: "running",
    aspectRatio,
    items: prompts.map((prompt, i) => ({
      index: i + 1,
      prompt,
      status: "pending",
    })),
    createdAt: new Date().toISOString(),
  };

  jobs.set(id, job);
  saveJobs();

  processJob(id).catch((e) => {
    console.error(`[ttv] job ${id} unhandled error:`, e.message);
    const j = jobs.get(id);
    if (j && j.status === "running") { j.status = "done"; saveJobs(); }
  });

  res.status(201).json({ id });
});

// GET / — list all jobs, newest first
router.get("/", (_req: Request, res: Response) => {
  const list = Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  res.json(list);
});

// GET /:jobId — poll single job
router.get("/:jobId", (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

// POST /:jobId/retry — retry a single failed item (prompt may be updated)
// Non-async handler: responds immediately, then runs the Veo call in a background IIFE
router.post("/:jobId/retry", (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const { index, prompt } = req.body as { index: number; prompt: string };
  if (typeof index !== "number" || typeof prompt !== "string" || !prompt.trim()) {
    res.status(400).json({ error: "index must be a number and prompt must be a non-empty string" });
    return;
  }
  const item = job.items.find((i) => i.index === index);
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }
  if (item.status === "generating" || item.status === "completed") {
    res.status(409).json({ error: "Item is already completed or generating" });
    return;
  }

  item.prompt = prompt;
  item.status = "generating";  // set synchronously to prevent double-retry race
  delete item.error;
  if (job.status !== "running") job.status = "running";
  saveJobs();

  res.json({ ok: true });

  // Fire-and-forget: client polls for status updates
  const jobId = job.id;
  (async () => {
    fs.mkdirSync(outputDir(jobId), { recursive: true });
    await acquireSemaphore();
    saveJobs();

    const outPath = path.join(outputDir(jobId), itemFilename(item.index));
    try {
      await generateVeoTextClip(item.prompt, outPath, job.aspectRatio, true);
      item.status = "completed";
    } catch (e: any) {
      item.status = "failed";
      item.error = e.message || "Unknown error";
    } finally {
      releaseSemaphore();
      const allTerminal = job.items.every((i) => i.status === "completed" || i.status === "failed");
      if (allTerminal) { job.status = "done"; job.completedAt = new Date().toISOString(); }
      saveJobs();
    }
  })().catch((e) => console.error(`[ttv] retry ${jobId}/${index} error:`, e.message));
});

// GET /:jobId/zip — stream ZIP of completed videos
router.get("/:jobId/zip", (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const completed = job.items.filter((i) => i.status === "completed");
  if (completed.length === 0) { res.status(400).json({ error: "No completed videos" }); return; }

  res.setHeader("Content-Disposition", `attachment; filename="videos-${job.id}.zip"`);
  res.setHeader("Content-Type", "application/zip");

  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.on("error", (err) => {
    console.error("[ttv] archive error:", err);
    res.destroy();
  });
  archive.pipe(res);

  for (const item of completed) {
    const filePath = path.join(outputDir(job.id), itemFilename(item.index));
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: itemFilename(item.index) });
    }
  }

  archive.finalize();
});

// DELETE /:jobId — remove job record and all files
router.delete("/:jobId", (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (job.status === "running") {
    res.status(409).json({ error: "Cannot delete a running job" });
    return;
  }

  try { fs.rmSync(outputDir(job.id), { recursive: true, force: true }); } catch {}
  jobs.delete(job.id);
  saveJobs();
  res.json({ ok: true });
});

export default router;
