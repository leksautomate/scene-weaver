import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_STYLE_SUMMARY = {
  palette: "desaturated, muted, slightly dark, historical documentary tone",
  lighting: "natural window light, candlelight, torchlight, overcast daylight, dim interiors",
  framing: "wide establishing shots, over-the-shoulder views, close details, behind-the-back framing",
  people: "anonymous figures, obscured faces, silhouettes, backs turned",
  mood: "tense, reflective, investigative, cinematic",
  historicalLook: "realistic period atmosphere, grounded environments, era-appropriate architecture, clothing, and objects",
};

function generateProjectId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "proj_";
  for (let i = 0; i < 8; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

async function callAIForSceneManifest(title: string, script: string, styleSummary: any) {
  const groqApiKey = Deno.env.get("GROQ_API_KEY");
  
  const systemPrompt = `You are a cinematic scene breakdown specialist for historical documentary content.

Given a title, script, and style summary, split the script into visual narrative scenes.

Rules:
- Create 1 scene per 2-4 sentences, splitting when location, action, or emotional beat changes
- Keep scene_number sequential from 1
- Keep people anonymous - use generic roles (ruler, soldier, merchant, monk, peasant)
- No celebrity likenesses
- Generate cinematic, realistic, documentary-like image prompts
- Maintain the exact style summary in every prompt
- Convert abstract ideas into visible moments
- Produce 3 fallback prompts per scene (progressively simpler)
- Assign scene_type: character | location | crowd | battle_light | artifact | transition
- Assign historical_period
- Assign visual_priority: character | environment | object
- image_file = {scene_number}.png, audio_file = {scene_number}.mp3
- tts_text should be the narration for that scene
- All image prompts must end with style keywords like "cinematic realism, historical atmosphere"

Replace famous individuals with generic descriptions:
- anonymous ruler, military commander, court official, monk, merchant, soldier, peasant, noblewoman, worker, crowd of townspeople

Return ONLY valid JSON matching this exact schema:
{
  "scenes": [
    {
      "scene_number": 1,
      "scene_type": "location",
      "historical_period": "ancient rome",
      "visual_priority": "environment",
      "script_text": "original script chunk",
      "tts_text": "narration text",
      "image_prompt": "detailed cinematic prompt",
      "fallback_prompts": ["simpler prompt", "environmental prompt", "symbolic prompt"],
      "image_file": "1.png",
      "audio_file": "1.mp3"
    }
  ]
}`;

  const userPrompt = `Title: ${title}
Mode: history

Style Summary:
${JSON.stringify(styleSummary, null, 2)}

Full Script:
${script}

Split this into scenes. Return ONLY the JSON object.`;

  let apiUrl: string;
  let headers: Record<string, string>;
  let body: any;

  if (groqApiKey) {
    // Use Groq
    apiUrl = "https://api.groq.com/openai/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${groqApiKey}`,
    };
    body = {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    };
  } else {
    // Use Lovable AI (Gemini) via Supabase AI
    apiUrl = `https://api.lovable.dev/v1/ai/chat`;
    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey}`,
    };
    body = {
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    };
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from AI");

  // Try to parse JSON from the response
  // Strip markdown code blocks if present
  content = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  
  const parsed = JSON.parse(content);
  return parsed.scenes || [];
}

function generateMockSVG(sceneNumber: number, prompt: string): string {
  const truncated = prompt.substring(0, 60) + (prompt.length > 60 ? "..." : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <text x="640" y="300" font-family="serif" font-size="72" fill="#c9a84c" text-anchor="middle" font-weight="bold">${sceneNumber}</text>
  <text x="640" y="380" font-family="sans-serif" font-size="18" fill="#888" text-anchor="middle">MOCK IMAGE</text>
  <text x="640" y="430" font-family="sans-serif" font-size="14" fill="#666" text-anchor="middle">${truncated.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>
</svg>`;
}

