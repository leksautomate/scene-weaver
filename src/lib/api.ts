import type { Project, Scene } from "./types";
import {
  loadProviderSettings,
  generateSceneManifest,
  generateScenesForChunk,
  splitScriptIntoChunks,
  generateWhiskImage,
  generateInworldAudio,
  generateMockSVG,
  generateMockAudio,
  type SceneManifest,
} from "./providers";

const API_BASE = "/api";

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

async function apiRequest(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function pollUntilComplete(projectId: string, totalScenes: number, callbacks: PipelineCallbacks): Promise<void> {
  const POLL_INTERVAL = 4000;
  const MAX_WAIT_MS = 30 * 60 * 1000;
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const data = await fetch(`${API_BASE}/projects/${projectId}`).then(r => r.json()).catch(() => null);
    if (!data) continue;

    const { project, scenes: sceneList } = data;
    const stats = (project?.stats as any) || {};
    const imagesCompleted = stats.imagesCompleted || 0;
    const audioCompleted = stats.audioCompleted || 0;
    const imagesFailed = stats.imagesFailed || 0;
    const audioFailed = stats.audioFailed || 0;

    callbacks.onStats({ imagesCompleted, audioCompleted, imagesFailed, audioFailed, total: totalScenes });

    if (sceneList) {
      for (const s of sceneList) {
        if (s.image_status === "completed") callbacks.onSceneProgress(s.scene_number, "image", "done");
        else if (s.image_status === "failed") callbacks.onSceneProgress(s.scene_number, "image", "failed");
        if (s.audio_status === "completed") callbacks.onSceneProgress(s.scene_number, "audio", "done");
        else if (s.audio_status === "failed") callbacks.onSceneProgress(s.scene_number, "audio", "failed");
      }
    }

    const status = project?.status;
    if (status === "completed" || status === "partial" || status === "failed" || status === "stopped") {
      callbacks.onPhase(status === "completed" ? "Done!" : `Finished with status: ${status}`);
      return;
    }

    callbacks.onPhase(`Server generating... (${imagesCompleted}/${totalScenes} images, ${audioCompleted}/${totalScenes} audio)`);
  }

  callbacks.onPhase("Generation timed out — check Projects page for status.");
}

export interface PipelineCallbacks {
  onPhase: (phase: string) => void;
  onSceneProgress: (sceneNum: number, type: "image" | "audio", status: "generating" | "done" | "failed") => void;
  onStats: (stats: { imagesCompleted: number; audioCompleted: number; imagesFailed: number; audioFailed: number; total: number }) => void;
}

