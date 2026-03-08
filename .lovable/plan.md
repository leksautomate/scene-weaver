

## Plan: Whisk Integration, Inworld TTS, and ZIP Download

### Overview
Three new capabilities: (1) Whisk image generation via Google cookie, (2) real TTS audio via Inworld API, (3) ZIP download edge function. Two new secrets needed: `WHISK_COOKIE` and `INWORLD_API_KEY`.

---

### 1. Secrets Required

- **WHISK_COOKIE** — Google account cookie from labs.google (for Whisk image generation)
- **INWORLD_API_KEY** — Inworld TTS API key (Base64 encoded, used as `Basic {key}` auth header)

Both will be requested via the secrets tool before implementation proceeds.

---

### 2. Whisk Image Provider (in Edge Functions)

Replicate the Whisk API flow directly in Deno (no npm package needed). The flow from the reverse-engineered source:

1. **Get auth token**: `GET https://labs.google/fx/api/auth/session` with `cookie` header → returns `access_token`
2. **Create project**: `POST https://labs.google/fx/api/trpc/media.createOrUpdateWorkflow` with cookie → returns `workflowId`
3. **Generate image**: `POST https://aisandbox-pa.googleapis.com/v1:runImageFx` with Bearer token, prompt, model `IMAGEN_3_5`, aspect ratio `LANDSCAPE` → returns `encodedImage` (base64)
4. Decode base64 image → upload to storage as PNG

Add a `generateWhiskImage(prompt, cookie)` function to both `create-project` and `regenerate-asset` edge functions. Selected when `imageProvider === "whisk"`.

---

### 3. Inworld TTS Integration (in Edge Functions)

Based on the provided API docs:

```
POST https://api.inworld.ai/tts/v1/voice
Authorization: Basic {INWORLD_API_KEY}
Content-Type: application/json

{
  "text": "scene narration text",
  "voiceId": "Dennis",
  "modelId": "inworld-tts-1.5-max",
  "audioConfig": { "audioEncoding": "MP3", "sampleRateHertz": 22050 },
  "temperature": 1.0,
  "applyTextNormalization": "ON"
}
```

Response: `{ audioContent: "<base64 WAV/MP3>" }`

- Decode base64 `audioContent` → upload as `{sceneNumber}.mp3` to storage
- Use `voiceId` and `modelId` from project settings (defaults: `Dennis`, `inworld-tts-1.5-max`)
- Falls back to mock audio if `INWORLD_API_KEY` not set
- Retry once on failure

---

### 4. ZIP Download Edge Function

New edge function: `download-project`

- Takes `projectId` query param
- Lists all files in `project-assets/{projectId}/` from storage
- Downloads each file, builds a ZIP in memory using a simple ZIP implementation (no archiver in Deno — use a lightweight approach or stream concatenation)
- Returns ZIP as `application/zip` response with `Content-Disposition` header

Register in `supabase/config.toml` with `verify_jwt = false`.

---

### 5. Settings Page Update

Update `Settings.tsx`:
- Add TTS provider selector (Inworld / Mock)
- Update voice ID placeholder to show "Dennis" as default
- Update model ID placeholder to show "inworld-tts-1.5-max"
- Pass `voiceId` and `modelId` through to project creation

---

### 6. Edge Function Updates

**`create-project/index.ts`**:
- Add `generateWhiskImage()` function
- Add `generateInworldAudio()` function  
- Route image generation through provider: `ai` → Lovable AI, `whisk` → Whisk API, `mock` → SVG
- Route audio generation through Inworld when API key is available, else mock
- Read `voiceId`/`modelId` from form data

**`regenerate-asset/index.ts`**:
- Same Whisk + Inworld functions added
- Check project settings for provider selection

---

### Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/functions/download-project/index.ts` | Create — ZIP download |
| `supabase/functions/create-project/index.ts` | Modify — add Whisk + Inworld |
| `supabase/functions/regenerate-asset/index.ts` | Modify — add Whisk + Inworld |
| `supabase/config.toml` | Modify — add download-project function |
| `src/pages/Settings.tsx` | Modify — TTS settings |
| `src/components/ProjectForm.tsx` | Modify — pass voiceId/modelId |

### Implementation Order
1. Request `WHISK_COOKIE` and `INWORLD_API_KEY` secrets
2. Create `download-project` edge function
3. Update `create-project` with Whisk + Inworld
4. Update `regenerate-asset` with Whisk + Inworld
5. Update Settings page and ProjectForm

