import { execSync } from "child_process";
import path from "path";

export const PROJECT_ID = process.env.VERTEX_PROJECT_ID || "project-f3847793-8610-4a16-945";

// BytePlus Ark (Seedream) endpoint used for all image generation
const ARK_IMAGE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
const ARK_API_KEY = process.env.ARK_API_KEY;

// Fallback chain — tried in order, falling through to the next model on any failure.
// Live-tested against the Ark API: dola-seedream-5-0-pro accepts ~1K sizes, but
// seedream-5-0/4-5 both reject anything under 3,686,400px ("size must be at least
// 3686400 pixels") — so each model gets its own minimum-viable size per aspect ratio.
const ARK_IMAGE_MODELS = [
  "dola-seedream-5-0-pro-260628",
  "seedream-5-0-260128",
  "seedream-4-5-251128",
];

type AspectRatio = "16:9" | "9:16" | "1:1";
const VALID_ASPECT_RATIOS: AspectRatio[] = ["16:9", "9:16", "1:1"];

// ~1K resolution — accepted by dola-seedream-5-0-pro
const ARK_SIZE_1K: Record<AspectRatio, string> = {
  "16:9": "1280x720",
  "9:16": "720x1280",
  "1:1": "1024x1024",
};

// Minimum size accepted by seedream-5-0 / seedream-4-5 (>= 3,686,400px)
const ARK_SIZE_FALLBACK: Record<AspectRatio, string> = {
  "16:9": "2560x1440",
  "9:16": "1440x2560",
  "1:1": "1920x1920",
};

function sizeForModel(model: string, ratio: AspectRatio): string {
  return model === ARK_IMAGE_MODELS[0] ? ARK_SIZE_1K[ratio] : ARK_SIZE_FALLBACK[ratio];
}

// Global semaphore — caps concurrent image generation calls across all pipelines.
const IMAGEN_CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY) || 20;
let activeImagenCalls = 0;
const imagenQueue: Array<() => void> = [];

function acquireImagenSlot(): Promise<void> {
  return new Promise(resolve => {
    if (activeImagenCalls < IMAGEN_CONCURRENCY) {
      activeImagenCalls++;
      resolve();
    } else {
      imagenQueue.push(() => { activeImagenCalls++; resolve(); });
    }
  });
}

function releaseImagenSlot(): void {
  activeImagenCalls--;
  if (imagenQueue.length > 0) imagenQueue.shift()!();
}

export function getAccessToken(): string {
  try {
    return execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  } catch (e: any) {
    throw new Error(`Failed to get gcloud access token — run: gcloud auth login --no-browser && gcloud auth application-default login --no-browser`);
  }
}

export interface ArkOverrides {
  apiKey?: string;
}

export async function generateGeminiImage(prompt: string, aspectRatio = "16:9", overrides?: ArkOverrides): Promise<string> {
  await acquireImagenSlot();
  try {
    return await _generateWithArk(prompt, aspectRatio, overrides);
  } finally {
    releaseImagenSlot();
  }
}

async function _generateWithArk(prompt: string, aspectRatio: string, overrides?: ArkOverrides): Promise<string> {
  const key = overrides?.apiKey?.trim() || ARK_API_KEY;
  if (!key) {
    throw new Error("BytePlus Ark API Key not configured — set it in Settings or via ARK_API_KEY on the server");
  }

  const ratio: AspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio as AspectRatio)
    ? (aspectRatio as AspectRatio)
    : "16:9";

  const errors: string[] = [];

  for (const model of ARK_IMAGE_MODELS) {
    try {
      const res = await fetch(ARK_IMAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          response_format: "b64_json",
          size: sizeForModel(model, ratio),
          stream: false,
          watermark: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const err = await res.text();
        if (res.status === 401 || res.status === 403) {
          throw new Error(`BytePlus Ark auth failed — check the Ark API Key (model ${model})`);
        }
        errors.push(`${model}: HTTP ${res.status} - ${err.slice(0, 200)}`);
        console.warn(`[ark-seedream] ${model} failed (${res.status}) — trying next model`);
        continue;
      }

      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) {
        errors.push(`${model}: no image data in response`);
        console.warn(`[ark-seedream] ${model} returned no image data — trying next model`);
        continue;
      }
      return b64;
    } catch (e: any) {
      if (e.message?.includes("auth failed")) throw e;
      errors.push(`${model}: ${e.message}`);
      console.warn(`[ark-seedream] ${model} threw — trying next model:`, e.message);
    }
  }

  throw new Error(`All BytePlus Ark image models failed: ${errors.join(" | ")}`);
}

export function getStyleImagePaths(projectId: string): string[] {
  return [
    path.join("uploads", projectId, "style", "style1.png"),
    path.join("uploads", projectId, "style", "style2.png"),
  ];
}
