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

const SCENE_SYSTEM_PROMPT_SMART = `You are a cinematic scene breakdown specialist for historical documentary content.

Given a title, script, and style summary, split the script into visual narrative scenes.

CRITICAL STYLE CONSISTENCY RULES:
- Every image_prompt MUST begin with a style anchor block that describes the exact same visual style for ALL scenes. This ensures the AI image generator produces a visually cohesive set.
- The style anchor block should be derived from the style summary and must appear VERBATIM at the start of every image_prompt. Format: "In the style of [palette], [lighting], [mood], [historicalLook]. "
- After the style anchor, describe the specific scene content.
- All characters must be described with the SAME consistent descriptors across scenes (e.g., if a ruler appears in scene 1 as "a tall bearded ruler in dark robes", use that EXACT description in every scene featuring that character).
- Maintain consistent color palette, lighting quality, and artistic medium across all prompts.
- Reference the uploaded style images by describing their visual qualities (texture, color grading, composition style) in the style anchor.

Rules:
- Create 1 scene per 2-4 sentences, splitting when location, action, or emotional beat changes`;

const SCENE_SYSTEM_PROMPT_EXACT = `You are a cinematic scene breakdown specialist for historical documentary content.

Given a title, script, and style summary, split the script into visual narrative scenes.

CRITICAL STYLE CONSISTENCY RULES:
- Every image_prompt MUST begin with a style anchor block that describes the exact same visual style for ALL scenes. This ensures the AI image generator produces a visually cohesive set.
- The style anchor block should be derived from the style summary and must appear VERBATIM at the start of every image_prompt. Format: "In the style of [palette], [lighting], [mood], [historicalLook]. "
- After the style anchor, describe the specific scene content.
- All characters must be described with the SAME consistent descriptors across scenes (e.g., if a ruler appears in scene 1 as "a tall bearded ruler in dark robes", use that EXACT description in every scene featuring that character).
- Maintain consistent color palette, lighting quality, and artistic medium across all prompts.
- Reference the uploaded style images by describing their visual qualities (texture, color grading, composition style) in the style anchor.

Rules:
- Create 1 scene per paragraph boundary. Each paragraph in the script becomes its own scene.`;

const SCENE_SYSTEM_PROMPT_COMMON = `- Keep scene_number sequential from 1
- Keep people anonymous - use generic roles (ruler, soldier, merchant, monk, peasant) but give them CONSISTENT physical descriptions throughout
- No celebrity likenesses
- Generate cinematic, realistic, documentary-like image prompts
- Convert abstract ideas into visible moments
- Produce 3 fallback prompts per scene (each fallback must ALSO include the style anchor block)
- Assign scene_type: character | location | crowd | battle_light | artifact | transition
- Assign historical_period
- Assign visual_priority: character | environment | object
- image_file = {scene_number}.png, audio_file = {scene_number}.mp3
- tts_text must be IDENTICAL to script_text — do not rephrase, rewrite, or summarize
- All image prompts must end with style keywords like "cinematic realism, historical atmosphere, consistent art style"

Replace famous individuals with generic descriptions:
- anonymous ruler, military commander, court official, monk, merchant, soldier, peasant, noblewoman, worker, crowd of townspeople
- Give each recurring character a FIXED visual description (age, build, clothing, distinguishing features) and reuse it exactly

Return ONLY valid JSON matching this exact schema:
{
  "style_anchor": "The exact style prefix used in all prompts, derived from style summary",
  "character_descriptions": {"ruler": "tall bearded man in dark crimson robes, mid-50s", ...},
  "scenes": [
    {
      "scene_number": 1,
      "scene_type": "location",
      "historical_period": "ancient rome",
      "visual_priority": "environment",
      "script_text": "original script chunk",
      "tts_text": "narration text",
      "image_prompt": "[style_anchor] detailed cinematic prompt with consistent character descriptions",
      "fallback_prompts": ["[style_anchor] simpler prompt", "[style_anchor] environmental prompt", "[style_anchor] symbolic prompt"],
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
  groqApiKey: string,
  splitMode: "smart" | "exact" = "smart"
): Promise<SceneManifest[]> {
  const systemPrompt = (splitMode === "exact" ? SCENE_SYSTEM_PROMPT_EXACT : SCENE_SYSTEM_PROMPT_SMART) + "\n" + SCENE_SYSTEM_PROMPT_COMMON;
  const userPrompt = `Title: ${title}\nMode: history\n\nStyle Summary (use this to build the style anchor for ALL prompts):\n${JSON.stringify(styleSummary, null, 2)}\n\nFull Script:\n${script}\n\nSplit this into scenes. Every image_prompt and fallback_prompt MUST start with the same style anchor prefix. Return ONLY the JSON object.`;

  const result = await whiskProxy({
    action: "groq-chat",
    apiKey: groqApiKey,
    payload: {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    },
  });

  if (result.status && result.status >= 400) {
    const errText = typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data || {}).substring(0, 500);
    if (result.status === 429) throw new Error("Groq rate limited — wait a moment and try again.");
    if (result.status === 401) throw new Error("Groq API key is invalid. Update it in Settings.");
    throw new Error(`Groq API error (HTTP ${result.status}): ${errText.substring(0, 200)}`);
  }

  const data = result.data;
  let content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from Groq");
  content = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(content);
  
  // If the LLM returned a style_anchor, ensure every prompt includes it
  const styleAnchor = parsed.style_anchor || "";
  const scenes: SceneManifest[] = parsed.scenes || [];
  
  if (styleAnchor) {
    for (const scene of scenes) {
      if (!scene.image_prompt.includes(styleAnchor)) {
        scene.image_prompt = `${styleAnchor} ${scene.image_prompt}`;
      }
      if (scene.fallback_prompts) {
        scene.fallback_prompts = scene.fallback_prompts.map((p: string) =>
          p.includes(styleAnchor) ? p : `${styleAnchor} ${p}`
        );
      }
    }
  }
  
  return scenes;
}

// ========================
// Whisk — Image generation
// ========================

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

async function whiskProxy(body: any): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/whisk-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisk proxy error (HTTP ${res.status}): ${errText.substring(0, 200)}`);
  }
  return res.json();
}

