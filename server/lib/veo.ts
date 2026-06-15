import { execSync } from "child_process";
import path from "path";
import fs from "fs";

const PROJECT_ID = process.env.VERTEX_PROJECT_ID || "project-f3847793-8610-4a16-945";
// Veo is only available in us-central1 (not europe-west4)
const VEO_LOCATION = process.env.VEO_LOCATION_ID || "us-central1";
const VEO_MODEL = process.env.VEO_MODEL_ID || "veo-3.1-lite-generate-001";
const API_ENDPOINT = `${VEO_LOCATION}-aiplatform.googleapis.com`;

function getAccessToken(): string {
  try {
    return execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Failed to get gcloud access token — run: gcloud auth application-default login --no-browser");
  }
}

/**
 * Animate an image to an 8-second video clip using Veo 3.0-fast-preview.
 * Saves the result to outPath. Throws on failure or timeout.
 *
 * Audio sync note: the caller (buildVeoClip in render.ts) handles
 * speed adjustment when audio > 8s via setpts — no looping needed.
 */
export async function generateVeoClip(
  imagePath: string,
  prompt: string,
  outPath: string,
  aspectRatio?: string,
  generateAudio?: boolean
): Promise<void> {
  const imageBytes = fs.readFileSync(imagePath);
  const imageBase64 = imageBytes.toString("base64");
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

  const url = `https://${API_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${VEO_LOCATION}/publishers/google/models/${VEO_MODEL}:predictLongRunning`;

  const body = {
    instances: [{
      prompt,
      image: { bytesBase64Encoded: imageBase64, mimeType },
    }],
    parameters: {
      sampleCount: 1,
      durationSeconds: 8,
      personGeneration: "allow_all",
      generateAudio: generateAudio ?? false,
      ...(aspectRatio === "9:16" ? { aspectRatio: "9:16" } : {}),
    },
  };

  const token = getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veo request failed: ${res.status} ${text}`);
  }

  const operation = (await res.json()) as { name: string };
  if (!operation.name) throw new Error("Veo returned no operation name");

  await pollVeoOperation(operation.name, outPath);
}

/**
 * Generate a video from a text prompt only (no input image) using Veo.
 * Saves the result to outPath. Throws on failure or timeout.
 */
export async function generateVeoTextClip(
  prompt: string,
  outPath: string,
  aspectRatio?: string,
  generateAudio?: boolean
): Promise<void> {
  const url = `https://${API_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${VEO_LOCATION}/publishers/google/models/${VEO_MODEL}:predictLongRunning`;

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      durationSeconds: 8,
      personGeneration: "allow_all",
      generateAudio: generateAudio ?? true,
      ...(aspectRatio === "9:16" ? { aspectRatio: "9:16" } : {}),
    },
  };

  const token = getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Veo request failed: ${res.status} ${text}`);
  }

  const operation = (await res.json()) as { name: string };
  if (!operation.name) throw new Error("Veo returned no operation name");

  await pollVeoOperation(operation.name, outPath);
}

async function downloadGcs(gcsUri: string, outPath: string): Promise<void> {
  // gcsUri format: gs://bucket-name/path/to/file.mp4
  const withoutScheme = gcsUri.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  const bucket = withoutScheme.slice(0, slashIdx);
  const object = withoutScheme.slice(slashIdx + 1);
  const token = getAccessToken();

  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`GCS download failed: ${res.status} ${await res.text()}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

async function pollVeoOperation(operationName: string, outPath: string): Promise<void> {
  // Veo requires POST to :fetchPredictOperation — a GET to the operations URL returns 404
  const pollUrl = `https://${API_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${VEO_LOCATION}/publishers/google/models/${VEO_MODEL}:fetchPredictOperation`;
  const MAX_POLLS = 60; // 60 × 5 s = 5 min max

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, 5_000));

    const token = getAccessToken();
    const pollRes = await fetch(pollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationName }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!pollRes.ok) {
      if (pollRes.status === 429 || pollRes.status >= 500) {
        console.warn(`[veo] poll transient error ${pollRes.status}, retrying...`);
        continue;
      }
      throw new Error(`Veo poll failed: ${pollRes.status} ${await pollRes.text()}`);
    }

    const op = (await pollRes.json()) as {
      done?: boolean;
      error?: { message: string };
      response?: unknown;
    };

    if (op.error) throw new Error(`Veo generation failed: ${op.error.message}`);

    if (op.done) {
      const r = op.response as any;

      if (r?.raiMediaFilteredCount > 0) {
        const reasons = r.raiMediaFilteredReasons?.join(" | ") || "Content was filtered by Responsible AI.";
        throw new Error(`Veo generation blocked by RAI filters: ${reasons}`);
      }

      // Inline base64 — older Veo models / predictLongRunning flatten into predictions[]
      const videoBase64: string | undefined =
        r?.videos?.[0]?.bytesBase64Encoded ||
        r?.predictions?.[0]?.bytesBase64Encoded ||
        r?.predictions?.[0]?.video?.bytesBase64Encoded ||
        r?.generateVideoResponse?.generatedSamples?.[0]?.video?.bytesBase64Encoded ||
        r?.generatedSamples?.[0]?.video?.bytesBase64Encoded;

      if (videoBase64) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, Buffer.from(videoBase64, "base64"));
        return;
      }

      // GCS URI — Veo 3.x returns gs:// URI, must be downloaded separately
      const gcsUri: string | undefined =
        r?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        r?.generatedSamples?.[0]?.video?.uri ||
        r?.predictions?.[0]?.video?.uri ||
        r?.predictions?.[0]?.uri;

      if (gcsUri) {
        console.log(`[veo] downloading from GCS: ${gcsUri}`);
        await downloadGcs(gcsUri, outPath);
        return;
      }

      console.error("[veo] unexpected done response:", JSON.stringify(r).slice(0, 800));
      throw new Error(`Veo returned no video data. Response keys: ${Object.keys(r || {}).join(", ")}`);
    }
  }

  throw new Error("Veo generation timed out after 5 minutes");
}
