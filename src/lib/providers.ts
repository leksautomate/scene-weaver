// Frontend provider utilities — all API calls happen client-side

// ========================
// Settings helpers
// ========================

export interface CustomVoice {
  id: string;
  name: string;
}

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
  customVoices: CustomVoice[];
}

export interface InworldVoice {
  id: string;
  name: string;
  description: string;
}

export const INWORLD_VOICES: InworldVoice[] = [
  { id: "Dennis", name: "Dennis", description: "Male, warm baritone narrator" },
  { id: "James", name: "James", description: "Male, authoritative and deep" },
  { id: "Brian", name: "Brian", description: "Male, calm and neutral" },
  { id: "Marcus", name: "Marcus", description: "Male, strong and commanding" },
  { id: "Oliver", name: "Oliver", description: "Male, clear and professional" },
  { id: "Patrick", name: "Patrick", description: "Male, rich and dramatic" },
  { id: "Daniel", name: "Daniel", description: "Male, smooth and measured" },
  { id: "Morgan", name: "Morgan", description: "Neutral, steady documentary tone" },
  { id: "Eleanor", name: "Eleanor", description: "Female, elegant and composed" },
  { id: "Linda", name: "Linda", description: "Female, friendly and clear" },
  { id: "Amy", name: "Amy", description: "Female, youthful and energetic" },
  { id: "Sophia", name: "Sophia", description: "Female, warm and expressive" },
  { id: "Hannah", name: "Hannah", description: "Female, gentle and refined" },
  { id: "Rachel", name: "Rachel", description: "Female, confident and articulate" },
  { id: "Victoria", name: "Victoria", description: "Female, regal and authoritative" },
  { id: "Emma", name: "Emma", description: "Female, bright and engaging" },
];

export function getAvailableVoices(settings: ProviderSettings): InworldVoice[] {
  const custom: InworldVoice[] = (settings.customVoices || []).map(v => ({
    id: v.id,
    name: v.name,
    description: "Custom voice",
  }));
  return [...INWORLD_VOICES, ...custom];
}

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
  customVoices: [],
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

const BATCH_IMAGE_PROMPT = `You are a visual content director for a YouTube history documentary.

For each numbered scene below, generate ONE cinematic image prompt and THREE fallback prompts.

VISUAL STYLE:
- Cinematic historical realism, photographic documentary, Caravaggio-level contrast
- Images must feel like film stills from a prestige historical epic or documentary reconstruction photography
- No fantasy, no video game look, no cartoon, no neon, no sci-fi, no modern elements

PEOPLE — STRICT ANONYMITY:
- All figures must be anonymous: warriors, commanders, soldiers — never identifiable by face
- Faces must be obscured by helmets/hoods/shadow, turned away, silhouetted, or blurred by depth of field
- Represent characters through posture, armor, weapons, body language only

ENVIRONMENTS: historically grounded, physically worn, dusty, sun-baked, or battle-scarred
Include period-accurate details: spears, supply carts, banners, wooden shields, campfires, stone walls

LIGHTING: harsh midday sun, pre-dawn blue light, torch and fire glow, dust-filtered gold, sunset silhouettes, smoke-filtered combat light

COLOR: desaturated earth tones, bronze, iron, ochre, dust brown, deep reds and dark shadows

PROMPT STRUCTURE — each prompt must be exactly ONE sentence:
[Who is present] + [what they are doing] + [where they are] + [camera angle/framing] + [lighting and mood]

Every prompt MUST contain a CLEAR VISIBLE ACTION — never a static description.

CAMERA VARIETY — use a different angle for each scene, rotate through:
close-up of hands/weapons/eyes, medium shot of individual, wide shot of formations/terrain, over-the-shoulder, ground-level looking up, high angle, silhouette against sky, doorway/tent-entrance framing

HISTORICAL PERIOD ACCURACY — match weapons/armor/environment to the period in the video title:
- Early Islamic warfare: chainmail, curved swords, Arabian horses, desert terrain, turbans over armor
- Ancient Greek: bronze Corinthian helmets, hoplon shields, spear formations, open hillsides
- Mongol: composite bows on horseback, lamellar armor, open steppe
- Medieval Crusades: iron chainmail, kite shields, siege towers, walled city backgrounds
- Roman: lorica segmentata, scutum shields, formation marching, stone roads and fortifications

RESTRICTIONS: No text overlays, no identifiable faces, no fantasy/sci-fi/modern brands

Return ONLY valid JSON matching this exact schema:
{
  "scenes": [
    {
      "scene_number": 1,
      "scene_type": "character|location|crowd|battle_light|artifact|transition",
      "historical_period": "derived from title and scene context",
      "visual_priority": "character|environment|object",
      "image_prompt": "One complete cinematic sentence ending with a period.",
      "fallback_prompts": [
        "Fallback with different camera angle, one sentence.",
        "Fallback focusing on environment, one sentence.",
        "Fallback symbolic/aftermath angle, one sentence."
      ]
    }
  ]
}`;

export interface SceneSettings {
  sceneDuration: number; // seconds per scene at 2.5 words/sec speaking rate
}

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

