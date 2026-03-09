# Historia — Cinematic Historical Documentary Generator

A self-hosted web application that transforms historical scripts into cinematic documentary-style asset packs — AI-generated images via Google Whisk (Imagen 3.5) and professional voice narration via Inworld TTS.

## Quick Install

```bash
# Clone and run
git clone <YOUR_GIT_URL>
cd historia
chmod +x install.sh && ./install.sh

# Then start
npm run dev
```

## Overview

Historia automates the production pipeline for historical documentary content:

1. **Write a script** — paste your historical narrative
2. **Upload style references** — provide 2 reference images to guide the visual style
3. **Choose voice & split mode** — select a narration voice and how the script is divided into scenes
4. **AI generates scenes** — Groq (Llama 3.3) splits your script into visual scenes with cinematic image prompts (long scripts are chunked progressively — you're redirected as soon as the first batch is ready)
5. **Image generation** — Google Whisk (Imagen 3.5) creates historically-accurate images using your style references
6. **Voice narration** — Inworld AI generates professional text-to-speech audio per scene
7. **Preview & refine** — use the built-in cinematic player to review, edit prompts, and regenerate assets

## Features

### Project Creation
- **Voice selection** — choose from 16 built-in Inworld narration voices (8 male / 8 female), or add custom voices in Settings
- **Script split modes** — "Smart" (sentence-aware 2–4 sentence beats) or "Exact" (paragraph boundaries)
- **Dual style references** — upload 2 images to anchor the visual tone across all generated scenes
- **Progressive chunking** — long scripts are chunked; the project is created after the first chunk so you're redirected immediately while remaining chunks process in the background

### Scene Pipeline
- **Automatic scene splitting** — AI analyzes script structure, identifies scene breaks by location/action/emotion
- **Cinematic image prompts** — generates detailed prompts with historical accuracy, anonymous figures, and documentary framing
- **Fallback prompts** — 3 progressive fallbacks per scene if primary prompt fails
- **Auth-aware early exit** — if Whisk returns a 401, all fallbacks are skipped immediately (no wasted retries)
- **Bulk retry** — one-click retry for all failed assets
- **Background image generation** — "Generate All Missing Images" runs server-side; navigate away and generation continues uninterrupted; live progress polling updates bars every 3 seconds

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
- **Custom voice management** — add/remove custom Inworld voice IDs
- **"Test All Connections"** button for quick verification of your entire setup

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui |
| Backend | Express.js (Node.js) |
| Database | PostgreSQL (via Drizzle ORM) |
| AI — Script | Groq API (Llama 3.3 70B) |
| AI — Images | Google Whisk (Imagen 3.5) with style reference support |
| AI — TTS | Inworld AI (TTS 1.5 Max) |

## Setup

### Prerequisites
- Node.js 18+ ([install via nvm](https://github.com/nvm-sh/nvm#installing-and-updating))
- npm
- PostgreSQL database (or use the Replit built-in DB)

### Installation

```bash
git clone <YOUR_GIT_URL>
cd historia
chmod +x install.sh && ./install.sh
```

Or manually:

```bash
npm install
cp .env.example .env   # then edit .env with your credentials
npm run db:push        # create database tables
npm run dev
```

### VPS Deployment (Ubuntu / Debian)

Use the included `deploy.sh` for a fully automated setup — PostgreSQL, database creation, systemd service, and port selection all handled for you.

```bash
# On your VPS (as root or with sudo):
git clone <YOUR_GIT_URL> historia
cd historia
sudo bash deploy.sh --port 3001 --dir /opt/historia
```

You'll be prompted for the port if you don't pass `--port`. Pick any free port that doesn't conflict with your existing services (e.g. `3001`, `3002`, `8080`).

What the script does automatically:
- Installs **Node.js 20** via nvm (if not installed)
- Installs **PostgreSQL** (if not installed)
- Creates a database user and database named `historia`
- Writes a `.env` with `PORT` and `DATABASE_URL`
- Runs `npm install`, `npm run build`, and `npm run db:push`
- Creates and starts a **systemd service** (`historia-<port>`) so it survives reboots

**Multiple instances on the same VPS** — just run the script again with a different port and directory:

```bash
sudo bash deploy.sh --port 3002 --dir /opt/historia-v2
```

**Useful commands after deploy:**

```bash
journalctl -u historia-3001 -f      # live logs
systemctl restart historia-3001     # restart
systemctl stop historia-3001        # stop
nano /opt/historia/.env             # edit config
```

**Nginx reverse proxy** — the script prints the config block at the end. Example for a subdomain:

```nginx
server {
    listen 80;
    server_name historia.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        client_max_body_size 50M;
    }
}
```

### Environment Variables

Create a `.env` file (or set these in your host's environment):

```env
DATABASE_URL=postgresql://user:password@localhost:5432/historia

# Optional — can also be configured in the app's Settings page
WHISK_COOKIE=<your whisk session cookie>
INWORLD_API_KEY=<your inworld api key>
```

> Groq API key is always set via the Settings page (stored in localStorage).

### API Keys Configuration

Open the app → navigate to **Settings** → configure:

| Key | Where to get it | Used for |
|-----|----------------|----------|
| **Groq API Key** | [console.groq.com](https://console.groq.com) | Scene manifest generation, prompt regeneration |
| **Whisk Cookie** | Browser cookie from [labs.google](https://labs.google/fx/tools/whisk) | Imagen 3.5 image generation |
| **Inworld API Key** | [inworld.ai/studio](https://inworld.ai/studio) | Text-to-speech narration |

Use the **"Test All Connections"** button to verify each key works before creating projects.

### Getting the Whisk Cookie

Whisk uses Google session cookies for authentication. **These expire every few days.**

1. Go to [labs.google/fx/tools/whisk](https://labs.google/fx/tools/whisk) and sign in with your Google account
2. Open DevTools (F12) → **Application** tab → **Cookies** → select `labs.google`
3. Copy the full cookie string — all `name=value` pairs joined by `;`
4. Paste into **Settings → Whisk Cookie** and save
5. Click **"Test Whisk"** to confirm it works

## Pages

| Route | Description |
|-------|-------------|
| `/` | Home — new project form with voice & split mode selection |
| `/projects` | Project list |
| `/projects/:id` | Project status, stats, scene cards |
| `/projects/:id/preview` | Cinematic preview player |
| `/settings` | API keys, provider config, health checks |
| `/errors` | Error log viewer — all failed scenes across all projects |
| `/text-splitter` | Smart text splitter utility |

## Troubleshooting

### "All Whisk prompts failed" / "Whisk auth expired"

Your Whisk session cookie has expired. Fix:
1. Go to [labs.google/fx/tools/whisk](https://labs.google/fx/tools/whisk) and log in
2. Open DevTools → Application → Cookies → `labs.google`
3. Copy all cookies and paste into **Settings → Whisk Cookie**
4. Hit **"Test Whisk"** — if it goes green, use **"Generate All Missing Images"** or **"Retry All Failed"** on your project

**"Generate All Missing Images"** runs on the server — you can navigate away and it keeps generating. The progress bars on the Project Status page update every 3 seconds automatically.

The Error Log page (`/errors`) shows the exact error per scene — if it says "auth expired" you need a new cookie; if it says "failed (500)" the prompt may need editing.

### "Groq API key is invalid"

Go to [console.groq.com](https://console.groq.com), create a new API key, and update it in Settings.

### "Inworld API key is invalid"

Go to [inworld.ai/studio](https://inworld.ai/studio), generate a new key, and update it in Settings.

### Database connection error

Ensure `DATABASE_URL` is set correctly in your `.env` and the PostgreSQL server is running. Run `npm run db:push` to re-sync the schema.

### Images generating as SVG placeholders

Mock mode is active. Make sure **Whisk** is selected as the image provider in Settings and your cookie is valid.

## Error Handling

- **Missing API keys** — prompts user to configure in Settings
- **Whisk authentication (401)** — detects expired cookies immediately, stops fallback retries, stores the actual auth error message on the scene card
- **Rate limiting (429)** — Groq: auto-retries after 15s; Whisk: stops retrying
- **Network failures** — distinguishes connectivity from API errors
- **Generation failures** — shows provider-specific error details per scene on the Error Log page

## Project Structure

```
├── install.sh                 # One-click install script
├── server/
│   ├── index.ts               # Express server entry point
│   ├── db.ts                  # Drizzle ORM database connection
│   ├── routes/
│   │   ├── projects.ts        # Project + scene CRUD, asset pipeline, background generate-missing
│   │   └── whisk-proxy.ts     # Whisk API proxy (cookie forwarding)
│   └── lib/
│       └── whisk.ts           # Whisk SDK wrapper
├── shared/
│   └── schema.ts              # Drizzle schema (projects, scenes)
├── src/
│   ├── components/
│   │   ├── AppLayout.tsx      # Main layout with sidebar
│   │   ├── AudioPlayer.tsx    # Inline audio player
│   │   ├── ProjectForm.tsx    # New project form
│   │   ├── SceneCard.tsx      # Scene detail card with editing
│   │   ├── SplitSceneDialog.tsx
│   │   ├── Timeline.tsx       # Horizontal scene timeline
│   │   └── ui/                # shadcn/ui components
│   ├── lib/
│   │   ├── api.ts             # Pipeline orchestration, CRUD, progressive chunking
│   │   ├── providers.ts       # AI integrations (Groq, Whisk, Inworld)
│   │   ├── types.ts           # TypeScript interfaces
│   │   └── utils.ts           # Utility functions
│   └── pages/
│       ├── Index.tsx          # Home / project form
│       ├── Projects.tsx       # Project list
│       ├── ProjectStatus.tsx  # Project detail + scene cards
│       ├── ProjectPreview.tsx # Cinematic preview player
│       ├── Settings.tsx       # Config + health checks + custom voices
│       ├── ErrorLog.tsx       # Error log viewer
│       └── TextSplitter.tsx   # Smart text splitter utility
└── uploads/                   # Generated images and audio (gitignored)
```

## Database Schema

### `projects`
| Column | Type | Description |
|--------|------|-------------|
| `id` | text | e.g. `proj_abc12345` |
| `title` | text | Project name |
| `status` | text | `created`, `processing`, `completed`, `partial`, `failed`, `stopped` |
| `settings` | jsonb | Voice ID, split mode, provider config |
| `style_summary` | jsonb | Visual style guide (palette, lighting, framing, mood) |
| `stats` | jsonb | Scene/image/audio counts, needs-review count |

### `scenes`
| Column | Type | Description |
|--------|------|-------------|
| `project_id` | text | FK to projects |
| `scene_number` | int | Sequential scene index |
| `script_text` | text | Original script chunk |
| `tts_text` | text | Narration text (identical to script_text) |
| `image_prompt` | text | Cinematic image prompt |
| `fallback_prompts` | jsonb | Array of simpler fallback prompts |
| `image_status` / `audio_status` | text | `pending`, `completed`, `failed` |
| `image_error` | text | Last error message if generation failed |
| `image_attempts` | int | Number of generation attempts |
| `voice_id` | text | Per-scene voice override |
| `needs_review` | bool | Flagged for attention |

## Scripts

```bash
npm run dev      # Start dev server (builds then runs Express + Vite)
npm run build    # Production build
npm run db:push  # Sync database schema
```

## License

Private project.
