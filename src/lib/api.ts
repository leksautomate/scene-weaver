import { supabase } from "@/integrations/supabase/client";
import type { Project, Scene } from "./types";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function fnUrl(name: string) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

export async function createProject(formData: FormData): Promise<string> {
  const res = await fetch(fnUrl("create-project"), {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Failed to create project");
  }
  const data = await res.json();
  return data.projectId;
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

export async function regenerateImage(projectId: string, sceneNumber: number): Promise<void> {
  const res = await fetch(fnUrl("regenerate-asset"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ projectId, sceneNumber, type: "image" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Failed to regenerate image");
  }
}

export async function regenerateAudio(projectId: string, sceneNumber: number): Promise<void> {
  const res = await fetch(fnUrl("regenerate-asset"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ projectId, sceneNumber, type: "audio" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Failed to regenerate audio");
  }
}

export function getAssetUrl(projectId: string, type: "images" | "audio" | "style", filename: string): string {
  const { data } = supabase.storage.from("project-assets").getPublicUrl(`${projectId}/${type}/${filename}`);
  return data.publicUrl;
}

export async function downloadProject(projectId: string): Promise<string> {
  // Return the download URL from edge function
  return `${fnUrl("download-project")}?projectId=${projectId}&apikey=${SUPABASE_KEY}`;
}
