# Changelog

All notable changes to Historia are documented here.

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
- Supabase backend — projects and scenes tables with storage
- Whisk proxy edge function for CORS bypass
- App sidebar navigation
