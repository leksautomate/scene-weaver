export interface StyleSummary {
  palette: string;
  lighting: string;
  framing: string;
  people: string;
  mood: string;
  historicalLook: string;
}

export const DEFAULT_STYLE_SUMMARY: StyleSummary = {
  palette: "desaturated, muted, slightly dark, historical documentary tone",
  lighting: "natural window light, candlelight, torchlight, overcast daylight, dim interiors",
  framing: "wide establishing shots, over-the-shoulder views, close details, behind-the-back framing",
  people: "anonymous figures, obscured faces, silhouettes, backs turned",
  mood: "tense, reflective, investigative, cinematic",
  historicalLook: "realistic period atmosphere, grounded environments, era-appropriate architecture, clothing, and objects",
};

export interface Scene {
  id?: string;
  scene_number: number;
  scene_type: string;
  historical_period: string;
  visual_priority: string;
  script_text: string;
  tts_text: string;
  image_prompt: string;
  fallback_prompts: string[];
  image_file: string;
  audio_file: string;
  image_status: "pending" | "completed" | "failed";
  audio_status: "pending" | "completed" | "failed";
  image_attempts: number;
  audio_attempts: number;
  image_error: string | null;
  audio_error: string | null;
  needs_review: boolean;
}

export interface ProjectStats {
  sceneCount: number;
  imagesCompleted: number;
  audioCompleted: number;
  imagesFailed: number;
  audioFailed: number;
  needsReviewCount: number;
}

export interface ProjectSettings {
  imageProvider: string;
  voiceId: string;
  modelId: string;
  imageConcurrency: number;
  audioConcurrency: number;
  historyMode: boolean;
}

export interface Project {
  id: string;
  title: string;
  mode: string;
  status: string;
  created_at: string;
  updated_at: string;
  settings: ProjectSettings;
  style_summary: StyleSummary;
  stats: ProjectStats;
}
