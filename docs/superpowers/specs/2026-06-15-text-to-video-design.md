# Text-to-Video Bulk Generator — Design Spec

**Date:** 2026-06-15  
**Feature:** Bulk text-to-video generation using Veo with audio

---

## Overview

A new section of the Historia app that lets users paste multiple text prompts (one per line), generate one Veo video per prompt (with native audio), and download results as a ZIP. Videos are named `001.mp4`, `002.mp4`, etc.

---

## Routes

| Route | Description |
|---|---|
| `/text-to-video` | Dashboard — creation form at top + list of past jobs |
| `/text-to-video/:jobId` | Job detail — video grid, per-video status, retry controls |

A "Text to Video" nav link is added to the existing `AppLayout` sidebar.

---

## Backend

### New route file: `server/routes/textToVideo.ts`

Registered under `/api/text-to-video` in `server/index.ts`. All endpoints require JWT auth (standard `requireAuth` middleware).

#### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/text-to-video` | Create a new job |
| `GET` | `/api/text-to-video` | List all jobs (summary) |
| `GET` | `/api/text-to-video/:jobId` | Poll job + per-item progress |
| `POST` | `/api/text-to-video/:jobId/retry` | Retry a single failed item |
| `GET` | `/api/text-to-video/:jobId/zip` | Download ZIP of completed videos |
| `DELETE` | `/api/text-to-video/:jobId` | Delete job record + all files under `uploads/text-to-video/{jobId}/` |

#### POST `/api/text-to-video` request body
```ts
{
  prompts: string[];       // one per video, no max limit
  aspectRatio: "16:9" | "9:16";
}
```

#### POST `/api/text-to-video/:jobId/retry` request body
```ts
{
  index: number;    // 1-based item index
  prompt: string;   // updated prompt text (may differ from original)
}
```

### Job Data Shape

```ts
interface TtvItem {
  index: number;       // 1-based, determines output filename (001.mp4, etc.)
  prompt: string;      // current prompt text (editable on retry)
  status: "pending" | "generating" | "completed" | "failed";
  error?: string;      // failure reason shown in UI
}

interface TtvJob {
  id: string;          // uuid
  status: "running" | "done" | "failed" | "stopped";
  aspectRatio: "16:9" | "9:16";
  items: TtvItem[];
  createdAt: string;   // ISO timestamp
  completedAt?: string;
}
```

### Persistence

- In-memory map `ttvJobs: Map<string, TtvJob>` + written to `uploads/text_to_video_jobs.json` after every status change.
- On server startup: file is loaded; any `running`/`generating` jobs/items are marked `failed` (they cannot resume mid-generation).
- Completed video files in `uploads/text-to-video/{jobId}/` survive restarts.

### File Storage

```
uploads/text-to-video/
  {jobId}/
    001.mp4
    002.mp4
    ...
```

### Concurrency

- A module-level semaphore limits concurrent Veo calls to `TTV_CONCURRENCY` (env var, default `1`, max `2`).
- The semaphore is shared across all active jobs and retry calls so total in-flight Veo requests never exceeds the limit.

### Veo Integration

A new exported function in `server/lib/veo.ts`:

```ts
export async function generateVeoTextClip(
  prompt: string,
  outPath: string,
  aspectRatio?: string,
  generateAudio?: boolean
): Promise<void>
```

Identical to `generateVeoClip` but omits the `image` field from the request body, making it a pure text-to-video call. Reuses the same `pollVeoOperation` and `downloadGcs` internals.

---

## Frontend

### Dashboard page (`/text-to-video`)

- **Creation panel (top):**
  - `<Textarea>` — "Enter one prompt per line…", auto-grows, live line count shown (e.g. "12 prompts")
  - Aspect ratio `<Select>`: `16:9` (default) / `9:16`
  - "Generate Videos" button → `POST /api/text-to-video` → redirect to `/text-to-video/:jobId`

- **Job list (below form):**
  - One card per past job: created time, aspect ratio, total count, completed/failed counts, overall progress bar
  - Clicking a card navigates to `/text-to-video/:jobId`
  - "Delete" button per card

### Job detail page (`/text-to-video/:jobId`)

- **Header:** breadcrumb back to dashboard, job metadata (ratio, count, time), overall progress bar
- **"Download ZIP" button** — top right, enabled when ≥1 video is completed; hits `GET /api/text-to-video/:jobId/zip`; ZIP contains only completed videos named `001.mp4`, `002.mp4`, etc.
- **Video grid:** one card per prompt item
  - **Completed:** `<video controls>` with `src="/uploads/text-to-video/{jobId}/{padded}.mp4"`, prompt text below
  - **Generating:** spinner + "Generating…" label
  - **Pending:** muted card + "Queued" badge
  - **Failed:** red border, error message text, editable `<Textarea>` with the prompt, "Retry" button → `POST /api/text-to-video/:jobId/retry`
- **Auto-poll:** every 3 seconds while any item is `pending` or `generating`; stops when all items are terminal

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Veo RAI filter block | Item marked `failed`; error: "Blocked by content filter: {reason}" |
| Veo timeout (5 min) | Item marked `failed`; error: "Generation timed out" |
| Veo API error | Item marked `failed`; error surfaced from Veo response |
| Server restart mid-job | All non-completed items marked `failed` on reload |
| ZIP requested with 0 completed | 400 response; button disabled in UI |
| Retry while semaphore full | Request queues behind semaphore; responds only once slot is free |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TTV_CONCURRENCY` | `1` | Max concurrent Veo text-to-video calls (1 or 2) |

---

## Out of Scope

- No per-job audio toggle — audio is always enabled (`generateAudio: true`)
- No scheduling or queued-across-restart resume
- No per-prompt aspect ratio override — ratio is set once per job
