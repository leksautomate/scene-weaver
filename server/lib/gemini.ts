import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export const PROJECT_ID = process.env.VERTEX_PROJECT_ID || "project-f3847793-8610-4a16-945";

// BytePlus Ark (Seedream) endpoint used for all image generation
const ARK_IMAGE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
const ARK_API_KEY = process.env.ARK_API_KEY;

// Fallback chain — tried in order, falling through to the next model on any failure.
// Live-tested against the Ark API: dola-seedream-5-0-pro accepts ~1K sizes, but
// seedream-5-0/4-5 both reject anything under 3,686,400px ("size must be at least
// 3686400 pixels") — so each model gets its own minimum-viable size per aspect ratio.
export const ARK_IMAGE_MODELS = [
  "dola-seedream-5-0-pro-260628",
  "seedream-5-0-260128",
  "seedream-4-5-251128",
];

export const DAILY_LIMIT_PER_MODEL = Number(process.env.ARK_IMAGE_DAILY_LIMIT) || 100;
const USAGE_FILE = path.join("uploads", "ark_usage.json");

interface ArkUsageData {
  date: string;
  counts: Record<string, number>;
}

function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadArkUsage(): ArkUsageData {
  const today = getTodayString();
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
      if (data && data.date === today && typeof data.counts === "object") {
        return data;
      }
    }
  } catch (e) {
    console.warn("[ark-usage] Failed to read usage file, starting fresh today:", e);
  }
  return { date: today, counts: {} };
}

function saveArkUsage(data: ArkUsageData): void {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.warn("[ark-usage] Failed to write usage file:", e);
  }
}

export function getArkDailyUsage() {
  const usage = loadArkUsage();
  const modelsStatus: Record<string, { used: number; limit: number; remaining: number }> = {};
  for (const m of ARK_IMAGE_MODELS) {
    const used = usage.counts[m] || 0;
    modelsStatus[m] = {
      used,
      limit: DAILY_LIMIT_PER_MODEL,
      remaining: Math.max(0, DAILY_LIMIT_PER_MODEL - used),
    };
  }
  return {
    date: usage.date,
    limitPerModel: DAILY_LIMIT_PER_MODEL,
    models: modelsStatus,
  };
}

function isModelQuotaAvailable(model: string): boolean {
  const usage = loadArkUsage();
  const currentCount = usage.counts[model] || 0;
  return currentCount < DAILY_LIMIT_PER_MODEL;
}

function recordSuccessfulGeneration(model: string): void {
  const usage = loadArkUsage();
  usage.counts[model] = (usage.counts[model] || 0) + 1;
  saveArkUsage(usage);
  console.log(`[ark-usage] Model ${model} count updated to ${usage.counts[model]}/${DAILY_LIMIT_PER_MODEL}`);
}

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
    if (!isModelQuotaAvailable(model)) {
      const usage = loadArkUsage();
      const count = usage.counts[model] || 0;
      console.warn(`[ark-seedream] ${model} daily limit (${count}/${DAILY_LIMIT_PER_MODEL}) reached today — skipping to next model`);
      errors.push(`${model}: daily limit reached (${count}/${DAILY_LIMIT_PER_MODEL})`);
      continue;
    }

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

      recordSuccessfulGeneration(model);
      return b64;
    } catch (e: any) {
      if (e.message?.includes("auth failed")) throw e;
      errors.push(`${model}: ${e.message}`);
      console.warn(`[ark-seedream] ${model} threw — trying next model:`, e.message);
    }
  }

  throw new Error(`All BytePlus Ark image models failed or reached daily limit (${DAILY_LIMIT_PER_MODEL}/model/day): ${errors.join(" | ")}`);
}

export function getStyleImagePaths(projectId: string): string[] {
  return [
    path.join("uploads", projectId, "style", "style1.png"),
    path.join("uploads", projectId, "style", "style2.png"),
  ];
}
