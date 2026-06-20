# Background Music Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mix a randomly-chosen background music track from `bg_music/` into the final merged video, with UI controls for music volume (default 10%) and narration volume (default 200%).

**Architecture:** Background music is a post-processing FFmpeg pass that runs after `mergeVideo()` produces `output.mp4`. It copies the video stream untouched (`-c:v copy`), mixes narration (boosted) with a looped music track (attenuated), and atomically replaces the output. The core clip/merge pipeline is untouched. Settings live in `ProviderSettings` (localStorage) and flow through the existing render-request body.

**Tech Stack:** React 18 + Vite (frontend), Express 5 + Drizzle (backend), FFmpeg (audio mixing), Vitest (tests).

## Global Constraints

- Music file source: `bg_music/` folder at `process.cwd()` (repo root). User manages files manually — no upload endpoint.
- Supported audio extensions: `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac` (case-insensitive).
- Defaults: `bgMusicEnabled = true`, `bgMusicVolume = 0.10`, `narrationVolume = 2.0`.
- Music volume UI range: 0–100% (slider step 1%, stored as 0.0–1.0).
- Narration volume UI range: 50–300% (slider step 10%, stored as 0.5–3.0).
- BG music applies ONLY to the merged `output.mp4`, never to individual clips.
- Skip silently (render still succeeds) when disabled OR `bg_music/` is missing/empty.
- No database/schema changes.

---

### Task 1: Settings data model

