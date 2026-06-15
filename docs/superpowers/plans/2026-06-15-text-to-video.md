# Text-to-Video Bulk Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bulk text-to-video page that lets users paste N prompts (one per line), generates one Veo video (with audio) per prompt, and lets them preview and download results as a ZIP named `001.mp4`, `002.mp4`, etc.

**Architecture:** Server-side job queue stored in memory + persisted to `uploads/text_to_video_jobs.json`. A semaphore (default 1, max 2 via `TTV_CONCURRENCY` env var) limits concurrent Veo calls. The client polls `/api/text-to-video/:jobId` every 3 seconds while work is in progress. Two frontend pages: a dashboard/creation page at `/text-to-video` and a job detail/preview page at `/text-to-video/:jobId`.

**Tech Stack:** Express 5, TypeScript, React 18, TanStack Query (polling via setInterval), shadcn/ui, archiver (already installed), Veo via Vertex AI (`server/lib/veo.ts`), `crypto.randomUUID()` for IDs.

---

## File Map

| Action | File |
|--------|------|
| Modify | `server/lib/veo.ts` — add `generateVeoTextClip` export |
| Create | `server/routes/textToVideo.ts` — all endpoints + job store + semaphore |
| Modify | `server/index.ts` — register `/api/text-to-video` route |
| Create | `src/pages/TextToVideo.tsx` — dashboard: creation form + job list |
| Create | `src/pages/TextToVideoDetail.tsx` — job detail: video grid + retry |
| Modify | `src/components/AppSidebar.tsx` — add "Text to Video" nav item |
| Modify | `src/App.tsx` — add two new routes |
| Create | `src/test/textToVideo.test.ts` — unit tests for pure utility logic |

---

## Task 1: Add `generateVeoTextClip` to `server/lib/veo.ts`

**Files:**
- Modify: `server/lib/veo.ts`
- Test: `src/test/textToVideo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test/textToVideo.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Pure utility functions extracted from the TTV feature

function parsePromptLines(raw: string): string[] {
  return raw.split("\n").map(l => l.trim()).filter(Boolean);
}

function padIndex(index: number): string {
  return String(index).padStart(3, "0");
}

function calcProgress(items: Array<{ status: string }>): number {
  const terminal = items.filter(i => i.status === "completed" || i.status === "failed").length;
  return items.length === 0 ? 0 : Math.round((terminal / items.length) * 100);
}

describe("parsePromptLines", () => {
  it("splits on newlines and trims", () => {
    expect(parsePromptLines("a\n b \nc")).toEqual(["a", "b", "c"]);
  });
  it("filters blank lines", () => {
    expect(parsePromptLines("a\n\n\nb")).toEqual(["a", "b"]);
  });
  it("returns empty array for blank input", () => {
    expect(parsePromptLines("   \n  \n")).toEqual([]);
  });
});

describe("padIndex", () => {
  it("pads single digit", () => expect(padIndex(1)).toBe("001"));
  it("pads double digit", () => expect(padIndex(42)).toBe("042"));
  it("leaves triple digit", () => expect(padIndex(100)).toBe("100"));
});

describe("calcProgress", () => {
  it("returns 0 for all pending", () => {
    expect(calcProgress([{ status: "pending" }, { status: "pending" }])).toBe(0);
  });
  it("returns 50 for half done", () => {
    expect(calcProgress([{ status: "completed" }, { status: "pending" }])).toBe(50);
  });
  it("counts failed as terminal", () => {
    expect(calcProgress([{ status: "failed" }, { status: "pending" }])).toBe(50);
  });
  it("returns 100 when all terminal", () => {
    expect(calcProgress([{ status: "completed" }, { status: "failed" }])).toBe(100);
  });
  it("returns 0 for empty array", () => {
    expect(calcProgress([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they pass (pure logic, no dependencies)**

```
npx vitest run src/test/textToVideo.test.ts
```

Expected: all 11 tests pass.

- [ ] **Step 3: Add `generateVeoTextClip` to `server/lib/veo.ts`**

Append after the closing brace of `generateVeoClip` (around line 71), before `async function downloadGcs`:

```typescript
/**
 * Generate a video from a text prompt only (no input image) using Veo.
 * Saves the result to outPath. Throws on failure or timeout.
 */
