import { Router, Request, Response } from "express";
import fs from "fs";
import { Whisk } from "@rohitaryal/whisk-api";

const router = Router();

function unwrapTrpc(json: any): any {
  return json?.result?.data?.json?.result || json?.result?.data?.json || json;
}

function resolveExistingPath(base: string): string | null {
  if (!base) return null;
  const candidates = [
    base,
    base.replace(/\.png$/, ".jpg"),
    base.replace(/\.png$/, ".jpeg"),
    base.replace(/\.png$/, ".webp"),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

router.post("/", async (req: Request, res: Response) => {
  try {
    const { action, cookie, payload, apiKey, projectId } = req.body;

    if (action === "session") {
      const r = await fetch("https://labs.google/fx/api/auth/session", { headers: { cookie } });
      const data = await r.json();
      return res.json({ status: r.status, data });
    }

    if (action === "create-project") {
      const r = await fetch("https://labs.google/fx/api/trpc/media.createOrUpdateWorkflow", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ json: { workflowMetadata: { workflowName: payload?.name || "Historia Project" } } }),
      });
      const text = await r.text();
      let data;
      try { data = unwrapTrpc(JSON.parse(text)); } catch { data = { raw: text.substring(0, 1000) }; }
      return res.json({ status: r.status, data });
    }

    if (action === "caption-image") {
      const r = await fetch("https://labs.google/fx/api/trpc/backbone.captionImage", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          json: {
            clientContext: { workflowId: payload?.workflowId || "" },
            captionInput: {
              candidatesCount: 1,
              mediaInput: {
                mediaCategory: payload?.mediaCategory || "MEDIA_CATEGORY_STYLE",
                rawBytes: payload?.rawBytes,
              },
            },
          },
        }),
      });
      const text = await r.text();
      let data;
      try { data = unwrapTrpc(JSON.parse(text)); } catch { data = { raw: text.substring(0, 1000) }; }
      return res.json({ status: r.status, data });
    }

    if (action === "generate") {
      const promptText: string = payload?.userInput?.prompts?.[0] || payload?.prompt || "";
      const cookieVal: string = cookie || payload?.cookie || "";

      if (!promptText) return res.json({ status: 400, data: { error: "prompt required" } });
      if (!cookieVal) return res.json({ status: 400, data: { error: "cookie required" } });

      try {
        const whisk = new Whisk(cookieVal);
        const project = await whisk.newProject("Historia-" + Date.now());

        let refsAdded = 0;

        if (projectId) {
          const subjectPath = resolveExistingPath(`uploads/${projectId}/style/style1.png`);
          if (subjectPath) {
            try {
              await project.addSubject({ file: subjectPath });
              refsAdded++;
              console.log(`[whisk-proxy] Added subject ref: ${subjectPath}`);
            } catch (e: any) {
              console.warn(`[whisk-proxy] addSubject failed: ${e.message}`);
            }
          }

          const stylePath = resolveExistingPath(`uploads/${projectId}/style/style2.png`);
          if (stylePath) {
            try {
              await project.addStyle({ file: stylePath });
              refsAdded++;
              console.log(`[whisk-proxy] Added style ref: ${stylePath}`);
            } catch (e: any) {
              console.warn(`[whisk-proxy] addStyle failed: ${e.message}`);
            }
          }
        }

        console.log(`[whisk-proxy] Generating with ${refsAdded} reference(s)`);

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Whisk timed out after 60s")), 60000)
        );

        const genPromise = refsAdded > 0
          ? project.generateImageWithReferences({ prompt: promptText, aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE" })
          : project.generateImage({ prompt: promptText, aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE" });

        const media = await Promise.race([genPromise, timeoutPromise]) as any;

        const encodedImage = media.encodedMedia;
        if (!encodedImage) return res.json({ status: 500, data: { error: "No image in Whisk response" } });

        return res.json({
          status: 200,
          data: {
            imagePanels: [{ generatedImages: [{ encodedImage }] }],
          },
        });
      } catch (e: any) {
        console.error(`[whisk-proxy] generate error:`, e.message);
        const status = e.message?.includes("401") || e.message?.includes("403") ? 401
          : e.message?.includes("429") ? 429
          : 500;
        return res.json({ status, data: { error: e.message } });
      }
    }

    if (action === "groq-chat") {
      const key = apiKey || process.env.GROQ_API_KEY;
      if (!key) return res.json({ status: 500, data: { error: "GROQ_API_KEY not configured" } });
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 1000) }; }
      return res.json({ status: r.status, data });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
