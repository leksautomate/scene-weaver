import { supabase } from "@/integrations/supabase/client";
import type { Project, Scene } from "./types";
import {
  loadProviderSettings,
  generateSceneManifest,
  generateWhiskImage,
  generateInworldAudio,
  generateMockSVG,
  generateMockAudio,
  type SceneManifest,
} from "./providers";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function fnUrl(name: string) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

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

export interface PipelineCallbacks {
  onPhase: (phase: string) => void;
  onSceneProgress: (sceneNum: number, type: "image" | "audio", status: "generating" | "done" | "failed") => void;
  onStats: (stats: { imagesCompleted: number; audioCompleted: number; imagesFailed: number; audioFailed: number; total: number }) => void;
}

export async function createProjectFrontend(
  title: string,
  script: string,
  style1: File | null,
  style2: File | null,
  callbacks: PipelineCallbacks
): Promise<string> {
  const settings = loadProviderSettings();
  const projectId = generateProjectId();

  // 1. Create project in DB
  callbacks.onPhase("Creating project...");
  const { error: insertErr } = await supabase.from("projects").insert({
    id: projectId,
    title,
    mode: "history",
    status: "processing",
    settings: {
      imageProvider: settings.imageProvider,
      ttsProvider: settings.ttsProvider,
      voiceId: settings.voiceId,
      modelId: settings.modelId,
      imageConcurrency: settings.imageConcurrency,
      audioConcurrency: settings.audioConcurrency,
      historyMode: true,
    },
    style_summary: DEFAULT_STYLE_SUMMARY,
    stats: { sceneCount: 0, imagesCompleted: 0, audioCompleted: 0, imagesFailed: 0, audioFailed: 0, needsReviewCount: 0 },
  });
  if (insertErr) throw new Error(`Failed to create project: ${insertErr.message}`);

  // 2. Upload style references
  if (style1) {
    const buf = await style1.arrayBuffer();
    await supabase.storage.from("project-assets").upload(
      `${projectId}/style/style1.png`, new Uint8Array(buf),
      { contentType: style1.type || "image/png", upsert: true }
    );
  }
  if (style2) {
    const buf = await style2.arrayBuffer();
    await supabase.storage.from("project-assets").upload(
      `${projectId}/style/style2.png`, new Uint8Array(buf),
      { contentType: style2.type || "image/png", upsert: true }
    );
  }

  // 3. Generate scene manifest via Groq
  callbacks.onPhase("Generating scene manifest via Groq...");
  if (!settings.groqApiKey) throw new Error("Groq API key not configured. Go to Settings to add it.");

  let scenes: SceneManifest[];
  try {
    scenes = await generateSceneManifest(title, script, DEFAULT_STYLE_SUMMARY, settings.groqApiKey);
  } catch (e: any) {
    await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    throw new Error(`Scene generation failed: ${e.message}`);
  }

  // 4. Insert scenes into DB
  callbacks.onPhase(`Inserting ${scenes.length} scenes...`);
  const sceneRows = scenes.map((s, i) => ({
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
    await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    throw new Error(`Failed to insert scenes: ${scenesErr.message}`);
  }

  await supabase.from("projects").update({
    stats: { sceneCount: scenes.length, imagesCompleted: 0, audioCompleted: 0, imagesFailed: 0, audioFailed: 0, needsReviewCount: 0 },
  }).eq("id", projectId);

  // 5. Generate assets (images + audio) for each scene
  callbacks.onPhase("Generating assets...");
  let imagesCompleted = 0, audioCompleted = 0, imagesFailed = 0, audioFailed = 0;

  // Build style reference URLs for Whisk
  const styleUrls = [
    getAssetUrl(projectId, "style", "style1.png"),
    getAssetUrl(projectId, "style", "style2.png"),
  ];

  for (const scene of scenes) {
    // Check if project was stopped
    const { data: projCheck } = await supabase.from("projects").select("status").eq("id", projectId).single();
    if (projCheck?.status === "stopped") {
      callbacks.onPhase("Project stopped by user.");
      return projectId;
    }

    const num = scene.scene_number;

    // Image
    callbacks.onSceneProgress(num, "image", "generating");
    try {
      let imageBlob: Blob;
      if (settings.imageProvider === "whisk") {
        if (!settings.whiskCookie) throw new Error("Whisk cookie not configured");
        const allPrompts = [scene.image_prompt, ...(scene.fallback_prompts || [])];
        let success = false;
        for (const prompt of allPrompts) {
          try {
            imageBlob = await generateWhiskImage(prompt, settings.whiskCookie, styleUrls);
            success = true;
            break;
          } catch (e: any) {
            console.error(`Whisk prompt failed: ${e.message}`);
          }
        }
        if (!success) throw new Error("All Whisk prompts failed");
      } else if (settings.imageProvider === "mock") {
        imageBlob = generateMockSVG(num, scene.image_prompt || "");
      } else {
        imageBlob = generateMockSVG(num, scene.image_prompt || "");
      }

      const imgBuf = await imageBlob!.arrayBuffer();
      await supabase.storage.from("project-assets").upload(
        `${projectId}/images/${num}.png`, new Uint8Array(imgBuf),
        { contentType: imageBlob!.type || "image/png", upsert: true }
      );
      await supabase.from("scenes").update({ image_status: "completed", image_attempts: 1 })
        .eq("project_id", projectId).eq("scene_number", num);
      imagesCompleted++;
      callbacks.onSceneProgress(num, "image", "done");
    } catch (e: any) {
      console.error(`Image ${num} failed:`, e.message);
      await supabase.from("scenes").update({
        image_status: "failed", image_attempts: 1, image_error: e.message, needs_review: true,
      }).eq("project_id", projectId).eq("scene_number", num);
      imagesFailed++;
      callbacks.onSceneProgress(num, "image", "failed");
    }

    // Audio
    callbacks.onSceneProgress(num, "audio", "generating");
    try {
      let audioBlob: Blob;
      if (settings.ttsProvider === "inworld" && settings.inworldApiKey) {
        audioBlob = await generateInworldAudio(
          scene.tts_text || scene.script_text || "",
          settings.inworldApiKey,
          settings.voiceId,
          settings.modelId
        );
      } else {
        audioBlob = generateMockAudio();
      }

      const audioBuf = await audioBlob.arrayBuffer();
      await supabase.storage.from("project-assets").upload(
        `${projectId}/audio/${num}.mp3`, new Uint8Array(audioBuf),
        { contentType: "audio/mpeg", upsert: true }
      );
      await supabase.from("scenes").update({ audio_status: "completed", audio_attempts: 1 })
        .eq("project_id", projectId).eq("scene_number", num);
      audioCompleted++;
      callbacks.onSceneProgress(num, "audio", "done");
    } catch (e: any) {
      console.error(`Audio ${num} failed:`, e.message);
      await supabase.from("scenes").update({
        audio_status: "failed", audio_attempts: 1, audio_error: e.message, needs_review: true,
      }).eq("project_id", projectId).eq("scene_number", num);
      audioFailed++;
      callbacks.onSceneProgress(num, "audio", "failed");
    }

    // Update stats
    callbacks.onStats({ imagesCompleted, audioCompleted, imagesFailed, audioFailed, total: scenes.length });
    await supabase.from("projects").update({
      stats: { sceneCount: scenes.length, imagesCompleted, audioCompleted, imagesFailed, audioFailed, needsReviewCount: imagesFailed + audioFailed },
    }).eq("id", projectId);
  }

  const finalStatus = (imagesFailed > 0 || audioFailed > 0) ? "partial" : "completed";
  await supabase.from("projects").update({ status: finalStatus }).eq("id", projectId);

  return projectId;
}

// Regenerate a single asset from frontend
export async function regenerateAssetFrontend(
  projectId: string,
  sceneNumber: number,
  type: "image" | "audio",
  voiceOverride?: string
): Promise<void> {
  const settings = loadProviderSettings();

  const { data: scene, error: se } = await supabase
    .from("scenes").select("*")
    .eq("project_id", projectId).eq("scene_number", sceneNumber).single();
  if (se || !scene) throw new Error("Scene not found");

  if (type === "image") {
    // Build style reference URLs
    const styleUrls = [
      getAssetUrl(projectId, "style", "style1.png"),
      getAssetUrl(projectId, "style", "style2.png"),
    ];

    try {
      let imageBlob: Blob;
      if (settings.imageProvider === "whisk" && settings.whiskCookie) {
        const allPrompts = [scene.image_prompt, ...(scene.fallback_prompts as string[] || [])];
        let success = false;
        let lastError = "";
        for (const prompt of allPrompts) {
          try {
            imageBlob = await generateWhiskImage(prompt, settings.whiskCookie, styleUrls);
            success = true;
            break;
          } catch (e: any) {
            lastError = e.message;
            console.error(`Whisk prompt failed: ${e.message}`);
            // Stop trying fallbacks if it's an auth/rate-limit issue
            if (e.message.includes("expired") || e.message.includes("rate limited") || e.message.includes("CORS")) break;
          }
        }
        if (!success) throw new Error(lastError || "All image generation attempts failed. Check your Whisk Cookie in Settings.");
      } else if (settings.imageProvider === "whisk" && !settings.whiskCookie) {
        throw new Error("Whisk Cookie not configured. Go to Settings to add it.");
      } else {
        imageBlob = generateMockSVG(sceneNumber, scene.image_prompt || "");
      }

      const buf = await imageBlob!.arrayBuffer();
      await supabase.storage.from("project-assets").upload(
        `${projectId}/images/${sceneNumber}.png`, new Uint8Array(buf),
        { contentType: imageBlob!.type || "image/png", upsert: true }
      );
      await supabase.from("scenes").update({
        image_status: "completed", image_attempts: (scene.image_attempts || 0) + 1,
        image_error: null, needs_review: false,
      }).eq("project_id", projectId).eq("scene_number", sceneNumber);
    } catch (e: any) {
      await supabase.from("scenes").update({
        image_status: "failed", image_attempts: (scene.image_attempts || 0) + 1,
        image_error: e.message, needs_review: true,
      }).eq("project_id", projectId).eq("scene_number", sceneNumber);
      throw e;
    }
  } else {
    try {
      let audioBlob: Blob;
      if (settings.ttsProvider === "inworld" && settings.inworldApiKey) {
        audioBlob = await generateInworldAudio(
          scene.tts_text || scene.script_text || "",
          settings.inworldApiKey,
          voiceOverride || (scene as any).voice_id || settings.voiceId || "Dennis",
          settings.modelId || "inworld-tts-1.5-max"
        );
      } else {
        audioBlob = generateMockAudio();
      }

      const buf = await audioBlob.arrayBuffer();
      await supabase.storage.from("project-assets").upload(
        `${projectId}/audio/${sceneNumber}.mp3`, new Uint8Array(buf),
        { contentType: "audio/mpeg", upsert: true }
      );
      await supabase.from("scenes").update({
        audio_status: "completed", audio_attempts: (scene.audio_attempts || 0) + 1,
        audio_error: null, needs_review: false,
      }).eq("project_id", projectId).eq("scene_number", sceneNumber);
    } catch (e: any) {
      await supabase.from("scenes").update({
        audio_status: "failed", audio_attempts: (scene.audio_attempts || 0) + 1,
        audio_error: e.message, needs_review: true,
      }).eq("project_id", projectId).eq("scene_number", sceneNumber);
      throw e;
    }
  }

  // Update project stats
  const { data: allScenes } = await supabase.from("scenes")
    .select("image_status, audio_status, needs_review").eq("project_id", projectId);
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
}

export async function getProject(projectId: string): Promise<{ project: Project; scenes: Scene[] }> {
  const [{ data: project, error: pe }, { data: scenes, error: se }] = await Promise.all([
    supabase.from("projects").select("*").eq("id", projectId).single(),
    supabase.from("scenes").select("*").eq("project_id", projectId).order("scene_number"),
  ]);
  if (pe) throw new Error(pe.message);
  if (se) throw new Error(se.message);
  return {
    project: project as unknown as Project,
    scenes: (scenes || []) as unknown as Scene[],
  };
}

export function getAssetUrl(projectId: string, type: "images" | "audio" | "style", filename: string): string {
  const { data } = supabase.storage.from("project-assets").getPublicUrl(`${projectId}/${type}/${filename}`);
  return data.publicUrl;
}

export async function getProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as unknown as Project[];
}

export function getDownloadUrl(projectId: string): string {
  return `${fnUrl("download-project")}?projectId=${projectId}&apikey=${SUPABASE_KEY}`;
}

// Split a scene at a sentence boundary
export async function splitScene(projectId: string, sceneNumber: number, splitAfterSentence: number): Promise<void> {
  const { data: scene, error } = await supabase.from("scenes").select("*")
    .eq("project_id", projectId).eq("scene_number", sceneNumber).single();
  if (error || !scene) throw new Error("Scene not found");

  const sentences = scene.script_text.match(/[^.!?]+[.!?]+/g)?.map((s: string) => s.trim()) || [scene.script_text];
  const ttsSentences = scene.tts_text.match(/[^.!?]+[.!?]+/g)?.map((s: string) => s.trim()) || [scene.tts_text];

  const firstScript = sentences.slice(0, splitAfterSentence).join(" ");
  const secondScript = sentences.slice(splitAfterSentence).join(" ");
  const firstTts = ttsSentences.slice(0, splitAfterSentence).join(" ");
  const secondTts = ttsSentences.slice(splitAfterSentence).join(" ");

  // Update current scene
  await supabase.from("scenes").update({
    script_text: firstScript,
    tts_text: firstTts,
  }).eq("project_id", projectId).eq("scene_number", sceneNumber);

  // Shift all subsequent scenes up by 1
  const { data: laterScenes } = await supabase.from("scenes").select("id, scene_number")
    .eq("project_id", projectId).gt("scene_number", sceneNumber).order("scene_number", { ascending: false });

  if (laterScenes) {
    for (const s of laterScenes) {
      await supabase.from("scenes").update({ scene_number: s.scene_number + 1 }).eq("id", s.id);
    }
  }

  // Insert new scene
  const newNum = sceneNumber + 1;
  await supabase.from("scenes").insert({
    project_id: projectId,
    scene_number: newNum,
    scene_type: scene.scene_type,
    historical_period: scene.historical_period,
    visual_priority: scene.visual_priority,
    script_text: secondScript,
    tts_text: secondTts,
    image_prompt: scene.image_prompt,
    fallback_prompts: scene.fallback_prompts,
    image_file: `${newNum}.png`,
    audio_file: `${newNum}.mp3`,
    image_status: "pending",
    audio_status: "pending",
  });

  // Update project stats
  const { data: allScenes } = await supabase.from("scenes").select("image_status, audio_status, needs_review").eq("project_id", projectId);
  if (allScenes) {
    await supabase.from("projects").update({
      stats: {
        sceneCount: allScenes.length,
        imagesCompleted: allScenes.filter(s => s.image_status === "completed").length,
        audioCompleted: allScenes.filter(s => s.audio_status === "completed").length,
        imagesFailed: allScenes.filter(s => s.image_status === "failed").length,
        audioFailed: allScenes.filter(s => s.audio_status === "failed").length,
        needsReviewCount: allScenes.filter(s => s.needs_review).length,
      },
    }).eq("id", projectId);
  }
}

// Bulk regenerate all failed scenes
export async function bulkRegenerateFailed(
  projectId: string,
  failedScenes: Array<{ scene_number: number; image_status: string; audio_status: string; voice_id?: string | null }>,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  let done = 0;
  for (const scene of failedScenes) {
    const tasks: Promise<void>[] = [];
    if (scene.image_status === "failed") {
      tasks.push(regenerateAssetFrontend(projectId, scene.scene_number, "image").catch(console.error) as Promise<void>);
    }
    if (scene.audio_status === "failed") {
      tasks.push(regenerateAssetFrontend(projectId, scene.scene_number, "audio", scene.voice_id || undefined).catch(console.error) as Promise<void>);
    }
    await Promise.all(tasks);
    done++;
    onProgress(done, failedScenes.length);
  }
}

// Delete a project and all its assets
export async function deleteProject(projectId: string): Promise<void> {
  const folders = ["images", "audio", "style"];
  for (const folder of folders) {
    const { data: files } = await supabase.storage.from("project-assets").list(`${projectId}/${folder}`);
    if (files && files.length > 0) {
      const paths = files.map(f => `${projectId}/${folder}/${f.name}`);
      await supabase.storage.from("project-assets").remove(paths);
    }
  }
  await supabase.from("scenes").delete().eq("project_id", projectId);
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw new Error(`Failed to delete project: ${error.message}`);
}

// Stop a running project
export async function stopProject(projectId: string): Promise<void> {
  const { error } = await supabase.from("projects").update({ status: "stopped" }).eq("id", projectId);
  if (error) throw new Error(`Failed to stop project: ${error.message}`);
}

// Resume a stopped/partial project
export async function resumeProject(projectId: string, callbacks: PipelineCallbacks): Promise<void> {
  const settings = loadProviderSettings();
  await supabase.from("projects").update({ status: "processing" }).eq("id", projectId);

  const { data: pendingScenes, error } = await supabase.from("scenes")
    .select("*")
    .eq("project_id", projectId)
    .or("image_status.eq.pending,image_status.eq.failed,audio_status.eq.pending,audio_status.eq.failed")
    .order("scene_number");
  if (error) throw new Error(error.message);
  if (!pendingScenes || pendingScenes.length === 0) {
    await supabase.from("projects").update({ status: "completed" }).eq("id", projectId);
    return;
  }

  callbacks.onPhase(`Resuming ${pendingScenes.length} scenes...`);
  const styleUrls = [
    getAssetUrl(projectId, "style", "style1.png"),
    getAssetUrl(projectId, "style", "style2.png"),
  ];

  for (const scene of pendingScenes) {
    const { data: projCheck } = await supabase.from("projects").select("status").eq("id", projectId).single();
    if (projCheck?.status === "stopped") {
      callbacks.onPhase("Project stopped by user.");
      return;
    }

    const num = scene.scene_number;

    if (scene.image_status !== "completed") {
      callbacks.onSceneProgress(num, "image", "generating");
      try {
        let imageBlob: Blob;
        if (settings.imageProvider === "whisk" && settings.whiskCookie) {
          const allPrompts = [scene.image_prompt, ...(scene.fallback_prompts as string[] || [])];
          let success = false;
          for (const prompt of allPrompts) {
            try {
              imageBlob = await generateWhiskImage(prompt, settings.whiskCookie, styleUrls);
              success = true;
              break;
            } catch (e: any) {
              console.error(`Whisk prompt failed: ${e.message}`);
              if (e.message.includes("expired") || e.message.includes("rate limited")) break;
            }
          }
          if (!success) throw new Error("All Whisk prompts failed");
        } else {
          imageBlob = generateMockSVG(num, scene.image_prompt || "");
        }
        const buf = await imageBlob!.arrayBuffer();
        await supabase.storage.from("project-assets").upload(
          `${projectId}/images/${num}.png`, new Uint8Array(buf),
          { contentType: imageBlob!.type || "image/png", upsert: true }
        );
        await supabase.from("scenes").update({ image_status: "completed", image_attempts: (scene.image_attempts || 0) + 1, image_error: null, needs_review: false })
          .eq("project_id", projectId).eq("scene_number", num);
        callbacks.onSceneProgress(num, "image", "done");
      } catch (e: any) {
        await supabase.from("scenes").update({ image_status: "failed", image_attempts: (scene.image_attempts || 0) + 1, image_error: e.message, needs_review: true })
          .eq("project_id", projectId).eq("scene_number", num);
        callbacks.onSceneProgress(num, "image", "failed");
      }
    }

    if (scene.audio_status !== "completed") {
      callbacks.onSceneProgress(num, "audio", "generating");
      try {
        let audioBlob: Blob;
        if (settings.ttsProvider === "inworld" && settings.inworldApiKey) {
          audioBlob = await generateInworldAudio(
            scene.tts_text || scene.script_text || "",
            settings.inworldApiKey,
            scene.voice_id || settings.voiceId,
            settings.modelId
          );
        } else {
          audioBlob = generateMockAudio();
        }
        const buf = await audioBlob.arrayBuffer();
        await supabase.storage.from("project-assets").upload(
          `${projectId}/audio/${num}.mp3`, new Uint8Array(buf),
          { contentType: "audio/mpeg", upsert: true }
        );
        await supabase.from("scenes").update({ audio_status: "completed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: null, needs_review: false })
          .eq("project_id", projectId).eq("scene_number", num);
        callbacks.onSceneProgress(num, "audio", "done");
      } catch (e: any) {
        await supabase.from("scenes").update({ audio_status: "failed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: e.message, needs_review: true })
          .eq("project_id", projectId).eq("scene_number", num);
        callbacks.onSceneProgress(num, "audio", "failed");
      }
    }

    // Update stats
    const { data: allScenes } = await supabase.from("scenes").select("image_status, audio_status, needs_review").eq("project_id", projectId);
    if (allScenes) {
      const st = {
        sceneCount: allScenes.length,
        imagesCompleted: allScenes.filter(s => s.image_status === "completed").length,
        audioCompleted: allScenes.filter(s => s.audio_status === "completed").length,
        imagesFailed: allScenes.filter(s => s.image_status === "failed").length,
        audioFailed: allScenes.filter(s => s.audio_status === "failed").length,
        needsReviewCount: allScenes.filter(s => s.needs_review).length,
      };
      callbacks.onStats({ ...st, total: st.sceneCount });
      await supabase.from("projects").update({ stats: st }).eq("id", projectId);
    }
  }

  // Final status
  const { data: allScenes } = await supabase.from("scenes").select("image_status, audio_status").eq("project_id", projectId);
  if (allScenes) {
    const hasFailed = allScenes.some(s => s.image_status === "failed" || s.audio_status === "failed");
    const hasPending = allScenes.some(s => s.image_status === "pending" || s.audio_status === "pending");
    const finalStatus = hasPending ? "processing" : hasFailed ? "partial" : "completed";
    await supabase.from("projects").update({ status: finalStatus }).eq("id", projectId);
  }
}
