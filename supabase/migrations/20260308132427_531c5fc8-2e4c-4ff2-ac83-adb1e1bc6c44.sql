
-- Create projects table
CREATE TABLE public.projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'history',
  status TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  settings JSONB NOT NULL DEFAULT '{}',
  style_summary JSONB NOT NULL DEFAULT '{}',
  stats JSONB NOT NULL DEFAULT '{"sceneCount":0,"imagesCompleted":0,"audioCompleted":0,"imagesFailed":0,"audioFailed":0,"needsReviewCount":0}'
);

-- Create scenes table
CREATE TABLE public.scenes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL,
  scene_type TEXT NOT NULL DEFAULT 'location',
  historical_period TEXT,
  visual_priority TEXT DEFAULT 'environment',
  script_text TEXT NOT NULL,
  tts_text TEXT NOT NULL,
  image_prompt TEXT NOT NULL,
  fallback_prompts JSONB NOT NULL DEFAULT '[]',
  image_file TEXT,
  audio_file TEXT,
  image_status TEXT NOT NULL DEFAULT 'pending',
  audio_status TEXT NOT NULL DEFAULT 'pending',
  image_attempts INTEGER NOT NULL DEFAULT 0,
  audio_attempts INTEGER NOT NULL DEFAULT 0,
  image_error TEXT,
  audio_error TEXT,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, scene_number)
);

-- Enable RLS
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scenes ENABLE ROW LEVEL SECURITY;

-- Public access policies (no auth required for this tool)
CREATE POLICY "Public read projects" ON public.projects FOR SELECT USING (true);
CREATE POLICY "Public insert projects" ON public.projects FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update projects" ON public.projects FOR UPDATE USING (true);
CREATE POLICY "Public delete projects" ON public.projects FOR DELETE USING (true);

CREATE POLICY "Public read scenes" ON public.scenes FOR SELECT USING (true);
CREATE POLICY "Public insert scenes" ON public.scenes FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update scenes" ON public.scenes FOR UPDATE USING (true);
CREATE POLICY "Public delete scenes" ON public.scenes FOR DELETE USING (true);

-- Create update trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_scenes_updated_at BEFORE UPDATE ON public.scenes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Create storage bucket for project assets
INSERT INTO storage.buckets (id, name, public) VALUES ('project-assets', 'project-assets', true);

CREATE POLICY "Public read project assets" ON storage.objects FOR SELECT USING (bucket_id = 'project-assets');
CREATE POLICY "Public insert project assets" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'project-assets');
CREATE POLICY "Public update project assets" ON storage.objects FOR UPDATE USING (bucket_id = 'project-assets');
CREATE POLICY "Public delete project assets" ON storage.objects FOR DELETE USING (bucket_id = 'project-assets');
