import "https://deno.land/x/xhr@0.1.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, cookie, accessToken, payload } = body;

    // Action: session — get access token from cookie
    if (action === "session") {
      const res = await fetch("https://labs.google/fx/api/auth/session", {
        headers: { cookie },
      });
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: upload — upload image to Whisk
    if (action === "upload") {
      const res = await fetch("https://labs.google/fx/api/trpc/backbone.uploadImage", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: generate-recipe — run image recipe with style refs
    if (action === "generate-recipe") {
      const res = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: generate — plain text-to-image
    if (action === "generate") {
      const res = await fetch("https://aisandbox-pa.googleapis.com/v1:runImageFx", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return new Response(JSON.stringify({ status: res.status, data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
