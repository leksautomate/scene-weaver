# Background Music — Design Spec
Date: 2026-06-20

## Overview

Add background music to the final merged video output. A random track is picked from the `bg_music/` folder at the repo root on each render. Music is mixed in as a post-processing step after `mergeVideo` completes, keeping the core clip/merge pipeline untouched.

## Data Model

Three new fields in `ProviderSettings` (`src/lib/providers.ts`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `bgMusicEnabled` | `boolean` | `true` | Toggle BG music on/off |
| `bgMusicVolume` | `number` | `0.10` | BG music volume (0.0–1.0) |
| `narrationVolume` | `number` | `2.0` | Narration/TTS volume multiplier |

Stored in `localStorage` with all other provider settings. Passed in the POST body of render requests alongside existing params.

## Settings UI

New **"Background Music"** card in the `providers` tab of `src/pages/Settings.tsx`, inserted below the "Veo Video Animation" card.

Controls:
- **Enable Background Music** — Switch toggle
- **Music Volume** — Slider, 0–100%, default 10%
- **Narration Volume** — Slider, 50–300%, default 200%
- **Track count display** — fetches `GET /api/render/bgmusic/tracks`, shows "N files found" with a Refresh button. Read-only — user manages files directly on disk.

## Backend

### New endpoint
`GET /api/render/bgmusic/tracks`
- Scans `bg_music/` directory at `process.cwd()`
- Returns `{ count: number, files: string[] }`
- Returns `{ count: 0, files: [] }` if folder is missing or empty

### New function: `applyBgMusic`
Location: `server/routes/render.ts`

```ts
async function applyBgMusic(
  inputPath: string,
  narrationVolume: number,  // e.g. 2.0
  bgMusicVolume: number,    // e.g. 0.10
): Promise<void>
```

Algorithm:
1. Scan `bg_music/` for `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac` files
2. Pick one at random
3. Run FFmpeg:
   ```
   ffmpeg -y -i <inputPath>
          -stream_loop -1 -i <randomTrack>
          -filter_complex
            "[0:a]volume=<narrationVolume>[narr];
             [1:a]volume=<bgMusicVolume>[music];
             [narr][music]amix=inputs=2:duration=first:normalize=0[aout]"
          -map 0:v -map [aout]
          -c:v copy
          -c:a aac -b:a 128k -ar 44100
          <inputPath>.tmp.mp4
   ```
4. Atomically replace `inputPath` with the temp file

### Integration points

`applyBgMusic` is called **after** `mergeVideo` succeeds, in:
- `POST /api/render/:id` — manual merge route
- `runAutoPipeline()` — after the `mergeVideo` call

**Not applied to** individual clips (`POST /api/render/:id/clips`) — clips stay music-free.

### Skip conditions
- `bgMusicEnabled` is `false`
- `bg_music/` folder does not exist or contains no supported audio files

### Render body params added
- `bgMusicEnabled: boolean`
- `bgMusicVolume: number`
- `narrationVolume: number`

These are extracted in the route handlers and passed through.

## File Layout

```
bg_music/          ← user manages these files directly
  track1.mp3
  track2.mp3
  ...
```

No upload endpoint. No database changes. No schema migration needed.

## Audio Format Support

Supported extensions scanned from `bg_music/`: `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`

## Edge Cases

- Single clip render (length === 1): `mergeVideo` copies the clip directly. `applyBgMusic` still runs on the output.
- xfade OOM fallback path (concat): `applyBgMusic` runs after concat output, same as normal.
- BG music file shorter than video: `-stream_loop -1` loops it indefinitely; `duration=first` cuts it at video end.
- BG music file longer than video: `duration=first` trims it at video end automatically.
- `bg_music/` folder missing at render time: log a warning, skip silently — render succeeds without music.