async function appendScenesToProject(projectId: string, newScenes: SceneManifest[]): Promise<void> {
  await fetch(`${API_BASE}/projects/${projectId}/scenes/append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenes: newScenes }),
  }).catch(e => console.error(`[progressive] append failed:`, e.message));
}

async function processRemainingChunks(
  title: string,
  chunks: string[],
  chunkStartIdx: number,
  totalChunks: number,
  startSceneNumber: number,
  projectId: string,
  groqApiKey: string,
  splitMode: "smart" | "exact"
): Promise<void> {
  let nextSceneNumber = startSceneNumber;
  for (let i = chunkStartIdx; i < totalChunks; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      console.log(`[progressive] Processing chunk ${i + 1} of ${totalChunks}...`);
      const chunkScenes = await generateScenesForChunk(title, chunks[i], i, totalChunks, nextSceneNumber, groqApiKey, splitMode);
      await appendScenesToProject(projectId, chunkScenes);
      nextSceneNumber += chunkScenes.length;
      console.log(`[progressive] Chunk ${i + 1} appended: ${chunkScenes.length} scenes`);
    } catch (e: any) {
      console.error(`[progressive] Chunk ${i + 1} failed: ${e.message}`);
    }
  }
}

export async function createProjectFrontend(
  title: string,
  script: string,
  style1: File | null,
  style2: File | null,
  options: { voiceId?: string; splitMode?: "smart" | "exact" },
  callbacks: PipelineCallbacks
): Promise<{ projectId: string; serverPipeline: boolean; sceneCount: number }> {
  const settings = loadProviderSettings();
  if (!settings.groqApiKey) throw new Error("Groq API key not configured. Go to Settings to add it.");

  const chunks = splitScriptIntoChunks(script, 800);
  const totalChunks = chunks.length;

  callbacks.onPhase(totalChunks > 1
    ? `Generating scenes (chunk 1 of ${totalChunks})...`
    : "Generating scene manifest via Groq..."
  );

  let firstChunkScenes: SceneManifest[];
  try {
    firstChunkScenes = await generateScenesForChunk(title, chunks[0], 0, totalChunks, 1, settings.groqApiKey, options.splitMode || "smart");
  } catch (e: any) {
    throw new Error(`Scene generation failed: ${e.message}`);
  }

  callbacks.onPhase(`Creating project with ${firstChunkScenes.length} scenes${totalChunks > 1 ? ` (${totalChunks - 1} more chunks processing in background)` : ""}...`);

  const formData = new FormData();
  formData.append("title", title);
  formData.append("script", script);
  formData.append("imageProvider", settings.imageProvider);
  formData.append("ttsProvider", settings.ttsProvider);
  formData.append("voiceId", options.voiceId || settings.voiceId);
  formData.append("modelId", settings.modelId);
  formData.append("splitMode", options.splitMode || "smart");
  if (style1) formData.append("style1", style1);
  if (style2) formData.append("style2", style2);

  const serverProjectId = await fetch(`${API_BASE}/projects`, {
    method: "POST",
    body: formData,
  }).then(async r => {
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return r.json();
  }).then(d => d.projectId);

  const scenesRes = await fetch(`${API_BASE}/projects/${serverProjectId}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenes: firstChunkScenes }),
  }).then(r => r.json()).catch(() => ({ success: true, serverPipeline: false }));

  if (totalChunks > 1) {
    const nextSceneNumber = firstChunkScenes.length + 1;
    processRemainingChunks(title, chunks, 1, totalChunks, nextSceneNumber, serverProjectId, settings.groqApiKey, options.splitMode || "smart")
      .catch(e => console.error("[progressive] background processing error:", e.message));
  }

  return { projectId: serverProjectId, serverPipeline: !!scenesRes.serverPipeline, sceneCount: firstChunkScenes.length };
}

