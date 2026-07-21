import { execSync } from "child_process";
import path from "path";

export const PROJECT_ID = process.env.VERTEX_PROJECT_ID || "project-f3847793-8610-4a16-945";

// Modal-hosted Z-Image Turbo endpoint used for all image generation
const MODAL_ZIMAGE_URL = process.env.MODAL_ZIMAGE_URL || "https://leksautomate--z-image-turbo-api.modal.run";
const MODAL_KEY = process.env.MODAL_KEY;
const MODAL_SECRET = process.env.MODAL_SECRET;

type AspectRatio = "16:9" | "9:16" | "1:1";
const VALID_ASPECT_RATIOS: AspectRatio[] = ["16:9", "9:16", "1:1"];

// Global semaphore — max 2 concurrent image generation calls across all pipelines
const IMAGEN_CONCURRENCY = 2;
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

export async function generateGeminiImage(prompt: string, aspectRatio = "16:9"): Promise<string> {
  await acquireImagenSlot();
  try {
    return await _generateWithModal(prompt, aspectRatio);
  } finally {
    releaseImagenSlot();
  }
}

async function _generateWithModal(prompt: string, aspectRatio: string): Promise<string> {
  if (!MODAL_KEY || !MODAL_SECRET) {
    throw new Error("MODAL_KEY / MODAL_SECRET not configured — set them in the server environment");
  }

  const ratio: AspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio as AspectRatio)
    ? (aspectRatio as AspectRatio)
    : "16:9";

  const delays = [10_000, 20_000, 30_000];
  let lastError = "";

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const res = await fetch(MODAL_ZIMAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Modal-Key": MODAL_KEY,
        "Modal-Secret": MODAL_SECRET,
      },
      body: JSON.stringify({ prompt, aspect_ratio: ratio }),
      signal: AbortSignal.timeout(120_000),
    });

    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("No image in Z-Image Turbo response");
      return buf.toString("base64");
    }

    const err = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error("Z-Image Turbo auth failed — check MODAL_KEY / MODAL_SECRET");
    if (res.status === 429) {
      lastError = `Rate limited (attempt ${attempt + 1})`;
      if (attempt < delays.length) {
        console.warn(`[z-image-turbo] 429 rate limit — retrying in ${delays[attempt] / 1000}s`);
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw new Error("Z-Image Turbo rate limited after 4 attempts");
    }
    throw new Error(`Z-Image Turbo API failed ${res.status}: ${err.slice(0, 200)}`);
  }

  throw new Error(lastError || "Z-Image Turbo generation failed");
}

export function getStyleImagePaths(projectId: string): string[] {
  return [
    path.join("uploads", projectId, "style", "style1.png"),
    path.join("uploads", projectId, "style", "style2.png"),
  ];
}