// Generate a minimal valid MP3 (silence)
function generateMockAudio(): Uint8Array {
  // Minimal MP3 frame (MPEG1 Layer3, 128kbps, 44100Hz, stereo, 1 frame of silence)
  const header = new Uint8Array([
    0xFF, 0xFB, 0x90, 0x00, // MPEG1 Layer3 frame header
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  // Repeat frame to make ~1 second
  const frames: Uint8Array[] = [];
  for (let i = 0; i < 38; i++) frames.push(header);
  const total = frames.reduce((s, f) => s + f.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    result.set(f, offset);
    offset += f.length;
  }
  return result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const title = formData.get("title") as string;
    const script = formData.get("script") as string;
    const style1 = formData.get("style1") as File;
    const style2 = formData.get("style2") as File;

    if (!title || !script) {
      return new Response(JSON.stringify({ error: "Title and script are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const projectId = generateProjectId();
    console.log(`Creating project ${projectId}: "${title}"`);

    // 1. Create project record
    const { error: insertErr } = await supabase.from("projects").insert({
      id: projectId,
      title,
      mode: "history",
      status: "processing",
      settings: {
        imageProvider: "mock",
        voiceId: "",
        modelId: "",
        imageConcurrency: 2,
        audioConcurrency: 2,
        historyMode: true,
      },
      style_summary: DEFAULT_STYLE_SUMMARY,
      stats: {
        sceneCount: 0,
        imagesCompleted: 0,
        audioCompleted: 0,
        imagesFailed: 0,
        audioFailed: 0,
        needsReviewCount: 0,
      },
    });
    if (insertErr) throw new Error(`Failed to create project: ${insertErr.message}`);

    // 2. Upload style images
    if (style1) {
      const buf1 = await style1.arrayBuffer();
      await supabase.storage.from("project-assets").upload(
        `${projectId}/style/style1.png`,
        new Uint8Array(buf1),
        { contentType: style1.type || "image/png", upsert: true }
      );
    }
    if (style2) {
      const buf2 = await style2.arrayBuffer();
      await supabase.storage.from("project-assets").upload(
        `${projectId}/style/style2.png`,
        new Uint8Array(buf2),
        { contentType: style2.type || "image/png", upsert: true }
      );
    }

    // Return immediately, process in background
    const responsePromise = new Response(
      JSON.stringify({ projectId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

    // Background processing (non-blocking)
    (async () => {
      try {
        // 3. Call AI for scene manifest
        console.log(`${projectId}: Generating scene manifest...`);
        let scenes: any[];
        try {
          scenes = await callAIForSceneManifest(title, script, DEFAULT_STYLE_SUMMARY);
        } catch (e: any) {
          console.error(`${projectId}: AI manifest failed:`, e.message);
          await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
          return;
        }

        console.log(`${projectId}: Got ${scenes.length} scenes`);

        // 4. Insert scenes into DB
        const sceneRows = scenes.map((s: any, i: number) => ({
          project_id: projectId,
          scene_number: s.scene_number || i + 1,
          scene_type: s.scene_type || "location",
          historical_period: s.historical_period || "generic historical",
          visual_priority: s.visual_priority || "environment",
          script_text: s.script_text || "",
          tts_text: s.tts_text || s.script_text || "",
          image_prompt: s.image_prompt || "",
          fallback_prompts: s.fallback_prompts || [],
          image_file: s.image_file || `${s.scene_number || i + 1}.png`,
          audio_file: s.audio_file || `${s.scene_number || i + 1}.mp3`,
          image_status: "pending",
          audio_status: "pending",
        }));

        const { error: scenesErr } = await supabase.from("scenes").insert(sceneRows);
        if (scenesErr) {
          console.error(`${projectId}: Failed to insert scenes:`, scenesErr.message);
          await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
          return;
        }

        // Update scene count
        await supabase.from("projects").update({
          stats: {
            sceneCount: scenes.length,
            imagesCompleted: 0,
            audioCompleted: 0,
            imagesFailed: 0,
            audioFailed: 0,
            needsReviewCount: 0,
          },
        }).eq("id", projectId);

        // 5. Generate mock images and audio for each scene
        let imagesCompleted = 0;
        let audioCompleted = 0;
        let imagesFailed = 0;
        let audioFailed = 0;

        for (const scene of scenes) {
          const num = scene.scene_number;

          // Generate mock image (SVG converted to PNG-like)
          try {
            const svg = generateMockSVG(num, scene.image_prompt || "");
            const svgBytes = new TextEncoder().encode(svg);
            await supabase.storage.from("project-assets").upload(
              `${projectId}/images/${num}.png`,
              svgBytes,
              { contentType: "image/svg+xml", upsert: true }
            );
            await supabase.from("scenes").update({
              image_status: "completed",
              image_attempts: 1,
            }).eq("project_id", projectId).eq("scene_number", num);
            imagesCompleted++;
          } catch (e: any) {
            console.error(`${projectId}: Image ${num} failed:`, e.message);
            await supabase.from("scenes").update({
              image_status: "failed",
              image_attempts: 1,
              image_error: e.message,
              needs_review: true,
            }).eq("project_id", projectId).eq("scene_number", num);
            imagesFailed++;
          }

          // Generate mock audio
          try {
            const audioBytes = generateMockAudio();
            await supabase.storage.from("project-assets").upload(
              `${projectId}/audio/${num}.mp3`,
              audioBytes,
              { contentType: "audio/mpeg", upsert: true }
            );
            await supabase.from("scenes").update({
              audio_status: "completed",
              audio_attempts: 1,
            }).eq("project_id", projectId).eq("scene_number", num);
            audioCompleted++;
          } catch (e: any) {
            console.error(`${projectId}: Audio ${num} failed:`, e.message);
            await supabase.from("scenes").update({
              audio_status: "failed",
              audio_attempts: 1,
              audio_error: e.message,
              needs_review: true,
            }).eq("project_id", projectId).eq("scene_number", num);
            audioFailed++;
          }

          // Update stats incrementally
          const needsReview = imagesFailed + audioFailed;
          await supabase.from("projects").update({
            stats: {
              sceneCount: scenes.length,
              imagesCompleted,
              audioCompleted,
              imagesFailed,
              audioFailed,
              needsReviewCount: needsReview,
            },
          }).eq("id", projectId);
        }

        // 6. Final status
        const finalStatus = (imagesFailed > 0 || audioFailed > 0) ? "partial" : "completed";
        await supabase.from("projects").update({ status: finalStatus }).eq("id", projectId);
        console.log(`${projectId}: Pipeline complete. Status: ${finalStatus}`);

      } catch (e: any) {
        console.error(`${projectId}: Pipeline error:`, e.message);
        await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
      }
    })();

    return responsePromise;
  } catch (e: any) {
    console.error("create-project error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