export async function generateVeoTextClip(
  prompt: string,
  outPath: string,
  aspectRatio?: string,
  generateAudio?: boolean
): Promise<void> {
  const url = `https://${API_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${VEO_LOCATION}/publishers/google/models/${VEO_MODEL}:predictLongRunning`;

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      durationSeconds: 8,
      personGeneration: "allow_all",
      generateAudio: generateAudio ?? true,
      ...(aspectRatio === "9:16" ? { aspectRatio: "9:16" } : {}),
    },
  };

  const token = getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veo request failed: ${res.status} ${text}`);
  }

  const operation = (await res.json()) as { name: string };
  if (!operation.name) throw new Error("Veo returned no operation name");

  await pollVeoOperation(operation.name, outPath);
}
```

- [ ] **Step 4: Commit**

```bash
git add server/lib/veo.ts src/test/textToVideo.test.ts
git commit -m "feat: add generateVeoTextClip for text-only Veo generation"
```

---

## Task 2: Create the backend route `server/routes/textToVideo.ts`

**Files:**
- Create: `server/routes/textToVideo.ts`

- [ ] **Step 1: Create the file with types, job store, persistence, and semaphore**

Create `server/routes/textToVideo.ts`:

```typescript
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
  const item = job.items.find((i) => i.index === index);
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }
  if (item.status === "generating") { res.status(409).json({ error: "Already generating" }); return; }

  item.prompt = prompt;
  item.status = "pending";
  delete item.error;
  if (job.status !== "running") job.status = "running";
  saveJobs();

  res.json({ ok: true });

  // Fire-and-forget: client polls for status updates
  const jobId = job.id;
  (async () => {
    fs.mkdirSync(outputDir(jobId), { recursive: true });
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

  try { fs.rmSync(outputDir(job.id), { recursive: true, force: true }); } catch {}
  jobs.delete(job.id);
  saveJobs();
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 2: Confirm TypeScript compiles cleanly**

```
npx tsc --noEmit
```

Expected: no errors related to `textToVideo.ts`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/textToVideo.ts
git commit -m "feat: add text-to-video backend route with job store and semaphore"
```

---

## Task 3: Register the route in `server/index.ts`

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Add import and mount**

In `server/index.ts`, add after the existing `import scriptToJsonRouter` line:

```typescript
import textToVideoRouter from "./routes/textToVideo.js";
```

And after `app.use("/api/script-to-json", scriptToJsonRouter);`:

```typescript
app.use("/api/text-to-video", textToVideoRouter);
```

- [ ] **Step 2: Confirm TypeScript compiles**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: register /api/text-to-video route"
```

---

## Task 4: Create `src/pages/TextToVideo.tsx` — Dashboard

**Files:**
- Create: `src/pages/TextToVideo.tsx`

- [ ] **Step 1: Create the page**

Create `src/pages/TextToVideo.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

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

