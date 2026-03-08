import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function generateAIImage(prompt: string): Promise<Uint8Array | null> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) return null;

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lovableApiKey}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
    }),
  });

  if (!response.ok) {
    if (response.status === 429 || response.status === 402) {
      throw new Error(`Rate limited (${response.status})`);
    }
    throw new Error(`Image generation failed: ${response.status}`);
  }

  const data = await response.json();
  const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!imageUrl) throw new Error("No image in response");

  const base64 = imageUrl.replace(/^data:image\/\w+;base64,/, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function generateMockSVG(sceneNumber: number, prompt: string): string {
  const truncated = prompt.substring(0, 60) + (prompt.length > 60 ? "..." : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e"/><stop offset="100%" style="stop-color:#16213e"/></linearGradient></defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <text x="640" y="300" font-family="serif" font-size="72" fill="#c9a84c" text-anchor="middle" font-weight="bold">${sceneNumber}</text>
  <text x="640" y="380" font-family="sans-serif" font-size="18" fill="#888" text-anchor="middle">REGENERATED MOCK</text>
  <text x="640" y="430" font-family="sans-serif" font-size="14" fill="#666" text-anchor="middle">${truncated.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>
</svg>`;
}

function generateMockAudio(): Uint8Array {
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
  return result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, sceneNumber, type } = await req.json();

    const { data: scene, error: se } = await supabase
      .from("scenes").select("*")
      .eq("project_id", projectId).eq("scene_number", sceneNumber).single();

    if (se || !scene) {
      return new Response(JSON.stringify({ error: "Scene not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check project image provider
    const { data: project } = await supabase.from("projects").select("settings").eq("id", projectId).single();
    const imageProvider = (project?.settings as any)?.imageProvider || "ai";

    if (type === "image") {
      try {
        if (imageProvider === "ai") {
          const allPrompts = [scene.image_prompt, ...(scene.fallback_prompts as string[] || [])];
          let imageBytes: Uint8Array | null = null;
          for (const prompt of allPrompts) {
            try {
              imageBytes = await generateAIImage(prompt);
              if (imageBytes) break;
            } catch (e: any) {
              console.error(`Prompt failed: ${e.message}`);
              if (e.message.includes("Rate limited")) throw e;
            }
          }
          if (!imageBytes) throw new Error("All prompts failed");
          await supabase.storage.from("project-assets").upload(
            `${projectId}/images/${sceneNumber}.png`, imageBytes,
            { contentType: "image/png", upsert: true }
          );
        } else {
          const svg = generateMockSVG(sceneNumber, scene.image_prompt || "");
          await supabase.storage.from("project-assets").upload(
            `${projectId}/images/${sceneNumber}.png`, new TextEncoder().encode(svg),
            { contentType: "image/svg+xml", upsert: true }
          );
        }
        await supabase.from("scenes").update({
          image_status: "completed", image_attempts: (scene.image_attempts || 0) + 1, image_error: null, needs_review: false,
        }).eq("project_id", projectId).eq("scene_number", sceneNumber);
      } catch (e: any) {
        await supabase.from("scenes").update({
          image_status: "failed", image_attempts: (scene.image_attempts || 0) + 1, image_error: e.message, needs_review: true,
        }).eq("project_id", projectId).eq("scene_number", sceneNumber);
        throw e;
      }
    } else if (type === "audio") {
      try {
        const audioBytes = generateMockAudio();
        await supabase.storage.from("project-assets").upload(
          `${projectId}/audio/${sceneNumber}.mp3`, audioBytes,
          { contentType: "audio/mpeg", upsert: true }
        );
        await supabase.from("scenes").update({
          audio_status: "completed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: null, needs_review: false,
        }).eq("project_id", projectId).eq("scene_number", sceneNumber);
      } catch (e: any) {
        await supabase.from("scenes").update({
          audio_status: "failed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: e.message, needs_review: true,
        }).eq("project_id", projectId).eq("scene_number", sceneNumber);
        throw e;
      }
    }

    // Update project stats
    const { data: allScenes } = await supabase.from("scenes").select("image_status, audio_status, needs_review").eq("project_id", projectId);
    if (allScenes) {
      const stats = {
        sceneCount: allScenes.length,
        imagesCompleted: allScenes.filter(s => s.image_status === "completed").length,
        audioCompleted: allScenes.filter(s => s.audio_status === "completed").length,
        imagesFailed: allScenes.filter(s => s.image_status === "failed").length,
        audioFailed: allScenes.filter(s => s.audio_status === "failed").length,
        needsReviewCount: allScenes.filter(s => s.needs_review).length,
      };
      const status = (stats.imagesFailed > 0 || stats.audioFailed > 0) ? "partial" : "completed";
      await supabase.from("projects").update({ stats, status }).eq("id", projectId);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