**Files:**
- Modify: `src/lib/providers.ts:38-61` (ProviderSettings interface), `src/lib/providers.ts:111-134` (DEFAULTS)
- Test: `src/test/providers.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ProviderSettings.bgMusicEnabled: boolean`, `ProviderSettings.bgMusicVolume: number`, `ProviderSettings.narrationVolume: number`; defaults `true`, `0.10`, `2.0`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/providers.test.ts`:

```ts
describe("background music settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("has correct defaults when no settings saved", () => {
    const settings = loadProviderSettings();
    expect(settings.bgMusicEnabled).toBe(true);
    expect(settings.bgMusicVolume).toBe(0.10);
    expect(settings.narrationVolume).toBe(2.0);
  });

  it("persists background music settings when saved", () => {
    saveProviderSettings({
      ...loadProviderSettings(),
      bgMusicEnabled: false,
      bgMusicVolume: 0.25,
      narrationVolume: 1.5,
    });
    const loaded = loadProviderSettings();
    expect(loaded.bgMusicEnabled).toBe(false);
    expect(loaded.bgMusicVolume).toBe(0.25);
    expect(loaded.narrationVolume).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/providers.test.ts -t "background music"`
Expected: FAIL — `expected undefined to be true` (fields don't exist yet).

- [ ] **Step 3: Add fields to the interface**

In `src/lib/providers.ts`, add to the `ProviderSettings` interface after `veoAudioVolume?: number;` (line 60):

```ts
  bgMusicEnabled?: boolean;
  bgMusicVolume?: number;
  narrationVolume?: number;
```

- [ ] **Step 4: Add defaults**

In `src/lib/providers.ts`, add to the `DEFAULTS` object after `veoAudioVolume: 0.03,` (line 133):

```ts
  bgMusicEnabled: true,
  bgMusicVolume: 0.10,
  narrationVolume: 2.0,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/test/providers.test.ts -t "background music"`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers.ts src/test/providers.test.ts
git commit -m "feat: add background music settings to ProviderSettings"
```

---

### Task 2: Backend — track scanner helper + tracks endpoint

**Why a separate module:** `server/routes/render.ts` imports `../db.js`, which throws at import time when `DATABASE_URL` is unset and opens a PG pool. The existing test suite (`pipeline-concurrency.test.ts`) avoids importing server modules for exactly this reason. So the scanner lives in a DB-free helper module that the test can import cleanly.

**Files:**
- Create: `server/lib/bgMusic.ts`
- Modify: `server/routes/render.ts` (import helper, add route near `/failures` ~line 541)
- Test: `src/test/bgMusic.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces (from `server/lib/bgMusic.ts`):
  - `export function scanBgMusicTracks(dir: string): string[]` — returns sorted absolute paths of supported audio files in `dir`; returns `[]` if dir missing.
  - `export const BG_MUSIC_DIR: string` — `path.join(process.cwd(), "bg_music")`.
  - `GET /api/render/bgmusic/tracks` → `{ count: number, files: string[] }` where `files` are basenames.

- [ ] **Step 1: Write the failing test**

Create `src/test/bgMusic.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scanBgMusicTracks } from "../../server/lib/bgMusic";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bgmusic-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanBgMusicTracks", () => {
  it("returns [] when directory does not exist", () => {
    expect(scanBgMusicTracks(path.join(tmpDir, "nope"))).toEqual([]);
  });

  it("returns [] when directory is empty", () => {
    expect(scanBgMusicTracks(tmpDir)).toEqual([]);
  });

  it("returns only supported audio files, sorted, as absolute paths", () => {
    fs.writeFileSync(path.join(tmpDir, "b.mp3"), "x");
    fs.writeFileSync(path.join(tmpDir, "a.wav"), "x");
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "x");
    fs.writeFileSync(path.join(tmpDir, "c.MP3"), "x");
    const result = scanBgMusicTracks(tmpDir);
    expect(result.map(p => path.basename(p))).toEqual(["a.wav", "b.mp3", "c.MP3"]);
    expect(result.every(p => path.isAbsolute(p))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/bgMusic.test.ts`
Expected: FAIL — cannot resolve module `../../server/lib/bgMusic`.

- [ ] **Step 3: Create the helper module**

Create `server/lib/bgMusic.ts`:

```ts
import fs from "fs";
import path from "path";

export const BG_MUSIC_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"];

export const BG_MUSIC_DIR = path.join(process.cwd(), "bg_music");

/** Scan a directory for supported background-music files. Returns sorted absolute paths. */
export function scanBgMusicTracks(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => BG_MUSIC_EXTS.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Add the tracks endpoint**

In `server/routes/render.ts`, add the import near the top with the other lib imports (after `import { generateVeoClip } from "../lib/veo.js";`, line 9):

```ts
import { scanBgMusicTracks, BG_MUSIC_DIR } from "../lib/bgMusic.js";
```

Then add after the `/failures` route (~line 561):

```ts
/** GET /api/render/bgmusic/tracks — list available background-music files */
router.get("/bgmusic/tracks", (_req: Request, res: Response) => {
  const files = scanBgMusicTracks(BG_MUSIC_DIR).map(p => path.basename(p));
  res.json({ count: files.length, files });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/test/bgMusic.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/lib/bgMusic.ts server/routes/render.ts src/test/bgMusic.test.ts
git commit -m "feat: add bg_music track scanner and tracks endpoint"
```

---

### Task 3: Backend — applyBgMusic FFmpeg pass

**Files:**
- Modify: `server/routes/render.ts` (add `applyBgMusic` after `mergeVideo` ~line 1492)

**Interfaces:**
- Consumes: `scanBgMusicTracks` + `BG_MUSIC_DIR` (imported from `../lib/bgMusic.js` in Task 2 Step 4), `ffmpeg(args: string[]): Promise<void>` (existing, line 480)
- Produces: `async function applyBgMusic(videoPath: string, narrationVolume: number, bgMusicVolume: number): Promise<boolean>` — mixes a random track into `videoPath` in place; returns `true` if applied, `false` if skipped (no tracks).

- [ ] **Step 1: Implement applyBgMusic**

In `server/routes/render.ts`, add after `mergeVideo` (~line 1492, before `runAutoPipeline`):

```ts
/**
 * Post-process pass: mix a random bg_music/ track under the narration.
 * Video stream is copied untouched (-c:v copy). Music is looped to fill
 * the video length and trimmed to it (duration=first). Replaces videoPath
 * in place. Returns false (no-op) when no tracks are available.
 */
async function applyBgMusic(
  videoPath: string,
  narrationVolume: number,
  bgMusicVolume: number
): Promise<boolean> {
  const tracks = scanBgMusicTracks(BG_MUSIC_DIR);
  if (tracks.length === 0) {
    console.warn(`[bgmusic] no tracks in ${BG_MUSIC_DIR} — skipping`);
    return false;
  }
  const track = tracks[Math.floor(Math.random() * tracks.length)];
  const narrVol = narrationVolume.toFixed(4);
  const musicVol = bgMusicVolume.toFixed(4);
  const tmpOut = videoPath.replace(/\.mp4$/i, ".bgm.mp4");

  console.log(`[bgmusic] mixing "${path.basename(track)}" (music ${musicVol}, narr ${narrVol})`);

  await ffmpeg([
    "-y",
    "-i", videoPath,
    "-stream_loop", "-1", "-i", track,
    "-filter_complex",
      `[0:a]volume=${narrVol}[narr];` +
      `[1:a]volume=${musicVol}[music];` +
      `[narr][music]amix=inputs=2:duration=first:normalize=0[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    tmpOut,
  ]);

  fs.renameSync(tmpOut, videoPath);
  console.log(`[bgmusic] done → ${videoPath}`);
  return true;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run build` if no standalone tsconfig check)
Expected: no new type errors referencing `applyBgMusic`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/render.ts
git commit -m "feat: add applyBgMusic FFmpeg post-processing pass"
```

---

### Task 4: Backend — wire applyBgMusic into merge + auto routes

**Files:**
- Modify: `server/routes/render.ts` — merge route `POST /:id` (~line 860-898), `mergeVideo` signature (~line 1333), `runAutoPipeline` signature + auto route `POST /:id/auto` (~line 811-828, ~line 1498-1551)

**Interfaces:**
- Consumes: `applyBgMusic` (Task 3)
- Produces: `mergeVideo` and `runAutoPipeline` accept three extra trailing params `bgMusicEnabled: boolean`, `narrationVolume: number`, `bgMusicVolume: number` and call `applyBgMusic` after the merge completes.

- [ ] **Step 1: Extend `mergeVideo` to apply music**

In `server/routes/render.ts`, change the `mergeVideo` signature (line ~1333) to add three params after `veoAudioVolume = 0.03`:

```ts
async function mergeVideo(
  projectId: string,
  sceneList: any[],
  width: number,
  height: number,
  subtitleDelay = 0.8,
  overlayPosition = "bottom-left",
  overlayFont = "Tox Typewriter",
  overlayFontSize = 36,
  veoAudioVolume = 0.03,
  bgMusicEnabled = true,
  narrationVolume = 2.0,
  bgMusicVolume = 0.10
) {
```

Then, just before the final success block (`mergeJobs[projectId] = { status: "done", ... }` ~line 1489), insert:

```ts
  if (bgMusicEnabled) {
    try {
      await applyBgMusic(outPath, narrationVolume, bgMusicVolume);
    } catch (e: any) {
      console.error(`[bgmusic] ${projectId}: mixing failed, keeping music-free output:`, e.message);
    }
  }

```

(Note: `outPath` is in scope here — defined at line ~1418.)

- [ ] **Step 2: Pass new params from the merge route**

In the `POST /:id` handler, after the `mergeVeoAudioVolume` line (~line 884), add:

```ts
    const bgMusicEnabled = req.body?.bgMusicEnabled !== undefined ? !!req.body.bgMusicEnabled : true;
    const narrationVolume = req.body?.narrationVolume !== undefined ? parseFloat(req.body.narrationVolume) : 2.0;
    const bgMusicVolume = req.body?.bgMusicVolume !== undefined ? parseFloat(req.body.bgMusicVolume) : 0.10;
```

Then update the `mergeVideo(...)` call (~line 890) to pass them:

```ts
    mergeVideo(projectId, ready, W, H, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, mergeVeoAudioVolume, bgMusicEnabled, narrationVolume, bgMusicVolume).catch(e => {
```

- [ ] **Step 3: Extend `runAutoPipeline` to forward params**

In `server/routes/render.ts`, change the `runAutoPipeline` signature (~line 1498) to add three params after `veoAudioVolume = 0.03`:

```ts
async function runAutoPipeline(
  projectId: string,
  resKey: string,
  subtitleDelay = 0.8,
  overlayPosition = "bottom-left",
  overlayFont = "Tox Typewriter",
  overlayFontSize = 36,
  aspectRatio = "16:9",
  veoAudioVolume = 0.03,
  bgMusicEnabled = true,
  narrationVolume = 2.0,
  bgMusicVolume = 0.10
) {
```

Then update the `mergeVideo(...)` call inside `runAutoPipeline` (~line 1546) to forward them:

```ts
  await mergeVideo(projectId, ready, W, H, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, veoAudioVolume, bgMusicEnabled, narrationVolume, bgMusicVolume);
```

- [ ] **Step 4: Pass new params from the auto route**

In the `POST /:id/auto` handler, after the `autoVeoAudioVolume` line (~line 818), add:

```ts
  const autoBgMusicEnabled = req.body?.bgMusicEnabled !== undefined ? !!req.body.bgMusicEnabled : true;
  const autoNarrationVolume = req.body?.narrationVolume !== undefined ? parseFloat(req.body.narrationVolume) : 2.0;
  const autoBgMusicVolume = req.body?.bgMusicVolume !== undefined ? parseFloat(req.body.bgMusicVolume) : 0.10;
```

Then update the `runAutoPipeline(...)` call (~line 823) to pass them:

```ts
  runAutoPipeline(projectId, resKey, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, autoProjectAR, autoVeoAudioVolume, autoBgMusicEnabled, autoNarrationVolume, autoBgMusicVolume).catch(e => {
```

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/routes/render.ts
git commit -m "feat: wire bg music into merge and auto render pipelines"
```

---

### Task 5: Frontend — send bg music params in render requests

**Files:**
- Modify: `src/lib/api.ts:688-700` (`startRender`)

**Interfaces:**
- Consumes: `ProviderSettings.bgMusicEnabled/bgMusicVolume/narrationVolume` (Task 1)
- Produces: `startRender` includes `bgMusicEnabled`, `bgMusicVolume`, `narrationVolume` in the POST body.

- [ ] **Step 1: Add params to `startRender`**

In `src/lib/api.ts`, in `startRender` (~line 688), after `const veoAudioVolume = settings.veoAudioVolume ?? 0.03;` add:

```ts
  const bgMusicEnabled = settings.bgMusicEnabled ?? true;
  const bgMusicVolume = settings.bgMusicVolume ?? 0.10;
  const narrationVolume = settings.narrationVolume ?? 2.0;
```

Then update the body (~line 698):

```ts
    body: JSON.stringify({ resolution, subtitleDelay, overlayPosition, overlayFont, overlayFontSize, veoAudioVolume, bgMusicEnabled, bgMusicVolume, narrationVolume }),
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: send bg music params in startRender request"
```

---

### Task 6: Frontend — Background Music settings card

**Files:**
- Modify: `src/pages/Settings.tsx` (add state + card in the `providers` tab, after the Veo card ~line 576)

**Interfaces:**
- Consumes: `ProviderSettings` (Task 1), `GET /api/render/bgmusic/tracks` (Task 2)
- Produces: UI card with enable toggle, music-volume slider, narration-volume slider, and track count display.

- [ ] **Step 1: Add track-count state and fetcher**

In `src/pages/Settings.tsx`, after the `purgeLoading` state (~line 66) add:

```ts
  const [bgTrackCount, setBgTrackCount] = useState<number | null>(null);

  const fetchBgTracks = async () => {
    try {
      const res = await fetch("/api/render/bgmusic/tracks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBgTrackCount(data.count);
    } catch {
      setBgTrackCount(0);
    }
  };
```

- [ ] **Step 2: Fetch track count on mount**

In `src/pages/Settings.tsx`, add a `useEffect` right after the state declarations (~line 67). First ensure `useEffect` is imported — change line 1 from `import { useState } from "react";` to `import { useState, useEffect } from "react";`. Then add:

```ts
  useEffect(() => { fetchBgTracks(); }, []);
```

- [ ] **Step 3: Add the Background Music card**

In `src/pages/Settings.tsx`, in the `providers` tab, insert immediately after the closing `</Card>` of the "Veo Video Animation" card (~line 576, before the "Text-to-Speech" card):

```tsx
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Background Music</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-foreground">Enable Background Music</label>
                  <p className="text-xs text-muted-foreground">Mix a random track from the bg_music/ folder into the final video</p>
                </div>
                <Switch
                  checked={settings.bgMusicEnabled ?? true}
                  onCheckedChange={(checked) => setSettings(s => ({ ...s, bgMusicEnabled: checked }))}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Music Volume: {Math.round((settings.bgMusicVolume ?? 0.10) * 100)}%
                </label>
                <Slider
                  value={[settings.bgMusicVolume ?? 0.10]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, bgMusicVolume: v }))}
                  min={0.0} max={1.0} step={0.01}
                  disabled={!(settings.bgMusicEnabled ?? true)}
                />
                <p className="text-xs text-muted-foreground">Volume of the background track under the narration. Default: 10%.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Narration Volume: {Math.round((settings.narrationVolume ?? 2.0) * 100)}%
                </label>
                <Slider
                  value={[settings.narrationVolume ?? 2.0]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, narrationVolume: v }))}
                  min={0.5} max={3.0} step={0.1}
                  disabled={!(settings.bgMusicEnabled ?? true)}
                />
                <p className="text-xs text-muted-foreground">Boost applied to the narrator audio when music is mixed in. Default: 200%.</p>
              </div>

              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-muted-foreground">
                  {bgTrackCount === null
                    ? "Checking bg_music/ folder…"
                    : `${bgTrackCount} track${bgTrackCount === 1 ? "" : "s"} in bg_music/ — picks one at random per render`}
                </p>
                <Button variant="ghost" size="sm" className="text-xs h-7" onClick={fetchBgTracks}>
                  <RefreshCw className="h-3 w-3 mr-1" />Refresh
                </Button>
              </div>
            </CardContent>
          </Card>
