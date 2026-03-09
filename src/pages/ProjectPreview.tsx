import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { getProject, getAssetUrl, regenerateAssetFrontend } from "@/lib/api";
import { regenerateImagePrompt } from "@/lib/providers";
import type { Scene } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Play, Pause, SkipBack, SkipForward,
  Volume2, VolumeX, Loader2, RefreshCw, Sparkles,
  PanelRightOpen, PanelRightClose, Save, Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";
import { loadProviderSettings } from "@/lib/providers";

export default function ProjectPreview() {
  const { projectId } = useParams<{ projectId: string }>();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [projectTitle, setProjectTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [durations, setDurations] = useState<Record<number, number>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editPrompt, setEditPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState(false);
  const [regenImage, setRegenImage] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await getProject(projectId);
      setProjectTitle(data.project.title);
      setScenes(data.scenes);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const scene = scenes[activeIndex];

  // Sync edit prompt when scene changes
  useEffect(() => {
    if (scene) setEditPrompt(scene.image_prompt);
  }, [activeIndex, scene?.image_prompt]);

  // Load audio durations
  useEffect(() => {
    if (!projectId) return;
    scenes.forEach((s) => {
      if (s.audio_status === "completed" && !durations[s.scene_number]) {
        const url = getAssetUrl(projectId, "audio", s.audio_file);
        const a = new Audio();
        a.preload = "metadata";
        a.src = url;
        a.onloadedmetadata = () => {
          setDurations((prev) => ({ ...prev, [s.scene_number]: a.duration }));
        };
      }
    });
  }, [scenes, projectId]);

  // Audio event handlers
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurTime(audio.currentTime);
    const onDur = () => setDuration(audio.duration);
    const onEnd = () => {
      if (activeIndex < scenes.length - 1) {
        setActiveIndex((i) => i + 1);
      } else {
        setIsPlaying(false);
      }
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onDur);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onDur);
      audio.removeEventListener("ended", onEnd);
    };
  }, [activeIndex, scenes.length]);

  // Play/pause and load new src when scene changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !projectId || !scene) return;
    if (scene.audio_status === "completed") {
      const url = getAssetUrl(projectId, "audio", scene.audio_file);
      audio.src = url;
      audio.volume = muted ? 0 : volume;
      if (isPlaying) audio.play().catch(() => {});
    }
  }, [activeIndex, scene?.audio_status]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const seek = (val: number[]) => {
    if (audioRef.current && duration > 0) {
      audioRef.current.currentTime = val[0];
      setCurTime(val[0]);
    }
  };

  const fmt = (s: number) => {
    if (!s || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const goScene = (idx: number) => {
    if (idx < 0 || idx >= scenes.length) return;
    setActiveIndex(idx);
    setCurTime(0);
    setDuration(0);
  };

  const savePrompt = async () => {
    if (!projectId || !scene) return;
    setSaving(true);
    const res = await fetch(`/api/projects/${projectId}/scenes/${scene.scene_number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_prompt: editPrompt }),
    });
    if (!res.ok) { const e = await res.json(); toast.error(e.error); }
    else { toast.success("Prompt saved"); fetchData(); }
    setSaving(false);
  };

  const handleRegenPrompt = async () => {
    if (!scene) return;
    const settings = loadProviderSettings();
    if (!settings.groqApiKey) { toast.error("Groq API key not configured"); return; }
    setRegenPrompt(true);
    try {
      const newPrompt = await regenerateImagePrompt(scene.script_text, settings.groqApiKey);
      setEditPrompt(newPrompt);
      toast.success("New prompt generated");
    } catch (e: any) { toast.error(e.message); }
    finally { setRegenPrompt(false); }
  };

  const handleRegenImage = async () => {
    if (!projectId || !scene) return;
    // Save prompt first if changed
    if (editPrompt !== scene.image_prompt) {
      await fetch(`/api/projects/${projectId}/scenes/${scene.scene_number}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_prompt: editPrompt }),
      });
    }
    setRegenImage(true);
    try {
      await regenerateAssetFrontend(projectId, scene.scene_number, "image");
      toast.success("Image regenerated");
      fetchData();
    } catch (e: any) { toast.error(e.message); }
    finally { setRegenImage(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!scene || !projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No scenes found.
      </div>
    );
  }

  const imgUrl = scene.image_status === "completed" ? getAssetUrl(projectId, "images", scene.image_file) : null;

  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden">
      <audio ref={audioRef} preload="auto" />

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card">
          <Link to={`/projects/${projectId}`}>
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <h1 className="text-sm font-display text-foreground truncate">{projectTitle}</h1>
          <span className="text-xs text-muted-foreground">Scene {scene.scene_number} / {scenes.length}</span>
          <div className="ml-auto">
            <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(!sidebarOpen)}>
              {sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Image viewer */}
        <div className="flex-1 relative bg-background flex items-center justify-center overflow-hidden">
          {imgUrl ? (
            <img src={imgUrl} alt={`Scene ${scene.scene_number}`} className="max-w-full max-h-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <ImageIcon className="h-16 w-16" />
              <span className="text-sm">No image generated</span>
            </div>
          )}
          {/* Subtitle overlay */}
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 max-w-[80%] px-4 py-2 bg-background/80 backdrop-blur-sm rounded-lg">
            <p className="text-sm text-foreground text-center leading-relaxed">{scene.script_text}</p>
          </div>
        </div>

        {/* Audio controls */}
        <div className="flex items-center gap-3 px-4 py-3 border-t border-border bg-card">
          <Button variant="ghost" size="icon" onClick={() => goScene(activeIndex - 1)} disabled={activeIndex === 0}>
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={togglePlay} disabled={scene.audio_status !== "completed"}>
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => goScene(activeIndex + 1)} disabled={activeIndex >= scenes.length - 1}>
            <SkipForward className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground w-10 text-right">{fmt(currentTime)}</span>
          <div className="flex-1">
            <Slider
              value={[currentTime]}
              max={duration || 1}
              step={0.1}
              onValueChange={seek}
              className="cursor-pointer"
            />
          </div>
          <span className="text-xs text-muted-foreground w-10">{fmt(duration)}</span>
          <Button variant="ghost" size="icon" onClick={() => setMuted(!muted)}>
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <div className="w-20">
            <Slider
              value={[muted ? 0 : volume]}
              max={1}
              step={0.01}
              onValueChange={(v) => { setVolume(v[0]); setMuted(false); }}
              className="cursor-pointer"
            />
          </div>
        </div>

        {/* Horizontal timeline */}
        <div className="border-t border-border bg-card px-2 py-2 overflow-hidden">
          <div className="overflow-x-auto overflow-y-hidden pb-1" ref={timelineRef}>
            <div className="flex gap-2 px-1" style={{ width: "max-content" }}>
              {scenes.map((s, idx) => {
                const thumbUrl = s.image_status === "completed" ? getAssetUrl(projectId, "images", s.image_file) : null;
                const isActive = idx === activeIndex;
                const dur = durations[s.scene_number];
                return (
                  <button
                    key={s.scene_number}
                    onClick={() => goScene(idx)}
                    className={`relative shrink-0 w-24 aspect-video rounded overflow-hidden border-2 transition-all ${
                      isActive ? "border-info ring-1 ring-info scale-105" : "border-border hover:border-muted-foreground"
                    }`}
                  >
                    {thumbUrl ? (
                      <img src={thumbUrl} alt={`Scene ${s.scene_number}`} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-secondary flex items-center justify-center">
                        <ImageIcon className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 py-0.5 flex items-center justify-between">
                      <span className="text-[10px] font-display text-primary font-bold">{s.scene_number}</span>
                      {dur && <span className="text-[10px] text-muted-foreground">{dur.toFixed(1)}s</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Right sidebar — prompt editor */}
      {sidebarOpen && (
        <div className="w-72 border-l border-border bg-card flex flex-col shrink-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border shrink-0">
            <h2 className="text-sm font-display text-foreground">Image Prompt</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Scene {scene.scene_number} of {scenes.length}</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
            <Textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              className="text-xs font-mono bg-secondary resize-none"
              rows={9}
            />
            <div className="flex flex-col gap-2">
              <Button size="sm" onClick={savePrompt} disabled={saving} className="w-full">
                {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                Save Prompt
              </Button>
              <Button size="sm" variant="outline" onClick={handleRegenPrompt} disabled={regenPrompt} className="w-full">
                {regenPrompt ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
                Regenerate Prompt (AI)
              </Button>
              <Button size="sm" variant="secondary" onClick={handleRegenImage} disabled={regenImage} className="w-full">
                {regenImage ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Regenerate Image
              </Button>
            </div>
          </div>
          <div className="border-t border-border p-4 shrink-0">
            <p className="text-xs text-muted-foreground mb-1">Script Text</p>
            <p className="text-xs text-foreground/80 leading-relaxed line-clamp-4">{scene.script_text}</p>
          </div>
        </div>
      )}
    </div>
  );
}
