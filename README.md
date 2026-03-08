# Historia — Cinematic Historical Documentary Generator

A web application that transforms historical scripts into cinematic documentary-style content with AI-generated images and narration.

## Quick Install

```bash
# One-line install (after cloning)
chmod +x install.sh && ./install.sh

# Or manually:
git clone <YOUR_GIT_URL>
cd historia
npm install
npm run dev
```

## Overview

Historia automates the production pipeline for historical documentary content:

1. **Write a script** — paste your historical narrative
2. **Upload style references** — provide 1-2 reference images to guide the visual style
3. **AI generates scenes** — Groq (Llama 3.3) splits your script into visual scenes with cinematic image prompts
4. **Image generation** — Google Whisk (Imagen 3.5) creates historically-accurate images using your style references
5. **Voice narration** — Inworld AI generates professional text-to-speech audio per scene
6. **Preview & refine** — use the built-in cinematic player to review, edit prompts, and regenerate assets

## Features

### Project Pipeline
- **Automatic scene splitting** — AI analyzes script structure, identifies scene breaks by location/action/emotion
- **Cinematic image prompts** — generates detailed prompts with historical accuracy, anonymous figures, and documentary framing
- **Fallback prompts** — 3 progressive fallbacks per scene if primary prompt fails
- **Bulk retry** — one-click retry for all failed assets

### Scene Preview Player
- **Full-screen image viewer** with subtitle overlay showing script text
- **Audio playback controls** — play/pause, seek, volume, auto-advance to next scene
- **Horizontal timeline** — scrollable scene thumbnails with duration badges
- **Prompt editing sidebar** — edit image prompts, regenerate via AI, or regenerate images directly

### Scene Management
- **Inline editing** — edit script text and image prompts directly on scene cards
- **Scene splitting** — split scenes at sentence boundaries for finer control
- **Per-scene voice** — override the default voice for individual scenes
- **Image & audio regeneration** — regenerate individual assets with updated prompts

### Settings & Health Checks
- **API connection testing** — test each provider (Groq, Whisk, Inworld) with one click
- **Green/red status indicators** — instant visual feedback with detailed error messages
- **"Test All Connections"** button for quick verification of your entire setup

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui |
| Backend | Lovable Cloud (Supabase) |
| Database | PostgreSQL |
| Storage | Supabase Storage (public bucket) |
| AI — Script | Groq API (Llama 3.3 70B) |
| AI — Images | Google Whisk (Imagen 3.5) with style reference support |
| AI — TTS | Inworld AI (TTS 1.5 Max) |

## Setup

### Prerequisites
- Node.js 18+ ([install via nvm](https://github.com/nvm-sh/nvm#installing-and-updating))
- npm

### Installation

```bash
# Clone the repo
git clone <YOUR_GIT_URL>
cd historia

# Install dependencies
npm install

# Start dev server
npm run dev
```

### API Keys Configuration

Open the app → navigate to **Settings** → configure:

| Key | Where to get it | Used for |
|-----|----------------|----------|
| **Groq API Key** | [console.groq.com](https://console.groq.com) | Scene manifest generation, prompt regeneration |
| **Whisk Cookie** | Browser cookie from [labs.google](https://labs.google) | Imagen 3.5 image generation |
| **Inworld API Key** | [inworld.ai](https://inworld.ai) | Text-to-speech narration |

Use the **"Test All Connections"** button to verify each key works.

### Getting the Whisk Cookie

1. Go to [labs.google/fx](https://labs.google/fx) and sign in with your Google account
2. Open DevTools → Application → Cookies
3. Copy the full cookie string (all cookies for `labs.google`)
4. Paste into Settings → Whisk Cookie

## Pages

| Route | Description |
|-------|-------------|
| `/` | Home / new project form |
| `/projects` | Project list |
| `/projects/:id` | Project status, stats, scene cards |
| `/projects/:id/preview` | Cinematic preview player |
| `/settings` | API keys, provider config, health checks |

## Error Handling

The app provides contextual error messages for common failure scenarios:

- **Missing API keys** — prompts user to configure in Settings
- **Whisk authentication** — detects expired cookies with actionable guidance
- **Rate limiting** — identifies 429 errors with retry suggestions
- **Network/CORS failures** — distinguishes connectivity from API errors
- **Generation failures** — shows provider-specific error details per scene
- **Auth/rate-limit aware retry** — stops retrying fallback prompts when the issue is auth, not prompt content

## Project Structure

```
├── install.sh                # One-click install script
├── src/
│   ├── components/
│   │   ├── AppLayout.tsx     # Main layout with sidebar
│   │   ├── AudioPlayer.tsx   # Inline audio player
│   │   ├── ProjectForm.tsx   # New project creation form
│   │   ├── SceneCard.tsx     # Scene detail card with editing
│   │   ├── SplitSceneDialog.tsx
│   │   ├── Timeline.tsx      # Horizontal scene timeline
│   │   └── ui/               # shadcn/ui components
│   ├── lib/
│   │   ├── api.ts            # Pipeline orchestration, CRUD
│   │   ├── providers.ts      # AI integrations (Groq, Whisk, Inworld)
│   │   └── types.ts          # TypeScript interfaces
│   ├── pages/
│   │   ├── Index.tsx
│   │   ├── Projects.tsx
│   │   ├── ProjectStatus.tsx
│   │   ├── ProjectPreview.tsx # Cinematic preview player
│   │   └── Settings.tsx      # Config + health checks
│   └── integrations/
│       └── supabase/         # Auto-generated client
└── supabase/
    └── functions/            # Edge functions
```

## Database Schema

### `projects`
| Column | Type | Description |
|--------|------|-------------|
| `id` | text | e.g. `proj_abc12345` |
| `title` | text | Project name |
| `status` | text | `created`, `processing`, `completed`, `partial`, `failed` |
| `settings` | jsonb | Provider configuration |
| `style_summary` | jsonb | Visual style guide |
| `stats` | jsonb | Scene/image/audio counts |

### `scenes`
| Column | Type | Description |
|--------|------|-------------|
| `project_id` | text | FK to projects |
| `scene_number` | int | Sequential scene index |
| `script_text` | text | Original script chunk |
| `tts_text` | text | Narration text |
| `image_prompt` | text | Cinematic image prompt |
| `fallback_prompts` | jsonb | Array of simpler alternatives |
| `image_status` / `audio_status` | text | `pending`, `completed`, `failed` |
| `voice_id` | text | Per-scene voice override |
| `needs_review` | bool | Flagged for attention |

## Scripts

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run preview  # Preview production build
npm run test     # Run tests
```

## License

Private project.