```

(`Switch`, `Slider`, `Button`, `RefreshCw`, `Card*` are already imported in this file.)

- [ ] **Step 4: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: build succeeds, no new lint errors in `Settings.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat: add Background Music settings card"
```

---

### Task 7: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm tracks endpoint**

Ensure `bg_music/` contains at least one `.mp3`. Start the server (`npm run dev`), then:
Run: `curl -s http://localhost:5000/api/render/bgmusic/tracks` (use the configured PORT)
Expected: `{"count":<N>,"files":[...]}` with N ≥ 1.

- [ ] **Step 2: Verify UI**

Open Settings → Providers tab. Confirm the "Background Music" card shows, the track count matches the folder, toggling Enable disables both sliders, and Save persists (reload page → values stay).

- [ ] **Step 3: Render a project and confirm music**

Render any project with completed scenes to `output.mp4`. Then:
Run: `ffprobe -v error -show_entries stream=codec_type -of csv=p=0 uploads/<projectId>/render/output.mp4`
Expected: one `video` and one `audio` stream. Play the file — narration is prominent and music is audible underneath at ~10%.

- [ ] **Step 4: Verify skip path**

Disable Background Music in Settings, Save, re-render. Confirm `output.mp4` plays with narration only (no music), and server logs show no `[bgmusic]` mixing line (or the skip warning if folder empty).
