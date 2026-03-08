# Historia — Application Context

This document provides a high-level overview of the Historia application for developers and AI assistants.

## What is Historia?

Historia is a **cinematic historical documentary generator**. It takes a written historical script, splits it into visual scenes using AI, generates historically-accurate images and professional narration audio for each scene, then lets the user preview and refine the result in a cinematic player.

The target output is an asset pack (images + audio per scene) ready to be assembled into a documentary-style video.

## Core Workflow

```
Script + Style Images → AI Scene Splitting → Image Generation → TTS Audio → Preview & Refine
```

1. User pastes a historical narrative script
2. User uploads 2 style reference images (these anchor the visual tone)
3. User selects a narration voice and script split mode (smart vs exact)
4. **Groq (Llama 3.3 70B)** splits the script into scenes, generating image prompts and metadata
5. **Google Whisk (Imagen 3.5)** generates images per scene using the style references
6. **Inworld AI TTS** generates narration audio per scene
7. User reviews in a cinematic preview player with timeline, subtitles, and audio
8. User can edit prompts, regenerate individual assets, split scenes, or change voices

## Architecture

### Frontend-Driven Pipeline
The generation pipeline runs **entirely on the frontend** (`src/lib/api.ts`). The browser orchestrates:
- Calling Groq API for scene manifest generation
- Uploading style images and generated assets to storage
- Calling Whisk (via edge function proxy) for image generation
- Calling Inworld API for TTS audio generation
- Writing results to the database in real-time

### Backend (Lovable Cloud / Supabase)
- **PostgreSQL** — stores projects and scenes
- **Storage** — public bucket for images and audio files
- **Edge Functions** — `whisk-proxy` (CORS bypass for Google Whisk API), `create-project`, `download-project`, `regenerate-asset`

### Key Design Decisions
- **No server-side pipeline** — all AI calls happen client-side for simplicity and real-time progress feedback
- **TTS text = script text** — narration text is never rephrased or modified from the original script
- **Anonymous figures only** — image prompts never use celebrity likenesses; all people are described generically
- **Fallback prompts** — each scene gets 3 progressively simpler fallback image prompts
- **Style anchor** — a consistent style prefix is prepended to all image prompts for visual consistency
- **Settings in localStorage** — API keys are stored in the browser, not in the database

## Data Model

### Projects
Each project has a title, status, settings (voice, split mode, provider config), a style summary (palette, lighting, framing, mood, etc.), and aggregated stats.

### Scenes
Each scene belongs to a project and contains:
- `script_text` — the original script chunk
- `tts_text` — narration text (kept identical to script_text)
- `image_prompt` + `fallback_prompts` — cinematic image generation prompts
- `image_file` / `audio_file` — storage paths to generated assets
- `image_status` / `audio_status` — pending, completed, or failed
- `voice_id` — optional per-scene voice override
- `scene_type` — character, location, crowd, battle_light, artifact, transition
- `historical_period` — era context for the scene
- `visual_priority` — character, environment, or object focus

## AI Providers

| Provider | Purpose | Config |
|----------|---------|--------|
| **Groq** (Llama 3.3 70B) | Scene manifest generation, prompt regeneration | API key in Settings |
| **Google Whisk** (Imagen 3.5) | Image generation with style transfer | Browser cookie in Settings |
| **Inworld AI** (TTS 1.5 Max) | Text-to-speech narration | API key in Settings |

## Script Split Modes

- **Smart** — AI splits at natural 2–4 sentence beats, preserving narrative flow
- **Exact** — AI splits strictly at paragraph boundaries

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/api.ts` | Pipeline orchestration — project creation, asset generation, CRUD, bulk operations, scene splitting |
| `src/lib/providers.ts` | AI provider integrations — Groq prompts, Whisk image gen, Inworld TTS, settings management |
| `src/lib/types.ts` | TypeScript interfaces for Project, Scene, Settings, StyleSummary |
| `src/components/ProjectForm.tsx` | New project creation form with voice selection and split mode |
| `src/components/SceneCard.tsx` | Individual scene card with inline editing and regeneration |
| `src/pages/ProjectPreview.tsx` | Cinematic preview player with timeline, audio, and subtitles |
| `src/pages/ProjectStatus.tsx` | Project detail view with scene list and stats |
| `src/pages/Settings.tsx` | API key configuration and connection health checks |

## Voice Options

| ID | Description |
|----|-------------|
| Dennis | Male, warm baritone narrator |
| Eleanor | Female, elegant and composed |
| James | Male, authoritative and deep |
| Linda | Female, friendly and clear |
| Brian | Male, calm and neutral |
| Amy | Female, youthful and energetic |

## Edge Functions

| Function | Purpose |
|----------|---------|
| `whisk-proxy` | Proxies requests to Google Whisk API to bypass CORS restrictions |
| `create-project` | Server-side project creation (legacy, pipeline now runs client-side) |
| `download-project` | Exports project assets for download |
| `regenerate-asset` | Server-side asset regeneration endpoint |
