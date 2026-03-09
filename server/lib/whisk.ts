import fs from "fs";
import path from "path";
import { Whisk } from "@rohitaryal/whisk-api";

function decodeEncodedImage(encodedImage: string): Uint8Array {
  const binary = atob(encodedImage);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function resolveExistingPath(base: string): string | null {
  const candidates = [
    base,
    base.replace(/\.png$/, ".jpg"),
    base.replace(/\.png$/, ".jpeg"),
    base.replace(/\.png$/, ".webp"),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

export async function generateWhiskImageWithRefs(
  prompt: string,
  cookie: string,
  styleImagePaths: string[]
): Promise<Uint8Array> {
  const whisk = new Whisk(cookie);
  const project = await whisk.newProject("Historia-" + Date.now());

  let refsAdded = 0;

  const subjectPath = resolveExistingPath(styleImagePaths[0] || "");
  if (subjectPath) {
    try {
      await project.addSubject({ file: subjectPath });
      refsAdded++;
      console.log(`[whisk] Added subject ref: ${subjectPath}`);
    } catch (e: any) {
      console.warn(`[whisk] addSubject failed: ${e.message}`);
    }
  }

  const stylePath = resolveExistingPath(styleImagePaths[1] || "");
  if (stylePath) {
    try {
      await project.addStyle({ file: stylePath });
      refsAdded++;
      console.log(`[whisk] Added style ref: ${stylePath}`);
    } catch (e: any) {
      console.warn(`[whisk] addStyle failed: ${e.message}`);
    }
  }

  console.log(`[whisk] Generating with ${refsAdded} reference(s): ${prompt.substring(0, 100)}...`);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Whisk generation timed out after 60s")), 60000)
  );

  const genPromise = refsAdded > 0
    ? project.generateImageWithReferences({ prompt, aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE" })
    : project.generateImage({ prompt, aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE" });

  const media = await Promise.race([genPromise, timeoutPromise]);

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