export async function runClientSidePipeline(
  serverProjectId: string,
  scenes: SceneManifest[],
  options: { voiceId?: string },
  callbacks: PipelineCallbacks
): Promise<void> {
  const settings = loadProviderSettings();

  callbacks.onPhase("Generating assets...");

  let imagesCompleted = scenes.filter((s: any) => s.image_status === "completed").length;
  let audioCompleted = scenes.filter((s: any) => s.audio_status === "completed").length;
  let imagesFailed = 0, audioFailed = 0;

  const styleUrls = [
    getAssetUrl(serverProjectId, "style", "style1.png"),
    getAssetUrl(serverProjectId, "style", "style2.png"),
  ];

  for (const scene of scenes) {
    const statusRes = await fetch(`${API_BASE}/projects/${serverProjectId}`).then(r => r.json()).catch(() => null);
    if (statusRes?.project?.status === "stopped") {
      callbacks.onPhase("Project stopped by user.");
      return;
    }

    const num = scene.scene_number;
    const sceneAny = scene as any;
    const imageAlreadyDone = sceneAny.image_status === "completed";
    const audioAlreadyDone = sceneAny.audio_status === "completed";

    if (!imageAlreadyDone) {
      callbacks.onSceneProgress(num, "image", "generating");
      try {
        let imageBlob: Blob;
        if (settings.imageProvider === "whisk") {
          if (!settings.whiskCookie) throw new Error("Whisk cookie not configured. Add it in Settings.");
          const allPrompts = [scene.image_prompt, ...(scene.fallback_prompts || [])];
          let success = false;
          let lastWhiskError = "All Whisk prompts failed";
          for (const prompt of allPrompts) {
            try {
              imageBlob = await generateWhiskImage(prompt, settings.whiskCookie, styleUrls, serverProjectId);
              success = true;
              break;
            } catch (e: any) {
              lastWhiskError = e.message;
              console.error(`Whisk prompt failed: ${e.message}`);
              if (e.message.includes("auth expired") || e.message.includes("Unauthorized") || e.message.includes("expired")) break;
            }
          }
          if (!success) throw new Error(lastWhiskError);
        } else {
          imageBlob = generateMockSVG(num, scene.image_prompt || "");
        }

        const fd = new FormData();
        fd.append("file", imageBlob!, `${num}.png`);
        const ext = settings.imageProvider === "whisk" ? "png" : "svg";
        await fetch(`${API_BASE}/assets/${serverProjectId}/images/${num}.${ext}`, { method: "POST", body: fd });

        await fetch(`${API_BASE}/projects/${serverProjectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_status: "completed", image_attempts: 1 }),
        });
        imagesCompleted++;
        callbacks.onSceneProgress(num, "image", "done");
      } catch (e: any) {
        console.error(`Image ${num} failed:`, e.message);
        await fetch(`${API_BASE}/projects/${serverProjectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_status: "failed", image_attempts: 1, image_error: e.message, needs_review: true }),
        });
        imagesFailed++;
        callbacks.onSceneProgress(num, "image", "failed");
      }
    } else {
      imagesCompleted++;
      callbacks.onSceneProgress(num, "image", "done");
    }

    if (!audioAlreadyDone) {
      callbacks.onSceneProgress(num, "audio", "generating");
      try {
        let audioBlob: Blob;
        if (settings.ttsProvider === "inworld" && settings.inworldApiKey) {
          audioBlob = await generateInworldAudio(
            scene.tts_text || scene.script_text || "",
            settings.inworldApiKey,
            options.voiceId || settings.voiceId,
            settings.modelId
          );
        } else {
          audioBlob = generateMockAudio();
        }

        const fd = new FormData();
        fd.append("file", audioBlob, `${num}.mp3`);
        await fetch(`${API_BASE}/assets/${serverProjectId}/audio/${num}.mp3`, { method: "POST", body: fd });

        await fetch(`${API_BASE}/projects/${serverProjectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio_status: "completed", audio_attempts: 1 }),
        });
        audioCompleted++;
        callbacks.onSceneProgress(num, "audio", "done");
      } catch (e: any) {
        console.error(`Audio ${num} failed:`, e.message);
        await fetch(`${API_BASE}/projects/${serverProjectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio_status: "failed", audio_attempts: 1, audio_error: e.message, needs_review: true }),
        });
        audioFailed++;
        callbacks.onSceneProgress(num, "audio", "failed");
      }
    } else {
      audioCompleted++;
      callbacks.onSceneProgress(num, "audio", "done");
    }

    callbacks.onStats({ imagesCompleted, audioCompleted, imagesFailed, audioFailed, total: scenes.length });
    await fetch(`${API_BASE}/projects/${serverProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stats: { sceneCount: scenes.length, imagesCompleted, audioCompleted, imagesFailed, audioFailed, needsReviewCount: imagesFailed + audioFailed },
      }),
    });
  }

  const finalStatus = (imagesFailed > 0 || audioFailed > 0) ? "partial" : "completed";
  await fetch(`${API_BASE}/projects/${serverProjectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: finalStatus }),
  });
}

