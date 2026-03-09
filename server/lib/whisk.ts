import fs from "fs";
import path from "path";
import { Whisk } from "@rohitaryal/whisk-api";

function unwrapTrpc(json: any): any {
  return json?.result?.data?.json?.result || json?.result?.data?.json || json;
}

async function captionImageFromBytes(rawBytes: string, cookie: string): Promise<string> {
  try {
    const res = await fetch("https://labs.google/fx/api/trpc/backbone.captionImage", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        json: {
          captionInput: {
            candidatesCount: 1,
            mediaInput: { mediaCategory: "MEDIA_CATEGORY_STYLE", rawBytes },
          },
        },
      }),
    });
    if (!res.ok) return "";
    const text = await res.text();
    const data = unwrapTrpc(JSON.parse(text));
    return data?.candidates?.[0]?.output || "";
  } catch {
    return "";
  }
}

function fileToBase64DataUrl(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function decodeEncodedImage(encodedImage: string): Uint8Array {
  const binary = atob(encodedImage);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function resolveExistingPath(base: string): string | null {
  const candidates = [base, base.replace(/\.png$/, ".jpg"), base.replace(/\.png$/, ".jpeg"), base.replace(/\.png$/, ".webp")];
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function buildStyleEnhancedPrompt(
  prompt: string,
  stylePaths: string[],
  cookie: string
): Promise<string> {
  const existing = stylePaths.map(resolveExistingPath).filter(Boolean) as string[];
  if (existing.length === 0) return prompt;

  const captions: string[] = [];

  try {
    for (const p of existing) {
      const rawBytes = fileToBase64DataUrl(p);
      const caption = await captionImageFromBytes(rawBytes, cookie);
      if (caption) {
        console.log(`[whisk] Style caption: ${caption.substring(0, 100)}`);
        captions.push(caption);
      }
    }
  } catch (e: any) {
    console.warn(`[whisk] Caption step failed: ${e.message}`);
  }

  if (captions.length === 0) return prompt;

  return `In the visual style of: ${captions.join("; ")}. ${prompt}`;
}

export async function generateWhiskImageWithRefs(
  prompt: string,
  cookie: string,
  styleImagePaths: string[]
): Promise<Uint8Array> {
  const enhancedPrompt = await buildStyleEnhancedPrompt(prompt, styleImagePaths, cookie);
  console.log(`[whisk] Generating: ${enhancedPrompt.substring(0, 120)}...`);

  const whisk = new Whisk(cookie);
  const project = await whisk.newProject("Historia-" + Date.now());

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Whisk generation timed out after 30s")), 30000)
  );

  const media = await Promise.race([
    project.generateImage({ prompt: enhancedPrompt, aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE" }),
    timeoutPromise,
  ]);

  const encodedImage = (media as any).encodedMedia;
  if (!encodedImage) throw new Error("No image in Whisk response");

  console.log(`[whisk] Image generated successfully`);
  return decodeEncodedImage(encodedImage);
}

export function getStyleImagePaths(projectId: string): string[] {
  return [
    path.join("uploads", projectId, "style", "style1.png"),
    path.join("uploads", projectId, "style", "style2.png"),
  ];
}