function extractSentences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*)?|\n+/g) || [];
  const sentences = matches.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  return sentences.length > 0 ? sentences : [text];
}

/** Split script into scenes — 3 sentences per scene (smart) or 1 sentence (exact) */
export function splitScriptIntoScenes(
  script: string,
  sentencesPerScene: number = 3
): Array<{ scene_number: number; script_text: string }> {
  const sentences = extractSentences(script);
  const scenes: Array<{ scene_number: number; script_text: string }> = [];
  let sceneNum = 1;

  for (let i = 0; i < sentences.length; i += sentencesPerScene) {
    const group = sentences.slice(i, i + sentencesPerScene).join("").trim();
    if (group) scenes.push({ scene_number: sceneNum++, script_text: group });
  }
  return scenes.length > 0 ? scenes : [{ scene_number: 1, script_text: script }];
}

/** Duration-based scene splitter — groups sentences until speaking time target is reached */
export function splitScriptByDuration(
  script: string,
  sceneDuration: number = 6
): Array<{ scene_number: number; script_text: string }> {
  const WORDS_PER_SECOND = 2.5;
  const targetWords = sceneDuration * WORDS_PER_SECOND;
  const maxWords = Math.max(targetWords * 1.5, targetWords + 20);

  const sentences = extractSentences(script);
  const scenes: Array<{ scene_number: number; script_text: string }> = [];
  let sceneNum = 1;
  let currentSentences: string[] = [];
  let currentWords = 0;

  for (const sentence of sentences) {
    const wordCount = sentence.trim().split(/\s+/).length;
    if (currentWords > 0 && currentWords + wordCount > maxWords) {
      scenes.push({ scene_number: sceneNum++, script_text: currentSentences.join("").trim() });
      currentSentences = [sentence];
      currentWords = wordCount;
    } else {
      currentSentences.push(sentence);
      currentWords += wordCount;
      if (currentWords >= targetWords) {
        scenes.push({ scene_number: sceneNum++, script_text: currentSentences.join("").trim() });
        currentSentences = [];
        currentWords = 0;
      }
    }
  }
  if (currentSentences.length > 0) {
    const text = currentSentences.join("").trim();
    if (text) scenes.push({ scene_number: sceneNum++, script_text: text });
  }
  return scenes.length > 0 ? scenes : [{ scene_number: 1, script_text: script }];
}

/** Legacy chunk splitter — kept for backward compatibility */
export function splitScriptIntoChunks(script: string, maxWords = 800): string[] {
  const sentences = extractSentences(script);
  const chunks: string[] = [];
  let current = "";
  let wordCount = 0;

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).length;
    if (wordCount > 0 && wordCount + words > maxWords) {
      chunks.push(current.trim());
      current = sentence;
      wordCount = words;
    } else {
      current += sentence;
      wordCount += words;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [script];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface BatchPromptResult {
  scene_number: number;
  scene_type: string;
  historical_period: string;
  visual_priority: string;
  image_prompt: string;
  fallback_prompts: string[];
}

async function callGroqForBatch(
  title: string,
  scenes: Array<{ scene_number: number; script_text: string }>,
  groqApiKey: string,
  retryOnRateLimit = true
): Promise<BatchPromptResult[]> {
  const scenesText = scenes
    .map(s => `Scene ${s.scene_number}: "${s.script_text}"`)
    .join("\n");

  const userPrompt = `Video Title: ${title}\n\nGenerate image prompts for these ${scenes.length} scenes:\n\n${scenesText}\n\nReturn ONLY the JSON object.`;

  const result = await whiskProxy({
    action: "groq-chat",
    apiKey: groqApiKey,
    payload: {
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: BATCH_IMAGE_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 32000,
      response_format: { type: "json_object" },
    },
  });

  if (result.status && result.status >= 400) {
    const errText = typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data || {}).substring(0, 500);
    if (result.status === 429) {
      if (retryOnRateLimit) {
        console.log("[groq] Rate limited — waiting 15s before retry...");
        await delay(15000);
        return callGroqForBatch(title, scenes, groqApiKey, false);
      }
      throw new Error("Groq rate limited — try again in a moment.");
    }
    if (result.status === 401) throw new Error("Groq API key is invalid. Update it in Settings.");
    throw new Error(`Groq API error (HTTP ${result.status}): ${errText.substring(0, 200)}`);
  }

  const data = result.data;
  let content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from Groq");
  content = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(content);
  return parsed.scenes || [];
}

