import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { getProject, getAssetUrl, getDownloadUrl, regenerateAssetFrontend, bulkRegeneratePending, bulkRegenerateFailed, verifyAllAssets, startClipGeneration, getClipStatus, getClipsZipUrl, startRender, getRenderStatus, getRenderDownloadUrl, startAnimateScenes, getAnimateStatus, getAnimateZipUrl } from "@/lib/api";
import { regenerateImagePrompt } from "@/lib/providers";
import type { Scene } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Play, Pause, SkipBack, SkipForward,
  Volume2, VolumeX, Loader2, RefreshCw, Sparkles,
  PanelRightOpen, PanelRightClose, Save, Image as ImageIcon,
  Film, Download, CheckCircle2, AlertTriangle, FolderDown, Merge,
  Video, VideoOff, ScanSearch,
} from "lucide-react";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";
import { loadProviderSettings } from "@/lib/providers";

export default function ProjectPreview() {
  const { projectId } = useParams<{ projectId: string }>();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [projectTitle, setProjectTitle] = useState("");
  const [visualTheme, setVisualTheme] = useState<"impasto" | "ww2">("impasto");
  const [stylePrompt, setStylePrompt] = useState<string | undefined>(undefined);
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
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [projectStatus, setProjectStatus] = useState("");
  const [clipStatus, setClipStatus] = useState<"idle" | "generating" | "done" | "failed">("idle");
  const [clipProgress, setClipProgress] = useState(0);
  const [clipDone, setClipDone] = useState(0);
  const [clipTotal, setClipTotal] = useState(0);
  const [clipError, setClipError] = useState<string | null>(null);
  const [clipSkipped, setClipSkipped] = useState<Array<{ scene: number; reason: string }>>([]);
  const clipPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [renderStatus, setRenderStatus] = useState<"idle" | "rendering" | "done" | "failed">("idle");
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderTotal, setRenderTotal] = useState(0);
  const [renderResolution, setRenderResolution] = useState<import("@/lib/api").VideoResolution>("1080p");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderSkipped, setRenderSkipped] = useState<Array<{ scene: number; reason: string }>>([]);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [verifyingAssets, setVerifyingAssets] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState({ done: 0, total: 0, bad: 0 });

  const [animateSelected, setAnimateSelected] = useState<Set<number>>(new Set());
  const [animateStatus, setAnimateStatus] = useState<"idle" | "animating" | "done" | "failed">("idle");
  const [animateProgress, setAnimateProgress] = useState(0);
  const [animateDone, setAnimateDone] = useState(0);
  const [animateTotal, setAnimateTotal] = useState(0);
  const [animatedScenes, setAnimatedScenes] = useState<Set<number>>(new Set());
  const [animateError, setAnimateError] = useState<string | null>(null);
  const [animateSceneErrors, setAnimateSceneErrors] = useState<Record<number, string>>({});
  const animatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showFailedPanel, setShowFailedPanel] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [activeTab, setActiveTab] = useState<"scenes" | "video">("scenes");
  const [failedImageSelected, setFailedImageSelected] = useState<Set<number>>(new Set());
  const [failedAudioSelected, setFailedAudioSelected] = useState<Set<number>>(new Set());
  const [bulkRegenImageRunning, setBulkRegenImageRunning] = useState(false);
  const [bulkRegenAudioRunning, setBulkRegenAudioRunning] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const whooshRef = useRef<HTMLAudioElement | null>(null);
  const [videoOverlayText, setVideoOverlayText] = useState<string | null>(null);
  const [videoTypedChars, setVideoTypedChars] = useState(0);
  const videoLastSceneRef = useRef<number>(-1);
  const videoTypeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const OVERLAY_VISIBLE_SECS = 4;

  // Build per-scene start/end timecodes from audio durations (for video overlay)
  const sceneTimecodes = useMemo(() => {
    const settings = loadProviderSettings();
    const delaySec = settings.subtitleDelay ?? 0.8;
    
    let offset = 0;
    return scenes.map((s) => {
      const start = offset;
      const dur = durations[s.scene_number] ?? 0;
      
      offset += dur;
      
      const visualStart = start + delaySec;
      return { 
        sceneNumber: s.scene_number, 
        overlayText: s.overlay_text ?? null, 
        start: visualStart, 
        end: visualStart + OVERLAY_VISIBLE_SECS 
      };
    });
  }, [scenes, durations]);

  const playWhoosh = useCallback(() => {
    if (!whooshRef.current) {
      whooshRef.current = new Audio("/sfx/whoosh.MP3");
      whooshRef.current.volume = 0.4;
    }
    whooshRef.current.currentTime = 0;
    whooshRef.current.play().catch(() => {});
  }, []);

  const startVideoTypewriter = useCallback((text: string) => {
    if (videoTypeTimerRef.current) clearInterval(videoTypeTimerRef.current);
    setVideoOverlayText(text);
    setVideoTypedChars(0);
    playWhoosh();
    const total = text.length;
    const delay = Math.max(30, Math.min(80, 1400 / total));
    let i = 0;
    videoTypeTimerRef.current = setInterval(() => {
      i++;
      setVideoTypedChars(i);
      if (i >= total && videoTypeTimerRef.current) {
        clearInterval(videoTypeTimerRef.current);
        videoTypeTimerRef.current = null;
      }
    }, delay);
  }, [playWhoosh]);

  const handleVideoTimeUpdate = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;

    // Find scene whose start window contains current time
    const active = sceneTimecodes.find(
      tc => t >= tc.start && t <= tc.start + OVERLAY_VISIBLE_SECS && tc.overlayText
    );
    const activeNum = active?.sceneNumber ?? -1;

    if (activeNum !== videoLastSceneRef.current) {
      videoLastSceneRef.current = activeNum;
      if (active?.overlayText) {
        startVideoTypewriter(active.overlayText);
      } else {
        if (videoTypeTimerRef.current) clearInterval(videoTypeTimerRef.current);
        videoTypeTimerRef.current = null;
        setVideoOverlayText(null);
      }
    }
  }, [sceneTimecodes, startVideoTypewriter]);

  const fetchData = useCallback(async () => {
    if (!projectId) return;
    try {
      setDurations({});
      // Reset any mock-placeholder scenes to failed so user can regenerate them
      await fetch(`/api/projects/${projectId}/fix-mocks`, { method: "POST" }).catch(() => {});
      const data = await getProject(projectId);
      setProjectTitle(data.project.title);
      setProjectStatus(data.project.status);
      setScenes(data.scenes);
      setVisualTheme(data.project.settings?.visualTheme || "impasto");
      setStylePrompt(data.project.settings?.stylePrompt);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Restore clip state on mount
  useEffect(() => {
    if (!projectId) return;
    getClipStatus(projectId).then(s => {
      if (s.status === "generating") {
        setClipStatus("generating");
        setClipProgress(s.progress ?? 0);
        setClipDone(s.done ?? 0);
        setClipTotal(s.total ?? 0);
        startClipPolling(projectId);
      } else if (s.status === "done") {
        setClipStatus("done");
        setClipProgress(100);
        setClipDone(s.done ?? s.total ?? 0);
        setClipTotal(s.total ?? 0);
      }
    }).catch(() => {});
    return () => { if (clipPollRef.current) clearInterval(clipPollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Restore render state on mount (survives navigation away and back)
  useEffect(() => {
    if (!projectId) return;
    getRenderStatus(projectId).then(s => {
      if (s.status === "rendering") {
        setRenderStatus("rendering");
        setRenderProgress(s.progress ?? 0);
        setRenderTotal(s.total ?? 0);
        startPolling(projectId);
      } else if (s.status === "done") {
        setRenderStatus("done");
        setRenderProgress(100);
      }
    }).catch(() => {});
    return () => { if (renderPollRef.current) clearInterval(renderPollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (renderStatus === "done") {
      setActiveTab("video");
      toast.success("Video ready — watching now");
    }
  }, [renderStatus]);

  // Restore animate state on mount
  useEffect(() => {
    if (!projectId) return;
    getAnimateStatus(projectId).then(s => {
      if (s.status === "animating") {
        setAnimateStatus("animating");
        setAnimateProgress(s.progress ?? 0);
        setAnimateDone(s.done ?? 0);
        setAnimateTotal(s.total ?? 0);
        startAnimatePolling(projectId);
      } else if (s.status === "done") {
        setAnimateStatus("done");
        if (s.animatedSceneNums) setAnimatedScenes(new Set(s.animatedSceneNums));
      }
    }).catch(() => {});
    return () => { if (animatePollRef.current) clearInterval(animatePollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (projectStatus !== "processing") return;
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [fetchData, projectStatus]);

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
          if (isFinite(a.duration) && a.duration > 0) {
            setDurations((prev) => ({ ...prev, [s.scene_number]: a.duration }));
          }
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
    if (!settings.groqApiKeys?.some(k => k?.trim()) && !settings.googleCloudApiKey && !settings.inworldApiKey && !settings.arkApiKey) {
      toast.error("No API key configured for prompt generation. Update it in Settings.");
      return;
    }
    setRegenPrompt(true);
    try {
      const newPrompt = await regenerateImagePrompt(
        scene.script_text,
        settings.groqApiKeys,
        null, 
        settings.googleCloudApiKey,
        settings.claudeModel,
        settings.inworldApiKey,
        settings.textProvider,
        visualTheme,
        settings.geminiModel,
        stylePrompt,
        settings.arkApiKey,
        settings.deepseekModel
      );
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

  const handleBulkGenerateImages = async () => {
    if (!projectId) return;
    const pending = scenes.filter(s => s.image_status !== "completed");
    if (pending.length === 0) return;
    setBulkGenerating(true);
    setBulkProgress({ done: 0, total: pending.length });
    try {
      await bulkRegeneratePending(projectId, pending, (done, total) => {
        setBulkProgress({ done, total });
        fetchData();
      });
      toast.success("Images generated");
    } catch (e: any) { toast.error(e.message); }
    finally {
      setBulkGenerating(false);
      fetchData();
    }
  };

  const handleVerifyAssets = async () => {
    if (!projectId) return;
    setVerifyingAssets(true);
    setVerifyProgress({ done: 0, total: 0, bad: 0 });
    try {
      const { badImages, badAudio } = await verifyAllAssets(projectId, scenes, (done, total, bad) => {
        setVerifyProgress({ done, total, bad });
      });
      const totalBad = badImages + badAudio;
      if (totalBad === 0) {
        toast.success("All assets verified — no issues found.");
        return;
      }
      toast.warning(`Found ${totalBad} broken/missing asset(s) — regenerating...`);
      const { scenes: refreshed } = await getProject(projectId);
      const toFix = refreshed.filter(s => s.image_status === "failed" || s.audio_status === "failed");
      await bulkRegenerateFailed(projectId, toFix, (done, total) => {
        setVerifyProgress({ done, total, bad: totalBad });
        fetchData();
      });
      toast.success(`Verified and regenerated ${totalBad} scene asset(s).`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setVerifyingAssets(false);
      fetchData();
    }
  };

  const startClipPolling = (pid: string) => {
    if (clipPollRef.current) clearInterval(clipPollRef.current);
    clipPollRef.current = setInterval(async () => {
      try {
        const s = await getClipStatus(pid);
        setClipProgress(s.progress ?? 0);
        if (s.done !== undefined) setClipDone(s.done);
        if (s.total) setClipTotal(s.total);
        if (s.skipped) setClipSkipped(s.skipped);
        if (s.status === "done") {
          setClipStatus("done");
          clearInterval(clipPollRef.current!);
          if (s.skipped && s.skipped.length > 0) {
            toast.warning(`${s.total ?? s.done} clips ready, but ${s.skipped.length} scene(s) were skipped — missing files. Run Verify Assets, then re-render.`, { duration: 10000 });
          } else {
            toast.success(`${s.total ?? s.done} clips ready! Download as ZIP or merge into one video.`);
          }
        } else if (s.status === "failed") {
          setClipStatus("failed");
          setClipError(s.error ?? "Unknown error");
          clearInterval(clipPollRef.current!);
          toast.error(`Clip generation failed: ${s.error}`);
        }
      } catch { /* keep polling */ }
    }, 2000);
  };

  const handleGenerateClips = async () => {
    if (!projectId) return;
    setClipError(null);
    setClipStatus("generating");
    setClipProgress(0);
    setClipSkipped([]);
    try {
      const { total, missingFiles } = await startClipGeneration(projectId, renderResolution);
      setClipTotal(total);
      setClipDone(0);
      if (missingFiles && missingFiles.length > 0) {
        setClipSkipped(missingFiles.map(scene => ({ scene, reason: "file missing on disk" })));
        toast.warning(`Generating ${total} clips — ${missingFiles.length} scene(s) excluded (missing files). Run Verify Assets to fix.`, { duration: 10000 });
      } else {
        toast.success(`Generating ${total} clips at ${renderResolution}…`);
      }
      startClipPolling(projectId);
    } catch (e: any) {
      setClipStatus("failed");
      setClipError(e.message);
      toast.error(e.message);
    }
  };

  const startPolling = (pid: string) => {
    if (renderPollRef.current) clearInterval(renderPollRef.current);
    renderPollRef.current = setInterval(async () => {
      try {
        const s = await getRenderStatus(pid);
        setRenderProgress(s.progress ?? 0);
        if (s.total) setRenderTotal(s.total);
        if (s.skipped) setRenderSkipped(s.skipped);
        if (s.status === "done") {
          setRenderStatus("done");
          clearInterval(renderPollRef.current!);
          if (s.skipped && s.skipped.length > 0) {
            toast.warning(`Video rendered, but ${s.skipped.length} scene(s) were skipped — missing files. Run Verify Assets, then re-render.`, { duration: 10000 });
          } else {
            toast.success("Video rendered! Ready to download.");
          }
        } else if (s.status === "failed") {
          setRenderStatus("failed");
          setRenderError(s.error ?? "Unknown error");
          clearInterval(renderPollRef.current!);
          toast.error(`Render failed: ${s.error}`);
        }
      } catch { /* keep polling */ }
    }, 2000);
  };

  const handleRender = async () => {
    if (!projectId) return;
    setRenderError(null);
    setRenderStatus("rendering");
    setRenderProgress(0);
    setRenderSkipped([]);
    try {
      const { total } = await startRender(projectId, renderResolution);
      setRenderTotal(total);
      toast.success(`Rendering ${total} scenes at ${renderResolution} in background…`);
      startPolling(projectId);
    } catch (e: any) {
      setRenderStatus("failed");
      setRenderError(e.message);
      toast.error(e.message);
    }
  };

  const startAnimatePolling = (pid: string) => {
    if (animatePollRef.current) clearInterval(animatePollRef.current);
    animatePollRef.current = setInterval(async () => {
      try {
        const s = await getAnimateStatus(pid);
        setAnimateProgress(s.progress ?? 0);
        if (s.done !== undefined) setAnimateDone(s.done);
        if (s.total) setAnimateTotal(s.total);
        if (s.status === "done") {
          setAnimateStatus("done");
          clearInterval(animatePollRef.current!);
          if (s.sceneErrors) setAnimateSceneErrors(s.sceneErrors);
          if (s.animatedSceneNums) setAnimatedScenes(new Set(s.animatedSceneNums));
          const failCount = Object.keys(s.sceneErrors ?? {}).length;
          if (s.done === 0) {
            toast.error(`Veo animation failed for all scenes. Check scene errors below.`);
          } else if (failCount > 0) {
            toast.warning(`${s.done} scenes animated, ${failCount} failed. See errors below.`);
          } else {
            toast.success(`${s.done} scenes animated with Veo! Generate clips to use them.`);
          }
        } else if (s.status === "failed") {
          setAnimateStatus("failed");
          setAnimateError(s.error ?? "Unknown error");
          clearInterval(animatePollRef.current!);
          toast.error(`Animation failed: ${s.error}`);
        }
      } catch { /* keep polling */ }
    }, 3000);
  };

  const handleAnimateScenes = async () => {
    if (!projectId || animateSelected.size === 0) return;
    const settings = loadProviderSettings();
    setAnimateError(null);
    setAnimateStatus("animating");
    setAnimateProgress(0);
    try {
      const { total } = await startAnimateScenes(projectId, Array.from(animateSelected));
      setAnimateTotal(total);
      setAnimateDone(0);
      toast.success(`Animating ${total} scenes with Gemini…`);
      startAnimatePolling(projectId);
    } catch (e: any) {
      setAnimateStatus("failed");
      setAnimateError(e.message);
      toast.error(e.message);
    }
  };

  const toggleAnimateScene = (sceneNum: number) => {
    setAnimateSelected(prev => {
      const next = new Set(prev);
      if (next.has(sceneNum)) next.delete(sceneNum);
      else next.add(sceneNum);
      return next;
    });
  };

  const selectAllForVeo = () => {
    // Select all scenes with completed images that haven't been animated yet
    const eligible = scenes
      .filter(s => s.image_status === "completed" && !animatedScenes.has(s.scene_number))
      .map(s => s.scene_number);
    setAnimateSelected(new Set(eligible));
  };

  const deselectAllVeo = () => setAnimateSelected(new Set());

  const failedImages = scenes.filter(s => s.image_status === "failed");
  const failedAudios = scenes.filter(s => s.audio_status === "failed");

  const handleBulkRegenImages = async () => {
    if (!projectId || failedImageSelected.size === 0) return;
    setBulkRegenImageRunning(true);
    const nums = Array.from(failedImageSelected);
    let ok = 0;
    for (const num of nums) {
      try {
        await regenerateAssetFrontend(projectId, num, "image");
        ok++;
      } catch (e: any) {
        toast.error(`Scene ${num}: ${e.message}`);
      }
      await fetchData();
    }
    setBulkRegenImageRunning(false);
    setFailedImageSelected(new Set());
    if (ok > 0) toast.success(`${ok} image(s) regenerated`);
  };

  const handleBulkRegenAudios = async () => {
    if (!projectId || failedAudioSelected.size === 0) return;
    setBulkRegenAudioRunning(true);
    const nums = Array.from(failedAudioSelected);
    let ok = 0;
    for (const num of nums) {
      try {
        await regenerateAssetFrontend(projectId, num, "audio");
        ok++;
      } catch (e: any) {
        toast.error(`Scene ${num}: ${e.message}`);
      }
      await fetchData();
    }
    setBulkRegenAudioRunning(false);
    setFailedAudioSelected(new Set());
    if (ok > 0) toast.success(`${ok} audio(s) regenerated`);
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

  const imgUrl = scene.image_status === "completed" && scene.image_file ? getAssetUrl(projectId, "images", scene.image_file) : null;

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
          <div className="ml-auto flex items-center gap-2">
            {scenes.filter(s => s.image_status !== "completed").length > 0 && (
              <Button size="sm" variant="secondary" onClick={handleBulkGenerateImages} disabled={bulkGenerating || regenImage}>
                {bulkGenerating ? (
                  <><Loader2 className="h-3 w-3 animate-spin mr-1" />Generating {bulkProgress.done}/{bulkProgress.total}</>
                ) : (
                  <><RefreshCw className="h-3 w-3 mr-1" />Generate Missing ({scenes.filter(s => s.image_status !== "completed").length})</>
                )}
              </Button>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={handleVerifyAssets}
              disabled={verifyingAssets || bulkGenerating || regenImage}
              title="Check every completed scene's image and audio file actually exists on disk, and regenerate any that are missing or broken"
            >
              {verifyingAssets ? (
                <><Loader2 className="h-3 w-3 animate-spin mr-1" />Verifying {verifyProgress.done}/{verifyProgress.total}{verifyProgress.bad > 0 ? ` (${verifyProgress.bad} bad)` : ""}</>
              ) : (
                <><ScanSearch className="h-3 w-3 mr-1" />Verify Assets</>
              )}
            </Button>

            {/* Failed scenes indicator */}
            {(failedImages.length > 0 || failedAudios.length > 0) && (
              <Button
                size="sm"
                variant={showFailedPanel ? "default" : "outline"}
                className={`text-xs ${!showFailedPanel ? "text-destructive border-destructive/50" : ""}`}
                onClick={() => setShowFailedPanel(v => !v)}
              >
                <AlertTriangle className="h-3 w-3 mr-1" />
                {failedImages.length + failedAudios.length} Failed
              </Button>
            )}

            {/* Resolution picker */}
            <div className="flex rounded-md border border-border overflow-hidden text-xs">
              {(["480p", "720p", "1080p", "1440p"] as const).map(r => (
                <button
                  key={r}
                  onClick={() => setRenderResolution(r)}
                  className={`px-2 py-1 transition-colors ${renderResolution === r ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
                >
                  {r}
                </button>
              ))}
            </div>

            {/* Veo Animation — select scenes then animate */}
            {animateStatus === "idle" && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="text-xs" onClick={selectAllForVeo}>
                  Select All
                </Button>
                {animateSelected.size > 0 && (
                  <>
                    <Button size="sm" variant="ghost" className="text-xs" onClick={deselectAllVeo}>
                      Deselect
                    </Button>
                    <Button size="sm" variant="secondary" onClick={handleAnimateScenes}>
                      <Video className="h-3 w-3 mr-1" />Animate {animateSelected.size} with Veo
                    </Button>
                  </>
                )}
              </div>
            )}
            {animateStatus === "animating" && (
              <Button size="sm" variant="secondary" disabled>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Veo {animateDone}/{animateTotal} ({animateProgress}%)
              </Button>
            )}
            {animateStatus === "done" && (
              <div className="flex items-center gap-1">
                {animateDone > 0
                  ? <CheckCircle2 className="h-3 w-3 text-success" />
                  : <AlertTriangle className="h-3 w-3 text-destructive" />}
                <span className="text-xs text-muted-foreground">
                  {animateDone}/{animateTotal} animated
                  {Object.keys(animateSceneErrors).length > 0 && ` (${Object.keys(animateSceneErrors).length} failed)`}
                </span>
                {projectId && animateDone > 0 && (
                  <Button size="sm" variant="outline" onClick={async () => {
                    try {
                      const r = await fetch(getAnimateZipUrl(projectId));
                      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
                      const blob = await r.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = "animated-scenes.zip"; a.click();
                      URL.revokeObjectURL(url);
                    } catch (e: any) { toast.error(`Download failed: ${e.message}`); }
                  }}>
                    <Video className="h-3 w-3 mr-1" />Veo ZIP
                  </Button>
                )}
                {Object.keys(animateSceneErrors).length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => {
                    const msgs = Object.entries(animateSceneErrors).map(([n, e]) => `Scene ${n}: ${e}`).join("\n");
                    toast.error(msgs, { duration: 8000 });
                  }}>
                    View errors
                  </Button>
                )}
              </div>
            )}
            {animateStatus === "failed" && (
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-destructive" title={animateError ?? ""} />
                <Button size="sm" variant="outline" onClick={() => setAnimateStatus("idle")}>Retry Veo</Button>
              </div>
            )}

            {/* Skipped-scene warning — surfaces scenes dropped from the last render due to missing files */}
            {(clipSkipped.length > 0 || renderSkipped.length > 0) && (
              <Button
                size="sm"
                variant="outline"
                className="text-xs text-destructive border-destructive/50"
                onClick={() => {
                  const list = (renderSkipped.length > 0 ? renderSkipped : clipSkipped)
                    .map(s => `Scene ${s.scene}: ${s.reason}`).join("\n");
                  toast.error(list, { duration: 12000 });
                }}
              >
                <AlertTriangle className="h-3 w-3 mr-1" />
                {(renderSkipped.length > 0 ? renderSkipped : clipSkipped).length} scene(s) skipped — view
              </Button>
            )}

            {/* Phase 1: Generate Clips */}
            {clipStatus === "idle" && (
              <Button size="sm" variant="default" onClick={handleGenerateClips}>
                <Film className="h-3 w-3 mr-1" />Generate Clips
              </Button>
            )}
            {clipStatus === "generating" && (
              <Button size="sm" variant="default" disabled>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Generating {clipDone}/{clipTotal} clips ({clipProgress}%)
              </Button>
            )}
            {clipStatus === "failed" && (
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-destructive" title={clipError ?? ""} />
                <Button size="sm" variant="outline" onClick={() => setClipStatus("idle")}>Retry Clips</Button>
              </div>
            )}

            {/* Phase 2: after clips are done — Download ZIP or Merge */}
            {clipStatus === "done" && projectId && renderStatus === "idle" && (
              <div className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-success" />
                <a href={getClipsZipUrl(projectId)} download="clips.zip">
                  <Button size="sm" variant="outline">
                    <FolderDown className="h-3 w-3 mr-1" />Download ZIP
                  </Button>
                </a>
                <Button size="sm" variant="ghost" onClick={() => setClipStatus("idle")}>
                  Re-generate Clips
                </Button>
                <Button size="sm" variant="default" onClick={handleRender}>
                  <Merge className="h-3 w-3 mr-1" />Merge Videos
                </Button>
              </div>
            )}

            {/* Merge in progress */}
            {renderStatus === "rendering" && (
              <Button size="sm" variant="default" disabled>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Merging {renderProgress}%
              </Button>
            )}

            {/* Merge done */}
            {renderStatus === "done" && projectId && (
              <div className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-success" />
                <a href={getClipsZipUrl(projectId)} download="clips.zip">
                  <Button size="sm" variant="outline">
                    <FolderDown className="h-3 w-3 mr-1" />ZIP
                  </Button>
                </a>
                <a href={getRenderDownloadUrl(projectId)} download>
                  <Button size="sm" variant="default">
                    <Download className="h-3 w-3 mr-1" />Download MP4
                  </Button>
                </a>
                <Button size="sm" variant="ghost" onClick={() => { setRenderStatus("idle"); setClipStatus("idle"); }}>Re-do</Button>
              </div>
            )}

            {/* Merge failed */}
            {renderStatus === "failed" && (
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-destructive" title={renderError ?? ""} />
                <Button size="sm" variant="outline" onClick={() => setRenderStatus("idle")}>Retry Merge</Button>
              </div>
            )}

            <Button
              variant={showDownloads ? "secondary" : "ghost"}
              size="sm"
              className="text-xs gap-1"
              onClick={() => setShowDownloads(v => !v)}
            >
              <FolderDown className="h-3.5 w-3.5" />Downloads
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(!sidebarOpen)}>
              {sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Failed scenes panel */}
        {showFailedPanel && (failedImages.length > 0 || failedAudios.length > 0) && (
          <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-3 space-y-2 shrink-0">
            {failedImages.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-destructive shrink-0">Images ({failedImages.length}):</span>
                <div className="flex-1 flex flex-wrap gap-x-3 gap-y-1">
                  {failedImages.map(s => (
                    <label key={s.scene_number} className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                      <input
                        type="checkbox"
                        className="w-3 h-3 accent-primary"
                        checked={failedImageSelected.has(s.scene_number)}
                        onChange={e => setFailedImageSelected(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.scene_number); else next.delete(s.scene_number);
                          return next;
                        })}
                      />
                      #{s.scene_number}
                    </label>
                  ))}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" className="text-xs h-6 px-2"
                    onClick={() => setFailedImageSelected(new Set(failedImages.map(s => s.scene_number)))}>
                    All
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs h-6"
                    disabled={failedImageSelected.size === 0 || bulkRegenImageRunning}
                    onClick={handleBulkRegenImages}>
                    {bulkRegenImageRunning ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                    Regen {failedImageSelected.size > 0 ? `(${failedImageSelected.size})` : "Images"}
                  </Button>
                </div>
              </div>
            )}
            {failedAudios.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-destructive shrink-0">Audio ({failedAudios.length}):</span>
                <div className="flex-1 flex flex-wrap gap-x-3 gap-y-1">
                  {failedAudios.map(s => (
                    <label key={s.scene_number} className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                      <input
                        type="checkbox"
                        className="w-3 h-3 accent-primary"
                        checked={failedAudioSelected.has(s.scene_number)}
                        onChange={e => setFailedAudioSelected(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.scene_number); else next.delete(s.scene_number);
                          return next;
                        })}
                      />
                      #{s.scene_number}
                    </label>
                  ))}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" className="text-xs h-6 px-2"
                    onClick={() => setFailedAudioSelected(new Set(failedAudios.map(s => s.scene_number)))}>
                    All
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs h-6"
                    disabled={failedAudioSelected.size === 0 || bulkRegenAudioRunning}
                    onClick={handleBulkRegenAudios}>
                    {bulkRegenAudioRunning ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                    Regen {failedAudioSelected.size > 0 ? `(${failedAudioSelected.size})` : "Audio"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Downloads panel */}
        {showDownloads && projectId && (
          <div className="border-b border-border bg-card px-4 py-3 shrink-0">
            <p className="text-xs font-medium text-foreground mb-2">Download Files</p>
            <div className="flex flex-wrap gap-2">
              <a href={getDownloadUrl(projectId)} download>
                <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5">
                  <Download className="h-3 w-3" />All Assets (Images + Audio)
                </Button>
              </a>
              <a href={getClipsZipUrl(projectId)} download="clips.zip">
                <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5">
                  <Film className="h-3 w-3" />Scene Clips ZIP
                </Button>
              </a>
              <a href={getRenderDownloadUrl(projectId)} download>
                <Button size="sm" variant="default" className="text-xs h-7 gap-1.5">
                  <Download className="h-3 w-3" />Final Video (MP4)
                </Button>
              </a>
              {animateDone > 0 && (
                <a href={getAnimateZipUrl(projectId)} download="animated-scenes.zip">
                  <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5">
                    <Video className="h-3 w-3" />Veo Clips ZIP
                  </Button>
                </a>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Files also available directly at <code className="font-mono text-foreground/70">/uploads/{projectId}/</code> on the server
            </p>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex border-b border-border bg-card shrink-0">
          <button
            onClick={() => setActiveTab("scenes")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
              activeTab === "scenes"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Scenes
          </button>
          {renderStatus === "done" && (
            <button
              onClick={() => setActiveTab("video")}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === "video"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Video
            </button>
          )}
        </div>

        {/* Image viewer / Video player */}
        {activeTab === "video" ? (
          <div className="flex-1 bg-black relative flex items-center justify-center overflow-hidden">
            <video
              ref={videoRef}
              key={projectId}
              src={`/uploads/${projectId}/render/output.mp4`}
              controls
              onTimeUpdate={handleVideoTimeUpdate}
              className="w-full h-full object-contain"
            />
            {videoOverlayText && (
              <div
                className="absolute pointer-events-none select-none"
                style={{ left: "4%", bottom: "12%", right: "4%" }}
              >
                <span style={{
                  fontFamily: "'Courier New', Courier, monospace",
                  fontWeight: "bold",
                  fontSize: "clamp(1.1rem, 3.5vw, 2.6rem)",
                  color: "#ffffff",
                  textShadow: "3px 3px 0 rgba(0,0,0,0.95), -1px -1px 0 rgba(0,0,0,0.6)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}>
                  {videoOverlayText.slice(0, videoTypedChars)}
                  {videoTypedChars < videoOverlayText.length && (
                    <span style={{ fontWeight: 100, marginLeft: 2, animation: "overlayBlink 0.75s infinite" }}>|</span>
                  )}
                </span>
              </div>
            )}
            <style>{`@keyframes overlayBlink { 0%,100%{opacity:0} 50%{opacity:1} }`}</style>
          </div>
        ) : (
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
        )}

        {activeTab === "scenes" && (
          <>
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
        <div className="border-t border-border bg-card px-2 pt-2 shrink-0" style={{ height: "90px" }}>
          <div className="overflow-x-auto overflow-y-hidden h-full" ref={timelineRef}>
            <div className="flex gap-2 px-1 items-center" style={{ width: "max-content", minHeight: "100%" }}>
              {scenes.map((s, idx) => {
                const thumbUrl = s.image_status === "completed" && s.image_file ? getAssetUrl(projectId, "images", s.image_file) : null;
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
                      <div className="flex items-center gap-0.5">
                        {dur && isFinite(dur) && <span className="text-[10px] text-muted-foreground">{dur.toFixed(1)}s</span>}
                        {s.image_status === "completed" && (
                          <button
                            onClick={e => { e.stopPropagation(); toggleAnimateScene(s.scene_number); }}
                            className={`ml-0.5 rounded transition-colors ${
                              animatedScenes.has(s.scene_number)
                                ? "text-emerald-400"
                                : animateSelected.has(s.scene_number)
                                  ? "text-info"
                                  : "text-muted-foreground hover:text-foreground"
                            }`}
                            title={
                              animatedScenes.has(s.scene_number)
                                ? "Already animated with Veo ✓"
                                : animateSelected.has(s.scene_number)
                                  ? "Remove from Veo animation"
                                  : "Add to Veo animation"
                            }
                          >
                            <Video className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
          </>
        )}
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
          <div className="border-t border-border p-4 shrink-0 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Script Text</p>
              <p className="text-xs text-foreground/80 leading-relaxed line-clamp-4">{scene.script_text}</p>
            </div>
            {scene.image_status === "completed" && (
              <>
                {animatedScenes.has(scene.scene_number) && (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <Video className="h-3 w-3" />
                    <span>Animated with Veo ✓</span>
                  </div>
                )}
                <Button
                  size="sm"
                  variant={animateSelected.has(scene.scene_number) ? "default" : "outline"}
                  onClick={() => toggleAnimateScene(scene.scene_number)}
                  className="w-full"
                >
                  {animateSelected.has(scene.scene_number)
                    ? <><VideoOff className="h-3 w-3 mr-1" />Remove from Veo</>
                    : animatedScenes.has(scene.scene_number)
                      ? <><Video className="h-3 w-3 mr-1" />Re-animate with Veo</>
                      : <><Video className="h-3 w-3 mr-1" />Animate with Veo</>
                  }
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