// Create a Whisk project/workflow and return the workflowId
async function createWhiskProject(cookie: string): Promise<string> {
  const result = await whiskProxy({
    action: "create-project",
    cookie,
    payload: { name: "Historia-" + Date.now() },
  });
  if (result.status && result.status >= 400) {
    throw new Error(`Whisk create-project failed (${result.status}): ${JSON.stringify(result.data).substring(0, 300)}`);
  }
  const workflowId = result.data?.workflowId;
  if (!workflowId) throw new Error(`No workflowId from Whisk. Response: ${JSON.stringify(result.data).substring(0, 300)}`);
  return workflowId;
}

// Caption an image via Whisk's backbone.captionImage
async function captionWhiskImage(
  rawBytes: string,
  mediaCategory: string,
  workflowId: string,
  cookie: string
): Promise<string> {
  const result = await whiskProxy({
    action: "caption-image",
    cookie,
    payload: { rawBytes, mediaCategory, workflowId },
  });
  if (result.status && result.status >= 400) {
    console.warn(`Whisk caption failed (${result.status}), using empty caption`);
    return "";
  }
  const caption = result.data?.candidates?.[0]?.output || "";
  return caption;
}

// Upload an image to Whisk and get a media generation ID for use as a reference
async function uploadToWhisk(
  rawBytes: string,
  caption: string,
  mediaCategory: string,
  workflowId: string,
  cookie: string
): Promise<string> {
  const result = await whiskProxy({
    action: "upload",
    cookie,
    payload: { rawBytes, caption, mediaCategory, workflowId },
  });
  if (result.status && result.status >= 400) {
    throw new Error(`Whisk upload failed (${result.status}): ${JSON.stringify(result.data).substring(0, 300)}`);
  }
  const mediaId = result.data?.uploadMediaGenerationId;
  if (!mediaId) throw new Error(`No uploadMediaGenerationId from Whisk. Response: ${JSON.stringify(result.data).substring(0, 300)}`);
  return mediaId;
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
  // Step 1: Get auth token via proxy
  const sessionResult = await whiskProxy({ action: "session", cookie });
  if (sessionResult.status === 401 || sessionResult.status === 403) {
    throw new Error("Whisk cookie expired or invalid. Go to Settings and update your Whisk Cookie (copy fresh from labs.google).");
  }
  if (sessionResult.status && sessionResult.status >= 400) {
    throw new Error(`Whisk session failed (HTTP ${sessionResult.status}). Check your Whisk Cookie in Settings.`);
  }
  const accessToken = sessionResult?.data?.access_token;
  if (!accessToken) throw new Error("No access_token in Whisk session — cookie may be expired. Update it in Settings.");

  // Step 2: If we have style refs, use the full Whisk recipe flow
  if (styleImageUrls && styleImageUrls.length > 0) {
    // 2a. Create a Whisk project
    const workflowId = await createWhiskProject(cookie);
    console.log(`[whisk] Created project: ${workflowId}`);

    // 2b. For each style ref: fetch → base64 → caption → upload → get mediaId
    const styleRefs: { mediaGenerationId: string; caption: string }[] = [];
    for (const url of styleImageUrls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const blob = await res.blob();
        const rawBytes = await blobToBase64DataUrl(blob);

        // Caption the image
        const caption = await captionWhiskImage(
          rawBytes, "MEDIA_CATEGORY_STYLE", workflowId, cookie
        );
        console.log(`[whisk] Captioned style ref: ${caption.substring(0, 80)}`);

        // Upload with caption
        const mediaId = await uploadToWhisk(
          rawBytes, caption, "MEDIA_CATEGORY_STYLE", workflowId, cookie
        );
        console.log(`[whisk] Uploaded style ref, mediaId: ${mediaId}`);

        styleRefs.push({ mediaGenerationId: mediaId, caption });
      } catch (e: any) {
        console.warn(`Failed to process style ref: ${e.message}`);
      }
    }

    // 2c. Generate with references using runImageRecipe
    const recipeMediaInputs = styleRefs.map(ref => ({
      caption: ref.caption,
      mediaInput: {
        mediaCategory: "MEDIA_CATEGORY_STYLE",
        mediaGenerationId: ref.mediaGenerationId,
      },
    }));

    const genResult = await whiskProxy({
      action: "generate-recipe",
      accessToken,
      payload: {
        clientContext: {
          workflowId,
          tool: "BACKBONE",
        },
        imageModelSettings: {
          imageModel: "GEM_PIX",
          aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
        },
        userInstruction: prompt,
        recipeMediaInputs,
        seed: 0,
      },
    });

    if (genResult.status && genResult.status >= 400) {
      const detail = JSON.stringify(genResult.data).substring(0, 300);
      console.error(`Whisk recipe error ${genResult.status}:`, detail);
      if (genResult.status === 429) throw new Error("Whisk rate limited — wait a minute and try again.");
      if (genResult.status === 401 || genResult.status === 403) throw new Error("Whisk auth expired. Update your Whisk Cookie in Settings.");
      throw new Error(`Whisk recipe failed (${genResult.status}): ${detail}`);
    }

    const encodedImage = genResult.data?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage;
    if (!encodedImage) throw new Error("No image in Whisk recipe response");

    return base64ToBlob(encodedImage);
  } else {
    // Plain text-to-image via ImageFx
    const genResult = await whiskProxy({
      action: "generate",
      accessToken,
      payload: {
        userInput: { candidatesCount: 1, prompts: [prompt], seed: 0 },
        clientContext: { sessionId: String(Date.now()), tool: "IMAGE_FX" },
        modelInput: { modelNameType: "IMAGEN_3_5" },
        aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
      },
    });

    if (genResult.status && genResult.status >= 400) {
      const detail = JSON.stringify(genResult.data).substring(0, 300);
      console.error(`Whisk generate error ${genResult.status}:`, detail);
      if (genResult.status === 429) throw new Error("Whisk rate limited — wait a minute and try again.");
      if (genResult.status === 401 || genResult.status === 403) throw new Error("Whisk auth expired. Update your Whisk Cookie in Settings.");
      throw new Error(`Whisk failed (${genResult.status}): ${detail}`);
    }

    const encodedImage = genResult.data?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage;
    if (!encodedImage) throw new Error("No image in Whisk response");

    return base64ToBlob(encodedImage);
  }
}

