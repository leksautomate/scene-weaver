import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { JSZip } from "https://deno.land/x/jszip@0.11.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      return new Response(JSON.stringify({ error: "projectId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify project exists
    const { data: project, error: pe } = await supabase
      .from("projects").select("title").eq("id", projectId).single();
    if (pe || !project) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const zip = new JSZip();

    // List and download images
    const { data: images } = await supabase.storage
      .from("project-assets").list(`${projectId}/images`);
    if (images) {
      for (const file of images) {
        const { data } = await supabase.storage
          .from("project-assets").download(`${projectId}/images/${file.name}`);
        if (data) {
          const bytes = new Uint8Array(await data.arrayBuffer());
          zip.addFile(`images/${file.name}`, bytes);
        }
      }
    }

    // List and download audio
    const { data: audio } = await supabase.storage
      .from("project-assets").list(`${projectId}/audio`);
    if (audio) {
      for (const file of audio) {
        const { data } = await supabase.storage
          .from("project-assets").download(`${projectId}/audio/${file.name}`);
        if (data) {
          const bytes = new Uint8Array(await data.arrayBuffer());
          zip.addFile(`audio/${file.name}`, bytes);
        }
      }
    }

    // List and download style refs
    const { data: styles } = await supabase.storage
      .from("project-assets").list(`${projectId}/style`);
    if (styles) {
      for (const file of styles) {
        const { data } = await supabase.storage
          .from("project-assets").download(`${projectId}/style/${file.name}`);
        if (data) {
          const bytes = new Uint8Array(await data.arrayBuffer());
          zip.addFile(`style/${file.name}`, bytes);
        }
      }
    }

    // Add scene manifest as JSON
    const { data: scenes } = await supabase
      .from("scenes").select("*").eq("project_id", projectId).order("scene_number");
    if (scenes) {
      zip.addFile("scenes.json", new TextEncoder().encode(JSON.stringify(scenes, null, 2)));
    }

    const zipData = await zip.generateAsync({ type: "uint8array" });
    const safeTitle = (project.title || projectId).replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);

    return new Response(zipData, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeTitle}.zip"`,
      },
    });
  } catch (e: any) {
    console.error("download-project error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
