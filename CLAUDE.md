# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Build frontend + start Express server (PORT, default 5000)
npm run build        # Vite production build
npm run server       # Start Express server only (no rebuild)
npm run lint         # ESLint
npm run test         # Vitest single run
npm run test:watch   # Vitest watch mode
npx vitest run src/test/specific.test.ts   # Run a single test file
npx vitest run -t "test name pattern"      # Run tests matching a name
npm run db:push      # Sync Drizzle schema to PostgreSQL
npm run deploy       # git push origin main
```

## Architecture

Historia is a cinematic historical documentary generator: script → AI scene splitting → image generation → TTS narration → video clips. It's a full-stack React + Express app with PostgreSQL.

### Frontend (React 18 + Vite, `src/`)
- **Routing**: React Router v6. Routes defined in `App.tsx`.
- **State**: TanStack Query v5 for server data; localStorage (via helpers in `src/lib/providers.ts`) for API keys and user settings.
- **Global state**: `src/lib/GenerationContext` wraps the entire app to track active pipeline state.
- **Auth state**: `src/lib/AuthContext` exposes `{ isAuthenticated, loading, refreshStatus }` — checks `/api/auth/status` on mount.
- **Pages** in `src/pages/`: Setup → Login → Index → Projects → ProjectStatus → ProjectPreview → Settings → ErrorLog → JsonToVideo → ScriptToJson → ImageModelTest (`/image-test`) → OverlayTest
- **Core logic** lives in two files:
  - `src/lib/api.ts` — pipeline orchestration, all API calls, progressive batching, polling, bulk operations
  - `src/lib/providers.ts` — AI integrations (Groq, Gemini, Inworld TTS), script splitting, settings management

### Backend (Express 5, `server/`)
- Entry: `server/index.ts` — starts on `PORT` (default 5000), serves static `dist/` + SPA fallback. **Requires `JWT_SECRET` in env — throws on startup if missing.**
- Routes: `server/routes/` — `projects.ts`, `assets.ts`, `regenerate.ts`, `gemini-proxy.ts`, `render.ts`, `scriptToJson.ts`, `auth.ts`
- **All `/api/*` routes require a valid JWT cookie (`historia_token`) except `/api/auth/*`**, enforced by `server/middleware/requireAuth.ts`.
- `/api/auth` — public auth endpoints (see Auth section below)
- `/api/gemini-proxy` is a multi-service server-side proxy handling five actions:
  - `generate` — image generation via the Modal-hosted Z-Image Turbo API (`server/lib/gemini.ts`), authenticated with `MODAL_KEY` / `MODAL_SECRET`
  - `groq-chat` — Groq API proxy (uses `apiKey` from request or `GROQ_API_KEY` env)
  - `inworld-chat` — Inworld API proxy using `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` (uses `apiKey` or `INWORLD_API_KEY` env)
  - `claude-chat` — Anthropic API proxy (uses `apiKey` from request or `ANTHROPIC_API_KEY` env)
  - `gemini-chat` — Gemini/Vertex AI proxy (uses `apiKey` from request or `GEMINI_API_KEY` env, falls back to Vertex AI access token)
- `server/lib/veo.ts` — Veo video animation via Vertex AI (`us-central1` only)
- `server/routes/regenerate.ts` — `POST /api/regenerate` regenerates a single scene's image or audio server-side (body: `{ projectId, sceneNumber, type: "image"|"audio", voiceOverride? }`)
- Static directories served: `/uploads` → `uploads/`, `/sfx` → `sfx/`

### Shared (`shared/`)
- `shared/schema.ts` — Drizzle ORM schema for `projects`, `scenes`, `admin`, and `renderJobs` tables; imported by both frontend and backend
- `shared/scriptToJsonUtils.ts` — all Pass 1/Pass 2 AI pipeline logic (constants, prompt builders, JSON parsers, chunking); imported by both `src/lib/scriptToJson.ts` (client-side) and `server/routes/scriptToJson.ts` (server-side)
- `src/lib/types.ts` — TypeScript interfaces (`Project`, `Scene`, `ProjectSettings`, `StyleSummary`, `ProjectStats`) used on both sides

### Database
- PostgreSQL via Drizzle ORM. Four tables:
  - `projects` — metadata, settings, style_summary, stats as JSONB
  - `scenes` — per-scene prompts, file paths, statuses, error logs
  - `admin` — single-row table for the admin username/password_hash
  - `renderJobs` — persisted render job state (unique index on `project_id + type`)
- Key scene fields: `script_text` (display text), `tts_text` (text sent to TTS — may differ), `image_prompt`, `motion_prompt` (Veo animation description, falls back to `image_prompt`), `fallback_prompts` (JSONB array), `overlay_text`, `needs_review` (set true on generation failure).
- `splitMode` options: `"smart"` (2–3 sentences/scene), `"exact"` (1 sentence), `"two"` (2 sentences), `"duration"` (time-based splits).
- Schema changes: edit `shared/schema.ts` → `npm run db:push`

### Asset file storage (`uploads/`)
```
uploads/{projectId}/
  style/       style1.png, style2.png — reference images
  images/      {sceneNumber}.png — generated images (.svg = mock placeholder, never use for render)
  audio/       {sceneNumber}.mp3 — TTS audio
  videos/      {sceneNumber}.mp4 — Veo-animated clips (optional)
  clips/       {sceneNumber}.mp4 — final per-scene clips with Ken Burns + audio
  render/      output.mp4 — merged documentary
uploads/script_to_json_jobs.json — persisted ScriptToJson job history (survives restarts)
```

## Auth

- First-run flow: `GET /api/auth/status` returns `{ setup: false }` → frontend redirects to `/setup`
- `POST /api/auth/setup` — creates the single admin record (bcrypt hash, salt rounds 12); issues a 30-day JWT cookie
- `POST /api/auth/login` / `POST /api/auth/logout` — standard credential check / cookie clear
- Cookie name: `historia_token` (httpOnly, sameSite lax, secure in production)
- `JWT_SECRET` must be set before starting the server. Generate: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`

## ScriptToJson Pipeline

The script-to-JSON process runs as a two-pass AI pipeline. It can run **client-side** (via `src/lib/scriptToJson.ts` calling `/api/gemini-proxy`) or **server-side** as a background job.

**Server-side jobs** (`POST /api/script-to-json`):
- Jobs stored in-memory + persisted to `uploads/script_to_json_jobs.json` (survives restarts; running jobs are marked failed on reload)
- `GET /api/script-to-json` — list all jobs; `GET /api/script-to-json/:jobId` — poll progress; `DELETE /api/script-to-json/:jobId` — remove from history
- Pass 1: chunk script → split into scenes with timing. Pass 2: batch scenes → generate image prompts with continuity anchoring.
- Supported providers: `groq`, `inworld`, `claude`, `gemini`

**Shared logic** in `shared/scriptToJsonUtils.ts`: `chunkScript`, `buildPass1SystemPrompt`, `PASS2_IMPASTO_SYSTEM`, `PASS2_WWII_SYSTEM`, `parseJsonResponse`, `recoverScenesRegex`, `recoverPromptsRegex`, `buildContinuityAnchor`, `getGroqModelConfig`.

## Pipeline

### Asset generation modes

Images are **always generated client-side** via `/api/gemini-proxy` (Modal-hosted Z-Image Turbo API). The server pipeline (`runAssetPipeline`) only handles TTS audio when `INWORLD_API_KEY` is set and the project's `ttsProvider` is `inworld`.

When `INWORLD_API_KEY` is present and `ttsProvider === "inworld"`, `POST /api/projects/:id/scenes` triggers `runAssetPipeline()` server-side for audio and returns `{ serverPipeline: true }`. The frontend polls instead of generating audio locally.

The `stats.serverPipeline` boolean in the `projects` table is the flag the frontend reads to decide whether to poll or drive audio generation itself.

### Full pipeline flow
1. User submits script + optional style images → `POST /api/projects` creates project record
2. Script split into scenes client-side (Groq API, batched 30 scenes/request)
3. Scenes inserted via `POST /api/projects/:id/scenes` — triggers server audio pipeline if configured
4. Images: Modal-hosted Z-Image Turbo API via `/api/gemini-proxy` (client-driven, 2 concurrent calls enforced server-side via semaphore in `server/lib/gemini.ts`)
5. Audio: Inworld TTS API; sequential (100 RPS, retries up to 3× with backoff)
6. Video export (JsonToVideo page and render routes):
   - Phase 1: `POST /api/render/:id/clips` — one MP4 per scene with Ken Burns effect
   - Phase 2: `POST /api/render/:id` — concat clips into `output.mp4`
   - Or: `POST /api/render/:id/auto` — all phases in one background job
   - Optional: `POST /api/render/:id/animate` — Veo animation before clip generation
   - `POST /api/render/image-to-video` — convert a single uploaded image to an animated video (multipart)
   - `GET /api/render/health` — check external render API connectivity
   - `GET /api/render/:id/download` — download `output.mp4` as file
   - `GET /api/render/:id/clips/zip` — download all scene clips as ZIP
   - `GET /api/render/:id/animate/zip` — download animated scenes as ZIP
   - `GET /api/download/:projectId` — download full project (images/audio/scene JSON) as ZIP

**Render jobs (`clipJobs`, `mergeJobs`, `animateJobs`, `autoJobs`) are stored in-memory — they don't survive server restarts.**

## Key Conventions

- **AI providers** (Groq key, Inworld key, Anthropic key, Gemini key) are stored in `localStorage` and set via the Settings page. The Groq key is **never** in `.env`; it can be passed as `apiKey` in the `groq-chat` proxy request.
- **Text provider** (`textProvider` in `ProviderSettings`): `"groq"` (default, batch 10), `"claude"` (batch 5), `"inworld"` (batch 15), or `"gemini"` (batch 10). Determines which LLM generates scene image prompts.
- **Visual theme** (`visualTheme` in `ProviderSettings`): `"impasto"` (default — digital oil painting, heavy impasto style) or `"ww2"` (WWII archival photorealism, B&W film grain). Switches both the system prompt and image style suffix (`COMPACT_STYLE_SUFFIX` / `COMPACT_WWII_STYLE_SUFFIX` in `providers.ts`).
- **Image generation** uses a single model — Modal-hosted Z-Image Turbo (`server/lib/gemini.ts`, `MODAL_ZIMAGE_URL`) — with no per-project model selection. Aspect ratio (`16:9`, `1:1`, `9:16`) remains selectable.
- `skipImageGeneration` setting (in `ProviderSettings`) bypasses Imagen calls entirely — useful for testing audio/script flows without consuming quota.
- **shadcn/ui** components live in `src/components/ui/`. Fonts: Cinzel (headings), Source Sans 3 (body).
- Scene status fields (`image_status`, `audio_status`): `pending` | `completed` | `failed`
- Scene `video_status`: `none` | `animating` | `completed` | `failed`
- Project status values: `created` | `processing` | `completed` | `partial` | `failed` | `stopped`
- `scene_number` is sequential (1-based) per project; scenes can be appended via `/api/projects/:id/scenes/append`.
- `project.stats` is recalculated from live scene rows on every `GET /api/projects/:id` — the stored value is a cache that self-corrects on fetch.
- `.svg` files in `uploads/{id}/images/` are mock placeholders; `POST /api/projects/:id/fix-mocks` resets them to `failed` so real images can be generated.

## Environment Variables

Create `.env` in project root:

```env
PORT=3001
DATABASE_URL=postgresql://historia:password@localhost:5432/historia
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
RENDER_API_URL=http://5.189.146.143:9000   # External FFmpeg render API
RENDER_API_KEY=alliswell
SERVER_URL=http://5.189.146.143:3001       # Public URL of this server (used by render API to fetch assets)
INWORLD_API_KEY=<key>                      # Can also be set via Settings page
# Modal (Z-Image Turbo image generation)
MODAL_ZIMAGE_URL=https://leksautomate--z-image-turbo-api.modal.run   # optional override
MODAL_KEY=<modal-key>
MODAL_SECRET=<modal-secret>
# Vertex AI (for Veo + Claude/Gemini text proxy) — requires gcloud CLI authenticated
VERTEX_PROJECT_ID=<gcp-project-id>
VERTEX_LOCATION_ID=europe-west4            # Gemini text region (default: europe-west4)
VEO_LOCATION_ID=us-central1               # Veo is us-central1 only
VEO_MODEL_ID=veo-3.1-lite-generate-001
# Optional server-side LLM keys (can also be passed per-request)
ANTHROPIC_API_KEY=<key>
GROQ_API_KEY=<key>
GEMINI_API_KEY=<key>                       # Falls back to Vertex AI if absent
CLIP_CONCURRENCY=3                         # Parallel clip generation workers (default: 3)
```

Vertex AI access requires `gcloud auth application-default login` on the server host.