export async function generateScenesForChunk(
  title: string,
  chunk: string,
  _chunkIdx: number,
  _totalChunks: number,
  startSceneNumber: number,
  groqApiKey: string,
  splitMode: "smart" | "exact" | "duration" = "smart"
): Promise<SceneManifest[]> {
  const sceneChunks = (splitMode === "duration"
    ? splitScriptByDuration(chunk)
    : splitScriptIntoScenes(chunk, splitMode === "exact" ? 1 : 3)
  ).map((s, idx) => ({ ...s, scene_number: startSceneNumber + idx }));

  const prompts = await callGroqForBatch(title, sceneChunks, groqApiKey);

  return sceneChunks.map((sc, idx) => {
    const p = prompts[idx] || {} as BatchPromptResult;
    return {
      scene_number: sc.scene_number,
      scene_type: p.scene_type || "location",
      historical_period: p.historical_period || "",
      visual_priority: p.visual_priority || "environment",
      script_text: sc.script_text,
      tts_text: sc.script_text,
      image_prompt: p.image_prompt || "",
      fallback_prompts: p.fallback_prompts || [],
      image_file: `${sc.scene_number}.png`,
      audio_file: `${sc.scene_number}.mp3`,
    };
  });
}

export async function generateSceneManifest(
  title: string,
  script: string,
  _styleSummary: any,
  groqApiKey: string,
  splitMode: "smart" | "exact" | "duration" = "smart",
  onChunkProgress?: (current: number, total: number) => void
): Promise<SceneManifest[]> {
  const sceneChunks = splitMode === "duration"
    ? splitScriptByDuration(script)
    : splitScriptIntoScenes(script, splitMode === "exact" ? 1 : 3);

  const BATCH_SIZE = 30;
  const totalBatches = Math.ceil(sceneChunks.length / BATCH_SIZE);
  const allScenes: SceneManifest[] = [];

  for (let i = 0; i < sceneChunks.length; i += BATCH_SIZE) {
    if (i > 0) await delay(2000);

    const batch = sceneChunks.slice(i, i + BATCH_SIZE);
    const batchIdx = Math.floor(i / BATCH_SIZE);
    const prompts = await callGroqForBatch(title, batch, groqApiKey);

    const merged: SceneManifest[] = batch.map((sc, idx) => {
      const p = prompts[idx] || {} as BatchPromptResult;
      return {
        scene_number: sc.scene_number,
        scene_type: p.scene_type || "location",
        historical_period: p.historical_period || "",
        visual_priority: p.visual_priority || "environment",
        script_text: sc.script_text,
        tts_text: sc.script_text,
        image_prompt: p.image_prompt || "",
        fallback_prompts: p.fallback_prompts || [],
        image_file: `${sc.scene_number}.png`,
        audio_file: `${sc.scene_number}.mp3`,
      };
    });

    allScenes.push(...merged);
    onChunkProgress?.(batchIdx + 1, totalBatches);
  }

  return allScenes;
}

// ========================
// Whisk — Image generation
// ========================

async function whiskProxy(body: any): Promise<any> {
  const res = await fetch(`/api/whisk-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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




export async function generateWhiskImage(
  prompt: string,
  cookie: string,
  styleImageUrls?: string[],
  projectId?: string
): Promise<Blob> {
  const genResult = await whiskProxy({
    action: "generate",
    cookie,
    projectId,
    payload: {
      userInput: { candidatesCount: 1, prompts: [prompt] },
      aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
    },
  });

  if (genResult.status && genResult.status >= 400) {
    const detail = JSON.stringify(genResult.data || genResult).substring(0, 300);
    console.error(`Whisk generate error ${genResult.status}:`, detail);
    if (genResult.status === 429) throw new Error("Whisk rate limited — wait a minute and try again.");
    if (genResult.status === 401 || genResult.status === 403) throw new Error("Whisk auth expired. Update your Whisk Cookie in Settings.");
    throw new Error(`Whisk failed (${genResult.status}): ${detail}`);
  }

  const encodedImage = genResult.data?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage;
  if (!encodedImage) throw new Error("No image in Whisk response");

  return base64ToBlob(encodedImage);
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
  _styleSummary?: any
): Promise<string> {
  const result = await whiskProxy({
    action: "groq-chat",
    apiKey: groqApiKey,
    payload: {
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: `You are a visual content director generating a single image prompt for a YouTube history documentary scene.

PROMPT STRUCTURE (exactly one sentence):
[Who is present] + [what they are doing] + [where they are] + [camera angle/framing] + [lighting and mood]

STYLE RULES:
- Cinematic historical realism, photographic documentary, Caravaggio-level contrast
- All figures anonymous: silhouettes, backs turned, faces obscured by helmets/hoods/shadow/dust
- Historically grounded environments: dusty, sun-baked, battle-scarred, period-accurate details
- Clear visible action — never a static description
- Camera options: close-up of hands/weapons, medium shot, wide battlefield, over-the-shoulder, ground-level, high angle, silhouette shot
- Lighting: harsh midday sun, pre-dawn blue, torch/fire glow, dust-filtered gold, sunset silhouette
- Color: desaturated earth tones, bronze, ochre, dust brown, deep reds

RESTRICTIONS: No text overlays, no identifiable faces, no fantasy/sci-fi/modern elements.

Return ONLY the prompt text — one sentence ending with a period. No JSON, no markdown, no explanation.`,
        },
        {
          role: "user",
          content: `Script text to visualize:\n${scriptText}\n\nGenerate one cinematic image prompt for this scene.`,
        },
      ],
      temperature: 0.5,
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
