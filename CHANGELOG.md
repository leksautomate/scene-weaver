# Changelog

All notable changes to Historia are documented here.

## [0.6.0] — 2026-03-09

### Added
- **Server-side background image generation** — "Generate All Missing Images" now fires a `POST /api/projects/:id/generate-missing` request and returns immediately; the server generates images in the background with no dependency on the browser tab staying open
- **Live progress polling** — Project Status and Preview pages auto-poll every 3 seconds while generation is in progress; progress bars and scene cards update in real time without manual refresh
- **"Generate All Missing Images" button on Preview page** — available in the top toolbar whenever any scene lacks an image; shows "Generating in background…" spinner while server is processing
- **Correct project completion logic** — a project is now only marked `completed` when every scene has both image AND audio accounted for (no pending scenes); previously a project could be marked complete while images were still pending

### Changed
- Bulk image generation moved from client-side loop to server-side background pipeline — navigation away from the page no longer stops generation
- Project status `processing` is set at the start of background generation so polling activates automatically on both Project Status and Preview pages
- "Retry All Failed" and "Generate All Missing Images" buttons are mutually disabled while either is running

### Fixed
- Project incorrectly marked `completed` when images were still `pending` (status logic now checks all scenes are fully accounted for, not just absence of failures) — fixed on both client and server pipelines

## [0.5.0] — 2026-03-09

### Added
- **Bulk image generation buttons** — "Generate All Missing Images (N)" on Project Status page triggers generation for all scenes where image is not yet completed (pending or failed); "Generate Missing (N)" on Preview page toolbar does the same
- `bulkGenerateImages` function in `api.ts` targeting non-completed scenes only

### Changed
- "Generate All Missing Images" and "Retry All Failed" are separate actions, each showing their own progress counter
- Both bulk actions disable each other while running to avoid conflicts

## [0.4.0] — 2026-03-09

### Added
- **VPS deployment script** (`deploy.sh`) — one-command Ubuntu/Debian deploy: installs Node.js 20, PostgreSQL, creates DB, writes `.env`, builds, creates systemd service
- **Configurable port** — `server/index.ts` reads `PORT` from environment; `deploy.sh` accepts `--port` flag; multiple instances on same VPS supported
- **"Historia" branding** — browser tab title, meta tags, sidebar "H" lettermark badge, custom SVG favicon (`/historia-icon.svg`)
- **Preview timeline scrollbar contained** — horizontal scrollbar is inside the timeline strip, not at the page level
- **No browser-level scrolling** — app locked to viewport height; all pages scroll within their own containers
- **Prompt-only sidebar on Preview page** — removed Scenes tab from preview sidebar; scenes stay in bottom timeline; sidebar shows only the image prompt editor
- **Improved Whisk error messages** — 401 auth errors are stored on scene cards and shown in Error Log as "Whisk auth expired. Update your Whisk Cookie in Settings." instead of generic failure messages

### Changed
- `AppLayout` uses `h-screen overflow-hidden` (was `min-h-screen`) to eliminate browser-level scrollbar
- All page root containers use `h-full overflow-y-auto` for internal scrolling

## [0.3.0] — 2026-03-08

### Added
- **Voice selection** on project form — choose from 6 Inworld narration voices
- **Script split mode** on project form — Smart (sentence-aware beats) or Exact (paragraph boundaries)
- **TTS text preservation** — narration text is now kept identical to original script (no rephrasing)
- `CONTEXT.md` — comprehensive developer/AI reference document

### Changed
- Updated `README.md` with voice selection, split modes, and improved structure
- Updated LLM scene prompt to enforce tts_text = script_text

## [0.2.0] — 2026-03-07

### Added
- **Cinematic preview player** — full-screen image viewer with subtitles, audio controls, and auto-advance
- **Horizontal timeline** — scrollable scene thumbnails with duration badges
- **Prompt editing sidebar** — edit image prompts and regenerate via AI from the preview
- **Scene splitting** — split scenes at sentence boundaries with a dialog
- **Per-scene voice override** — change narration voice for individual scenes
- **Bulk retry** — one-click retry for all failed assets
- **Smart text splitter** utility page — split text by sentences or exact word count
- **Error log viewer** — dedicated page for reviewing generation errors
- **Settings health checks** — test Groq, Whisk, and Inworld connections with one click

### Changed
- Pipeline runs entirely client-side for real-time progress feedback
- Fallback prompts include style anchor prefix for visual consistency

## [0.1.0] — 2026-03-06

### Added
- Initial release
- Project creation form with script input and dual style reference uploads
- AI scene manifest generation via Groq (Llama 3.3 70B)
- Image generation via Google Whisk (Imagen 3.5) with style transfer
- TTS audio generation via Inworld AI (TTS 1.5 Max)
- Project list and project detail pages with scene cards
- Inline editing of script text and image prompts
- Image and audio regeneration per scene
- PostgreSQL backend — projects and scenes tables via Drizzle ORM
- Whisk proxy for CORS bypass
- App sidebar navigation
