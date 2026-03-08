// Frontend provider utilities — all API calls happen client-side

// ========================
// Settings helpers
// ========================

export interface ProviderSettings {
  imageProvider: string;
  ttsProvider: string;
  voiceId: string;
  modelId: string;
  imageConcurrency: number;
  audioConcurrency: number;
  groqApiKey: string;
  whiskCookie: string;
  inworldApiKey: string;
}

export interface InworldVoice {
  id: string;
  name: string;
  description: string;
}

export const INWORLD_VOICES: InworldVoice[] = [
  { id: "Dennis", name: "Dennis", description: "Male, warm baritone narrator" },
  { id: "Eleanor", name: "Eleanor", description: "Female, elegant and composed" },
  { id: "James", name: "James", description: "Male, authoritative and deep" },
  { id: "Linda", name: "Linda", description: "Female, friendly and clear" },
  { id: "Brian", name: "Brian", description: "Male, calm and neutral" },
  { id: "Amy", name: "Amy", description: "Female, youthful and energetic" },
];

const DEFAULTS: ProviderSettings = {
  imageProvider: "ai",
  ttsProvider: "inworld",
  voiceId: "Dennis",
  modelId: "inworld-tts-1.5-max",
  imageConcurrency: 2,
  audioConcurrency: 2,
  groqApiKey: "",
  whiskCookie: "",
  inworldApiKey: "",
};

export function loadProviderSettings(): ProviderSettings {
  try {
    const raw = localStorage.getItem("historia-settings");
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveProviderSettings(settings: ProviderSettings) {
  localStorage.setItem("historia-settings", JSON.stringify(settings));
}

// ========================
// Groq — Scene manifest generation
// ========================

const SCENE_SYSTEM_PROMPT = `You are a cinematic scene breakdown specialist for historical documentary content.

Given a title, script, and style summary, split the script into visual narrative scenes.

Rules:
- Create 1 scene per 2-4 sentences, splitting when location, action, or emotional beat changes
- Keep scene_number sequential from 1
- Keep people anonymous - use generic roles (ruler, soldier, merchant, monk, peasant)
- No celebrity likenesses
- Generate cinematic, realistic, documentary-like image prompts
- Maintain the exact style summary in every prompt
- Convert abstract ideas into visible moments
- Produce 3 fallback prompts per scene (progressively simpler)
- Assign scene_type: character | location | crowd | battle_light | artifact | transition
- Assign historical_period
- Assign visual_priority: character | environment | object
- image_file = {scene_number}.png, audio_file = {scene_number}.mp3
- tts_text should be the narration for that scene
- All image prompts must end with style keywords like "cinematic realism, historical atmosphere"

Replace famous individuals with generic descriptions:
- anonymous ruler, military commander, court official, monk, merchant, soldier, peasant, noblewoman, worker, crowd of townspeople

Return ONLY valid JSON matching this exact schema:
{
  "scenes": [
    {
      "scene_number": 1,
      "scene_type": "location",
      "historical_period": "ancient rome",
      "visual_priority": "environment",
      "script_text": "original script chunk",
      "tts_text": "narration text",
      "image_prompt": "detailed cinematic prompt",
      "fallback_prompts": ["simpler prompt", "environmental prompt", "symbolic prompt"],
      "image_file": "1.png",
      "audio_file": "1.mp3"
    }
  ]
}`;

export interface SceneManifest {
  scene_number: number;
  scene_type: string;
  historical_period: string;
  visual_priority: string;
  script_text: string;
  tts_text: string;
  image_prompt: string;
  fallback_prompts: string[];
  image_file: string;
  audio_file: string;
}

export async function generateSceneManifest(
  title: string,
  script: string,
  styleSummary: any,
  groqApiKey: string
): Promise<SceneManifest[]> {
  const userPrompt = `Title: ${title}\nMode: history\n\nStyle Summary:\n${JSON.stringify(styleSummary, null, 2)}\n\nFull Script:\n${script}\n\nSplit this into scenes. Return ONLY the JSON object.`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SCENE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from Groq");
  content = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  return JSON.parse(content).scenes || [];
}

// ========================
// Whisk — Image generation
// ========================

// Upload an image to Whisk and get a media generation ID for use as a reference
async function uploadToWhisk(imageBlob: Blob, cookie: string, accessToken: string): Promise<string> {
  const base64 = await blobToBase64(imageBlob);
  const uploadRes = await fetch("https://labs.google/fx/api/trpc/backbone.uploadImage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      json: {
        imageBytes: base64,
        mimeType: imageBlob.type || "image/png",
      },
    }),
  });
  if (!uploadRes.ok) throw new Error(`Whisk upload failed: ${uploadRes.status}`);
  const uploadData = await uploadRes.json();
  const mediaId = uploadData?.result?.data?.json?.mediaGenerationId;
  if (!mediaId) throw new Error("No mediaGenerationId from Whisk upload");
  return mediaId;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Fetch a style reference image from Supabase storage as a Blob