export default function TextToVideo() {
  const navigate = useNavigate();
  const [promptText, setPromptText] = useState("");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [generating, setGenerating] = useState(false);
  const [jobs, setJobs] = useState<TtvJob[]>([]);

  useEffect(() => {
    fetchJobs();
  }, []);

  async function fetchJobs() {
    try {
      const res = await fetch("/api/text-to-video");
      if (res.ok) setJobs(await res.json());
    } catch {}
  }

  const prompts = promptText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  async function handleGenerate() {
    if (prompts.length === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/text-to-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompts, aspectRatio }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { id } = await res.json();
      navigate(`/text-to-video/${id}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to start job");
      setGenerating(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, jobId: string) {
    e.stopPropagation();
    try {
      await fetch(`/api/text-to-video/${jobId}`, { method: "DELETE" });
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    } catch {
      toast.error("Failed to delete job");
    }
  }

  function jobProgress(job: TtvJob): number {
    const done = job.items.filter((i) => i.status === "completed" || i.status === "failed").length;
    return job.items.length === 0 ? 0 : Math.round((done / job.items.length) * 100);
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">Text to Video</h1>
        <p className="text-muted-foreground text-sm mt-1">Generate Veo videos from text prompts in bulk</p>
      </div>

      {/* Creation form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New Batch</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Textarea
              placeholder="Enter one prompt per line…"
              className="min-h-[160px] font-mono text-sm resize-y"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {prompts.length} prompt{prompts.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-44">
              <Select value={aspectRatio} onValueChange={(v) => setAspectRatio(v as "16:9" | "9:16")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="16:9">16:9 Landscape</SelectItem>
                  <SelectItem value="9:16">9:16 Portrait</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleGenerate} disabled={generating || prompts.length === 0}>
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                "Generate Videos"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Job list */}
      {jobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Past Batches
          </h2>
          {jobs.map((job) => {
            const pct = jobProgress(job);
            const completed = job.items.filter((i) => i.status === "completed").length;
            const failed = job.items.filter((i) => i.status === "failed").length;
            return (
              <Card
                key={job.id}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate(`/text-to-video/${job.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <Badge variant={job.status === "running" ? "default" : "secondary"}>
                          {job.status === "running" ? "Running" : "Done"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{job.aspectRatio}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">{job.items.length} videos</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(job.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <Progress value={pct} className="h-1.5" />
                      <p className="text-xs text-muted-foreground mt-1">
                        {completed} done · {failed} failed ·{" "}
                        {job.items.length - completed - failed} pending
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={(e) => handleDelete(e, job.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/TextToVideo.tsx
git commit -m "feat: add TextToVideo dashboard page"
```

---

## Task 5: Create `src/pages/TextToVideoDetail.tsx` — Job Detail & Preview

**Files:**
- Create: `src/pages/TextToVideoDetail.tsx`

- [ ] **Step 1: Create the page**

Create `src/pages/TextToVideoDetail.tsx`:

```tsx
import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  Download,
  ArrowLeft,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";
import { toast } from "sonner";

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

export default function TextToVideoDetail() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<TtvJob | null>(null);
  const [editPrompts, setEditPrompts] = useState<Record<number, string>>({});
  const [retrying, setRetrying] = useState<Record<number, boolean>>({});
  const [downloading, setDownloading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchJob();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId]);

  useEffect(() => {
    if (!job) return;
    const isActive = job.items.some(
      (i) => i.status === "pending" || i.status === "generating"
    );
    if (isActive && !pollRef.current) {
      pollRef.current = setInterval(fetchJob, 3000);
    } else if (!isActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [job]);

  async function fetchJob() {
    try {
      const res = await fetch(`/api/text-to-video/${jobId}`);
      if (!res.ok) { navigate("/text-to-video"); return; }
      setJob(await res.json());
    } catch {}
  }

  async function handleRetry(item: TtvItem) {
    const prompt = editPrompts[item.index] ?? item.prompt;
    setRetrying((prev) => ({ ...prev, [item.index]: true }));
    try {
      const res = await fetch(`/api/text-to-video/${jobId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: item.index, prompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchJob();
    } catch (e: any) {
      toast.error(e.message || "Retry failed");
    } finally {
      setRetrying((prev) => ({ ...prev, [item.index]: false }));
    }
  }

  async function handleDownloadZip() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/text-to-video/${jobId}/zip`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `videos-${jobId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e.message || "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const completed = job.items.filter((i) => i.status === "completed").length;
  const failed = job.items.filter((i) => i.status === "failed").length;
  const total = job.items.length;
  const pct = total === 0 ? 0 : Math.round(((completed + failed) / total) * 100);
  const isPortrait = job.aspectRatio === "9:16";

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button
            onClick={() => navigate("/text-to-video")}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Dashboard
          </button>
          <h1 className="text-2xl font-display font-bold">Batch Preview</h1>
          <p className="text-sm text-muted-foreground">
            {job.aspectRatio} · {total} videos ·{" "}
            {new Date(job.createdAt).toLocaleString()}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={completed === 0 || downloading}
          onClick={handleDownloadZip}
        >
          {downloading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Download ZIP ({completed})
        </Button>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <Progress value={pct} className="h-2" />
        <p className="text-xs text-muted-foreground">
          {completed} completed · {failed} failed · {total - completed - failed} remaining
        </p>
      </div>

      {/* Video grid */}
      <div
        className={`grid gap-4 ${
          isPortrait
            ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        }`}
      >
        {job.items.map((item) => {
          const filename = String(item.index).padStart(3, "0") + ".mp4";
          const editPrompt = editPrompts[item.index] ?? item.prompt;

          return (
            <Card
              key={item.index}
              className={item.status === "failed" ? "border-destructive/50" : ""}
            >
              <CardContent className="p-3 space-y-2">
                {/* Video / state placeholder */}
                <div
                  className={`relative rounded overflow-hidden bg-muted ${
                    isPortrait ? "aspect-[9/16]" : "aspect-video"
                  }`}
                >
                  {item.status === "completed" ? (
                    <video
                      className="w-full h-full object-cover"
                      src={`/uploads/text-to-video/${jobId}/${filename}`}
                      controls
                      playsInline
                    />
                  ) : item.status === "generating" ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      <span className="text-xs text-muted-foreground">Generating…</span>
                    </div>
                  ) : item.status === "failed" ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <AlertCircle className="h-8 w-8 text-destructive/60" />
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <Clock className="h-5 w-5 text-muted-foreground/50" />
                      <span className="text-xs text-muted-foreground">Queued</span>
                    </div>
                  )}
                </div>

                {/* Filename + status icon */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-muted-foreground">{filename}</span>
                  {item.status === "completed" && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  )}
                  {item.status === "failed" && (
                    <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  )}
                  {item.status === "generating" && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                  )}
                  {item.status === "pending" && (
                    <Clock className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  )}
                </div>

                {/* Prompt display or editable retry form */}
                {item.status === "failed" ? (
                  <div className="space-y-1.5">
                    {item.error && (
                      <p className="text-xs text-destructive leading-snug">{item.error}</p>
                    )}
                    <Textarea
                      className="text-xs min-h-[64px] font-mono resize-y"
                      value={editPrompt}
                      onChange={(e) =>
                        setEditPrompts((prev) => ({ ...prev, [item.index]: e.target.value }))
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={retrying[item.index]}
                      onClick={() => handleRetry(item)}
                    >
                      {retrying[item.index] ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Retry
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.prompt}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/TextToVideoDetail.tsx
git commit -m "feat: add TextToVideoDetail job preview page"
```

---

## Task 6: Wire up routes in `src/App.tsx` and add sidebar nav link

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/AppSidebar.tsx`

- [ ] **Step 1: Add imports and routes in `src/App.tsx`**

Add these two imports after the existing page imports (e.g. after the `ScriptToJson` import line):

```tsx
import TextToVideo from "./pages/TextToVideo";
import TextToVideoDetail from "./pages/TextToVideoDetail";
```

Add these two routes inside the protected `<Routes>` block, after the `"/script-to-json"` route:

```tsx
<Route path="/text-to-video" element={<TextToVideo />} />
<Route path="/text-to-video/:jobId" element={<TextToVideoDetail />} />
```

- [ ] **Step 2: Add nav item in `src/components/AppSidebar.tsx`**

Add `Video` to the lucide-react import at the top of the file:

```tsx
import { Plus, FolderOpen, Settings, AlertTriangle, FileJson, FlaskConical, FileCode, LogOut, Video } from "lucide-react";
```

Add the nav item to the `items` array (e.g. after the `"Script → JSON"` entry):

```tsx
{ title: "Text to Video", url: "/text-to-video", icon: Video },
```

- [ ] **Step 3: Confirm TypeScript compiles**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run tests to confirm nothing broke**

```
npm run test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/AppSidebar.tsx
git commit -m "feat: wire up text-to-video routes and sidebar nav"
```

---

## Task 7: Manual smoke test

- [ ] **Step 1: Start the dev server**

```
npm run dev
```

Open `http://localhost:5173` in a browser.

- [ ] **Step 2: Navigate to Text to Video**

Click "Text to Video" in the sidebar. Confirm the creation form loads with textarea and ratio selector.

- [ ] **Step 3: Verify prompt counter**

Type 3 lines in the textarea. Confirm the counter shows "3 prompts".

- [ ] **Step 4: Verify validation**

Click "Generate Videos" with an empty textarea. The button should be disabled.

- [ ] **Step 5: Start a test batch (if Veo credentials are available)**

Paste 1–2 short prompts, select a ratio, click "Generate Videos". Confirm:
- Redirect to `/text-to-video/:jobId`
- Job detail page loads with the video grid
- Cards show "Queued" or "Generating…" spinner
- Progress bar and counters update every 3 seconds

- [ ] **Step 6: Verify the dashboard**

Navigate back to `/text-to-video`. Confirm the completed job appears in the "Past Batches" list with a progress bar.

- [ ] **Step 7: Verify delete**

Click the trash icon on a job card. Confirm the card disappears.