export async function regenerateAssetFrontend(
  projectId: string,
  sceneNumber: number,
  type: "image" | "audio",
  voiceOverride?: string
): Promise<void> {
  const settings = loadProviderSettings();

  const { scenes } = await getProject(projectId);
  const scene = scenes.find(s => s.scene_number === sceneNumber);
  if (!scene) throw new Error("Scene not found");

  if (type === "image") {
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
            imageBlob = await generateWhiskImage(prompt, settings.whiskCookie, styleUrls, projectId);
            success = true;
            break;
          } catch (e: any) {
            lastError = e.message;
            if (e.message.includes("expired") || e.message.includes("rate limited") || e.message.includes("CORS")) break;
          }
        }
        if (!success) throw new Error(lastError || "All image generation attempts failed.");
      } else {
        imageBlob = generateMockSVG(sceneNumber, scene.image_prompt || "");
      }

      const ext = settings.imageProvider === "whisk" ? "png" : "svg";
      const fd = new FormData();
      fd.append("file", imageBlob!, `${sceneNumber}.${ext}`);
      await fetch(`${API_BASE}/assets/${projectId}/images/${sceneNumber}.${ext}`, { method: "POST", body: fd });

      await fetch(`${API_BASE}/projects/${projectId}/scenes/${sceneNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_status: "completed", image_attempts: (scene.image_attempts || 0) + 1, image_error: null, needs_review: false }),
      });
    } catch (e: any) {
      await fetch(`${API_BASE}/projects/${projectId}/scenes/${sceneNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_status: "failed", image_attempts: (scene.image_attempts || 0) + 1, image_error: e.message, needs_review: true }),
      });
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

      const fd = new FormData();
      fd.append("file", audioBlob, `${sceneNumber}.mp3`);
      await fetch(`${API_BASE}/assets/${projectId}/audio/${sceneNumber}.mp3`, { method: "POST", body: fd });

      await fetch(`${API_BASE}/projects/${projectId}/scenes/${sceneNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_status: "completed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: null, needs_review: false }),
      });
    } catch (e: any) {
      await fetch(`${API_BASE}/projects/${projectId}/scenes/${sceneNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_status: "failed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: e.message, needs_review: true }),
      });
      throw e;
    }
  }

  const { scenes: allScenes } = await getProject(projectId);
  const stats = {
    sceneCount: allScenes.length,
    imagesCompleted: allScenes.filter(s => s.image_status === "completed").length,
    audioCompleted: allScenes.filter(s => s.audio_status === "completed").length,
    imagesFailed: allScenes.filter(s => s.image_status === "failed").length,
    audioFailed: allScenes.filter(s => s.audio_status === "failed").length,
    needsReviewCount: allScenes.filter(s => s.needs_review).length,
  };
  const allImagesAccountedFor = (stats.imagesCompleted + stats.imagesFailed) === stats.sceneCount;
  const allAudioAccountedFor = (stats.audioCompleted + stats.audioFailed) === stats.sceneCount;
  const allDone = allImagesAccountedFor && allAudioAccountedFor;
  const hasFailures = stats.imagesFailed > 0 || stats.audioFailed > 0;
  const status = allDone && !hasFailures ? "completed" : "partial";
  await fetch(`${API_BASE}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stats, status }),
  });
}

export async function getProject(projectId: string): Promise<{ project: Project; scenes: Scene[] }> {
  const data = await apiRequest(`/projects/${projectId}`);
  return {
    project: data.project as Project,
    scenes: (data.scenes || []) as Scene[],
  };
}

export function getAssetUrl(projectId: string, type: "images" | "audio" | "style", filename: string): string {
  return `/api/assets/${projectId}/${type}/${filename}`;
}

export async function getProjects(): Promise<Project[]> {
  const data = await apiRequest("/projects");
  return (data || []) as Project[];
}

export function getDownloadUrl(projectId: string): string {
  return `/api/download/${projectId}`;
}

export async function splitScene(projectId: string, sceneNumber: number, splitAfterSentence: number): Promise<void> {
  await apiRequest(`/projects/${projectId}/split-scene`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sceneNumber, splitAfterSentence }),
  });
}

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

export async function bulkGenerateImages(projectId: string): Promise<void> {
  await fetch(`${API_BASE}/projects/${projectId}/generate-missing`, { method: "POST" });
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export async function stopProject(projectId: string): Promise<void> {
  await apiRequest(`/projects/${projectId}/stop`, { method: "PATCH" });
}

export async function resumeProject(projectId: string, callbacks: PipelineCallbacks): Promise<void> {
  const settings = loadProviderSettings();
  await fetch(`${API_BASE}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "processing" }),
  });

  const { scenes: allScenes } = await getProject(projectId);
  const pendingScenes = allScenes.filter(s =>
    s.image_status !== "completed" || s.audio_status !== "completed"
  );

  if (pendingScenes.length === 0) {
    await fetch(`${API_BASE}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    return;
  }

  callbacks.onPhase(`Resuming ${pendingScenes.length} scenes...`);
  const styleUrls = [
    getAssetUrl(projectId, "style", "style1.png"),
    getAssetUrl(projectId, "style", "style2.png"),
  ];

  for (const scene of pendingScenes) {
    const statusRes = await getProject(projectId).catch(() => null);
    if (statusRes?.project?.status === "stopped") {
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
          let lastWhiskError = "All Whisk prompts failed";
          for (const prompt of allPrompts) {
            try {
              imageBlob = await generateWhiskImage(prompt, settings.whiskCookie, styleUrls, projectId);
              success = true;
              break;
            } catch (e: any) {
              lastWhiskError = e.message;
              if (e.message.includes("expired") || e.message.includes("Unauthorized") || e.message.includes("rate limited")) break;
            }
          }
          if (!success) throw new Error(lastWhiskError);
        } else {
          imageBlob = generateMockSVG(num, scene.image_prompt || "");
        }

        const ext = settings.imageProvider === "whisk" ? "png" : "svg";
        const fd = new FormData();
        fd.append("file", imageBlob!, `${num}.${ext}`);
        await fetch(`${API_BASE}/assets/${projectId}/images/${num}.${ext}`, { method: "POST", body: fd });
        await fetch(`${API_BASE}/projects/${projectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_status: "completed", image_attempts: (scene.image_attempts || 0) + 1, image_error: null, needs_review: false }),
        });
        callbacks.onSceneProgress(num, "image", "done");
      } catch (e: any) {
        await fetch(`${API_BASE}/projects/${projectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_status: "failed", image_attempts: (scene.image_attempts || 0) + 1, image_error: e.message, needs_review: true }),
        });
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
            (scene as any).voice_id || settings.voiceId,
            settings.modelId
          );
        } else {
          audioBlob = generateMockAudio();
        }
        const fd = new FormData();
        fd.append("file", audioBlob, `${num}.mp3`);
        await fetch(`${API_BASE}/assets/${projectId}/audio/${num}.mp3`, { method: "POST", body: fd });
        await fetch(`${API_BASE}/projects/${projectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio_status: "completed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: null, needs_review: false }),
        });
        callbacks.onSceneProgress(num, "audio", "done");
      } catch (e: any) {
        await fetch(`${API_BASE}/projects/${projectId}/scenes/${num}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio_status: "failed", audio_attempts: (scene.audio_attempts || 0) + 1, audio_error: e.message, needs_review: true }),
        });
        callbacks.onSceneProgress(num, "audio", "failed");
      }
    }
  }

  const { scenes: finalScenes } = await getProject(projectId);
  const imagesFailed = finalScenes.filter(s => s.image_status === "failed").length;
  const audioFailed = finalScenes.filter(s => s.audio_status === "failed").length;
  const finalStatus = (imagesFailed > 0 || audioFailed > 0) ? "partial" : "completed";
  await fetch(`${API_BASE}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: finalStatus }),
  });
}