async function fetchStyleBlob(projectId: string, filename: string): Promise<Blob | null> {
  try {
    const url = getStyleRefUrl(projectId, filename);
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

function getStyleRefUrl(projectId: string, filename: string): string {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  return `${SUPABASE_URL}/storage/v1/object/public/project-assets/${projectId}/style/${filename}`;
}

export async function generateWhiskImage(
  prompt: string,
  cookie: string,
  styleImageUrls?: string[]
): Promise<Blob> {
  // Step 1: Get auth token
  const sessionRes = await fetch("https://labs.google/fx/api/auth/session", {
    headers: { cookie },
  });
  if (!sessionRes.ok) throw new Error(`Whisk session failed: ${sessionRes.status}`);
  const session = await sessionRes.json();
  const accessToken = session?.access_token;
  if (!accessToken) throw new Error("No access_token in Whisk session");

  // Step 2: Upload style reference images if provided
  const styleMediaIds: string[] = [];
  if (styleImageUrls && styleImageUrls.length > 0) {
    for (const url of styleImageUrls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const blob = await res.blob();
        const mediaId = await uploadToWhisk(blob, cookie, accessToken);
        styleMediaIds.push(mediaId);
      } catch (e: any) {
        console.warn(`Failed to upload style ref: ${e.message}`);
      }
    }
  }

  // Step 3: Generate image — use Recipe endpoint if we have style refs, otherwise plain ImageFx
  if (styleMediaIds.length > 0) {
    // Use runImageRecipe with style references
    const recipeMediaInputs = styleMediaIds.map(id => ({
      mediaInput: {
        mediaCategory: "MEDIA_CATEGORY_STYLE",
        mediaGenerationId: id,
      },
    }));

    const genRes = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        clientContext: {
          sessionId: String(Date.now()),
          tool: "BACKBONE",
          workflowId: crypto.randomUUID(),
        },
        imageModelSettings: {
          modelNameType: "IMAGEN_3_5",
          imageAspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
        },
        recipeMediaInputs,
        additionalInput: prompt,
        seed: null,
      }),
    });

    if (!genRes.ok) {
      const errText = await genRes.text();
      throw new Error(`Whisk recipe generation failed: ${genRes.status} - ${errText}`);
    }

    const genData = await genRes.json();
    const encodedImage = genData?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage
      || genData?.results?.[0]?.encodedImage;
    if (!encodedImage) throw new Error("No image in Whisk recipe response");

    const binary = atob(encodedImage);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  } else {
    // Fallback: plain text-to-image via runImageFx
    const genRes = await fetch("https://aisandbox-pa.googleapis.com/v1:runImageFx", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        userInput: { candidatesCount: 1, prompts: [prompt] },
        generationParams: { seed: null },
        clientContext: { tool: "WHISK" },
        modelInput: { modelNameType: "IMAGEN_3_5" },
        aspectRatio: "LANDSCAPE",
      }),
    });

    if (!genRes.ok) {
      const errText = await genRes.text();
      throw new Error(`Whisk generation failed: ${genRes.status} - ${errText}`);
    }

    const genData = await genRes.json();
    const encodedImage = genData?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage;
    if (!encodedImage) throw new Error("No image in Whisk response");

    const binary = atob(encodedImage);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  }
}

// ========================
// Inworld — TTS audio
// ========================

export async function generateInworldAudio(
  text: string,
  inworldApiKey: string,
  voiceId = "Dennis",
  modelId = "inworld-tts-1.5-max"
): Promise<Blob> {
  const response = await fetch("https://api.inworld.ai/tts/v1/voice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${inworldApiKey}`,
    },
    body: JSON.stringify({
      text: text.substring(0, 2000),
      voiceId,
      modelId,
      audioConfig: { audioEncoding: "MP3", sampleRateHertz: 22050 },
      temperature: 1.0,
      applyTextNormalization: "ON",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Inworld TTS failed: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const audioContent = data.audioContent;
  if (!audioContent) throw new Error("No audioContent in Inworld response");

  const binary = atob(audioContent);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "audio/mpeg" });
}

// ========================
// Groq — Regenerate image prompt
// ========================

export async function regenerateImagePrompt(
  scriptText: string,
  groqApiKey: string,
  styleSummary?: any
): Promise<string> {
  const style = styleSummary || {
    palette: "desaturated, muted, slightly dark, historical documentary tone",
    lighting: "natural window light, candlelight, torchlight, overcast daylight",
    framing: "wide establishing shots, over-the-shoulder views, close details",
    people: "anonymous figures, obscured faces, silhouettes, backs turned",
    mood: "tense, reflective, investigative, cinematic",
    historicalLook: "realistic period atmosphere, grounded environments",
  };

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are an expert at writing image generation prompts for historical documentary scenes. Given a script text and style guide, produce a single detailed cinematic image prompt. Keep people anonymous (no names/faces). End with style keywords. Return ONLY the prompt text, no JSON or markdown.`,
        },
        {
          role: "user",
          content: `Script: ${scriptText}\n\nStyle Guide:\n${JSON.stringify(style, null, 2)}\n\nGenerate one detailed image prompt.`,
        },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from Groq");
  return content.trim();
}

// ========================
// Mock fallbacks
// ========================

export function generateMockSVG(sceneNumber: number, prompt: string): Blob {
  const truncated = prompt.substring(0, 60) + (prompt.length > 60 ? "..." : "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" /><stop offset="100%" style="stop-color:#16213e;stop-opacity:1" /></linearGradient></defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <text x="640" y="300" font-family="serif" font-size="72" fill="#c9a84c" text-anchor="middle" font-weight="bold">${sceneNumber}</text>
  <text x="640" y="380" font-family="sans-serif" font-size="18" fill="#888" text-anchor="middle">MOCK IMAGE</text>
  <text x="640" y="430" font-family="sans-serif" font-size="14" fill="#666" text-anchor="middle">${truncated.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>
</svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
}

export function generateMockAudio(): Blob {
  const header = new Uint8Array([
    0xFF, 0xFB, 0x90, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < 38; i++) frames.push(header);
  const total = frames.reduce((s, f) => s + f.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) { result.set(f, offset); offset += f.length; }
  return new Blob([result], { type: "audio/mpeg" });
}