// Convert blob to data URL (data:image/...;base64,...) for Whisk API
async function blobToBase64DataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const mimeType = blob.type || "image/png";
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function base64ToBlob(encodedImage: string): Blob {
  const binary = atob(encodedImage);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
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
    if (response.status === 429) throw new Error("Inworld rate limited — wait and retry.");
    if (response.status === 401 || response.status === 403) throw new Error("Inworld API key is invalid. Update it in Settings.");
    throw new Error(`Inworld TTS failed (HTTP ${response.status}): ${errText.substring(0, 200)}`);
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

  const result = await whiskProxy({
    action: "groq-chat",
    apiKey: groqApiKey,
    payload: {
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are an expert at writing image generation prompts for historical documentary scenes. Given a script text and style guide, produce a single detailed cinematic image prompt. 

CRITICAL: Start the prompt with a style anchor derived from the style guide (palette, lighting, mood, medium). This ensures visual consistency with other scenes in the project. Keep people anonymous (no names/faces) but give them consistent physical descriptions. End with style keywords. Return ONLY the prompt text, no JSON or markdown.`,
        },
        {
          role: "user",
          content: `Script: ${scriptText}\n\nStyle Guide:\n${JSON.stringify(style, null, 2)}\n\nGenerate one detailed image prompt that starts with a style anchor prefix matching this style guide.`,
        },
      ],
      temperature: 0.4,
    },
  });

  if (result.status && result.status >= 400) {
    const errText = typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data || {}).substring(0, 500);
    throw new Error(`Groq error: ${result.status} - ${errText}`);
  }

  const data = result.data;
  const content = data?.choices?.[0]?.message?.content;
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
