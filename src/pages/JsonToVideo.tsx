import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { loadProviderSettings, saveProviderSettings, getAvailableVoices, COMPACT_STYLE_SUFFIX, ASPECT_RATIOS } from "@/lib/providers";
import { FileJson, Upload, Loader2, Play, AlertTriangle, CheckCircle2, Type, Image } from "lucide-react";
import { toast } from "sonner";

interface RawScene {
  scene_id?: string;
  narration_text: string;
  visual_prompt: string;
  motion_prompt?: string;
  overlay_text?: string | null;
}

function parseSceneJson(raw: string): { scenes: RawScene[]; title?: string; error: string | null } {
  if (!raw.trim()) return { scenes: [], error: null };
  try {
    let parsed = JSON.parse(raw);
    let extractedTitle: string | undefined;

    // Handle envelope object (e.g. {"title": "...", "scenes": [...]})
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.title === "string") {
        extractedTitle = parsed.title;
      }
      if (Array.isArray(parsed.scenes)) {
        parsed = parsed.scenes;
      } else {
        return { scenes: [], error: 'JSON object must contain a "scenes" array' };
      }
    }

    if (!Array.isArray(parsed)) return { scenes: [], error: 'JSON must be an array of scene objects or an object containing a "scenes" array' };
    if (parsed.length === 0) return { scenes: [], error: 'JSON must contain at least one scene' };

    const normalizedScenes: RawScene[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const s = parsed[i];
      if (!s || typeof s !== "object") {
        return { scenes: [], error: `Scene ${i + 1}: is not a valid object` };
      }

      // Check either Format A (narration_text) or Format B (script)
      const narration = s.narration_text || s.script;
      if (typeof narration !== "string" || !narration.trim()) {
        return { scenes: [], error: `Scene ${i + 1}: missing or empty "narration_text" or "script"` };
      }

      // Check either Format A (visual_prompt) or Format B (prompt)
      const visual = s.visual_prompt || s.prompt;
      if (typeof visual !== "string" || !visual.trim()) {
        return { scenes: [], error: `Scene ${i + 1}: missing or empty "visual_prompt" or "prompt"` };
      }

      normalizedScenes.push({
        scene_id: s.scene_id || s.image || String(i + 1).padStart(3, "0"),
        narration_text: narration.trim(),
        visual_prompt: visual.trim(),
        motion_prompt: s.motion_prompt || undefined,
        overlay_text: s.overlay_text || null,
      });
    }

    return { scenes: normalizedScenes, title: extractedTitle, error: null };
  } catch (e: any) {
    return { scenes: [], error: `JSON parse error: ${e.message}` };
  }
}

export default function JsonToVideo() {
  const navigate = useNavigate();
  const [settings] = useState(loadProviderSettings);
  const allVoices = getAvailableVoices(settings);

  const [jsonInput, setJsonInput] = useState("");
  const [title, setTitle] = useState("");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "1:1" | "9:16">(settings.aspectRatio || "16:9");
  const [voiceId, setVoiceId] = useState(settings.voiceId || "Dennis");
  const [imageMode, setImageMode] = useState<"style-prompt" | "refs">("style-prompt");
  const [style1, setStyle1] = useState<File | null>(null);
  const [style2, setStyle2] = useState<File | null>(null);
  const [stylePrompt, setStylePrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState("");
  const file1Ref = useRef<HTMLInputElement>(null);
  const file2Ref = useRef<HTMLInputElement>(null);

  const { scenes: parsedScenes, title: parsedTitle, error: parseError } = parseSceneJson(jsonInput);

  // Autofill title from JSON if available
  useEffect(() => {
    if (parsedTitle && !title) {
      setTitle(parsedTitle);
    }
  }, [parsedTitle, title]);

  const missingInworld = !settings.inworldApiKey;

  const canSubmit = !loading && parsedScenes.length > 0 && title.trim().length > 0;

  const handleGenerate = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setPhase("Creating project...");

    try {
      const currentSettings = loadProviderSettings();
      // Persist selected aspect ratio so the asset pipeline reads it via loadProviderSettings()
      saveProviderSettings({ ...currentSettings, aspectRatio });

      // Step 1: Create the project record on the server
      const fd = new FormData();
      fd.append("title", title.trim());
      fd.append("script", parsedScenes.map((s) => s.narration_text).join(" "));
      fd.append("imageProvider", currentSettings.imageProvider || "gemini");
      fd.append("ttsProvider", currentSettings.ttsProvider || "inworld");
      fd.append("voiceId", voiceId);
      fd.append("modelId", currentSettings.modelId || "inworld-tts-1.5-max");
      fd.append("splitMode", "smart");
      if (imageMode === "style-prompt" && stylePrompt.trim()) fd.append("stylePrompt", stylePrompt.trim());
      fd.append("aspectRatio", aspectRatio);
      if (imageMode === "refs" && style1) fd.append("style1", style1);
      if (imageMode === "refs" && style2) fd.append("style2", style2);

      const createRes = await fetch("/api/projects", { method: "POST", body: fd });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({ error: createRes.statusText }));
        throw new Error(err.error || "Failed to create project");
      }
      const { projectId } = await createRes.json();

      // Step 2: Submit scenes directly — bypasses script splitting entirely
      setPhase(`Submitting ${parsedScenes.length} scenes...`);
      const mappedScenes = parsedScenes.map((s, i) => ({
        scene_number: i + 1,
        scene_type: "location",
        historical_period: "historical",
        visual_priority: "environment",
        script_text: s.narration_text,
        tts_text: s.narration_text,
        image_prompt: s.visual_prompt,
        overlay_text: s.overlay_text ?? null,
        motion_prompt: s.motion_prompt || null,
        fallback_prompts: [],
        image_file: `${i + 1}.png`,
        audio_file: `${i + 1}.mp3`,
      }));

      const scenesRes = await fetch(`/api/projects/${projectId}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenes: mappedScenes }),
      });
      if (!scenesRes.ok) {
        const err = await scenesRes.json().catch(() => ({ error: scenesRes.statusText }));
        throw new Error(err.error || "Failed to submit scenes");
      }
      const { serverPipeline } = await scenesRes.json();

      const msg = serverPipeline
        ? `Project created! ${parsedScenes.length} scenes generating on server.`
        : `Project created with ${parsedScenes.length} scenes. Generating assets...`;
      toast.success(msg);
      navigate(`/projects/${projectId}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to create project");
      setLoading(false);
      setPhase("");
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 md:p-12">
      <div className="mx-auto max-w-3xl space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="flex items-center justify-center gap-3">
            <FileJson className="h-8 w-8 text-primary" />
            <h1 className="text-3xl md:text-4xl font-display tracking-wide text-foreground">
              JSON Import
            </h1>
          </div>
          <p className="text-muted-foreground text-lg">
            Paste a pre-structured scene list — no script splitting required
          </p>
          <Badge variant="outline" className="border-primary/30 text-primary">
            Direct Import Mode
          </Badge>
        </div>

        {/* Provider warnings */}
        {missingInworld && (
          <Alert className="border-warning/30 bg-warning/5">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertDescription className="text-warning">
              Inworld API key not configured — audio cannot be generated.{" "}
              <a href="/settings" className="underline">Go to Settings</a>
            </AlertDescription>
          </Alert>
        )}

        <Card className="border-border/50 glow-gold">
          <CardHeader>
            <CardTitle className="font-display text-xl text-foreground">Import Scenes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* JSON textarea */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Scene JSON</label>
              <Textarea
                placeholder={`[\n  {\n    "scene_id": "001",\n    "narration_text": "On the second day of January...",\n    "visual_prompt": "Wide shot of palace gates..."\n  }\n]`}
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                className="bg-secondary border-border min-h-[200px] font-mono text-xs"
                rows={10}
              />
              {jsonInput.trim() && (
                <div className="flex items-center gap-2 text-xs">
                  {parseError ? (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
                      <span className="text-destructive">{parseError}</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                      <span className="text-success">{parsedScenes.length} scenes parsed successfully</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Scene preview */}
            {parsedScenes.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Preview</label>
                <div className="space-y-2 max-h-56 overflow-y-auto rounded-md border border-border/50 p-3 bg-secondary/50">
                  {parsedScenes.slice(0, 3).map((s, i) => (
                    <div
                      key={i}
                      className="text-xs space-y-1 border-b border-border/30 pb-2 last:border-0 last:pb-0"
                    >
                      <div className="flex items-start gap-2">
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono shrink-0 mt-0.5">
                          {s.scene_id ?? String(i + 1).padStart(3, "0")}
                        </Badge>
                        <span className="text-foreground/80 italic leading-snug">{s.narration_text}</span>
                      </div>
                    </div>
                  ))}
                  {parsedScenes.length > 3 && (
                    <p className="text-xs text-muted-foreground text-center pt-1">
                      … and {parsedScenes.length - 3} more scene{parsedScenes.length - 3 !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Project title */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Project Title</label>
              <Input
                placeholder="The Fall of Granada"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="bg-secondary border-border"
              />
            </div>

            {/* Image style mode toggle */}
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Image Style Mode</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setImageMode("style-prompt")}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    imageMode === "style-prompt"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-secondary text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  <Type className="h-4 w-4" />
                  Style Prompt
                </button>
                <button
                  type="button"
                  onClick={() => setImageMode("refs")}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    imageMode === "refs"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-secondary text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  <Image className="h-4 w-4" />
                  Image References
                </button>
              </div>
            </div>

            {imageMode === "style-prompt" && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Style Prompt</label>
                <Textarea
                  value={stylePrompt}
                  onChange={(e) => setStylePrompt(e.target.value)}
                  className="bg-secondary border-border min-h-[100px] font-body text-xs leading-relaxed"
                  rows={5}
                  placeholder="Describe the visual style appended to every scene's visual_prompt..."
                />
                <p className="text-xs text-muted-foreground">
                  This suffix is appended to each scene's <code className="font-mono">visual_prompt</code> when generating images.
                  Leave blank to use the prompts as-is.
                </p>
              </div>
            )}

            {imageMode === "refs" && (
              <div className="grid grid-cols-2 gap-4">
                {(
                  [
                    { label: "Style Reference 1", file: style1, setFile: setStyle1, ref: file1Ref },
                    { label: "Style Reference 2", file: style2, setFile: setStyle2, ref: file2Ref },
                  ] as const
                ).map(({ label, file, setFile, ref }) => (
                  <div key={label} className="space-y-2">
                    <label className="text-sm font-medium text-foreground">{label}</label>
                    <input
                      type="file"
                      accept="image/*"
                      ref={ref}
                      className="hidden"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                    />
                    <button
                      type="button"
                      onClick={() => ref.current?.click()}
                      className="w-full aspect-video rounded-lg border-2 border-dashed border-border hover:border-primary/50 bg-secondary flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer overflow-hidden"
                    >
                      {file ? (
                        <img
                          src={URL.createObjectURL(file)}
                          alt={label}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <>
                          <Upload className="h-6 w-6 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">Upload Image</span>
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Voice */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Narration Voice</label>
              <Select value={voiceId} onValueChange={setVoiceId}>
                <SelectTrigger className="bg-secondary border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allVoices.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} — {v.description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Aspect Ratio */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Aspect Ratio</label>
              <Select value={aspectRatio} onValueChange={(v) => setAspectRatio(v as "16:9" | "1:1" | "9:16")}>
                <SelectTrigger className="bg-secondary border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASPECT_RATIOS.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Progress */}
            {loading && (
              <div className="space-y-2">
                <Progress value={phase.includes("Submitting") ? 60 : 20} className="h-2" />
                <p className="text-xs text-muted-foreground text-center animate-pulse">{phase}</p>
              </div>
            )}

            <Button
              onClick={handleGenerate}
              disabled={!canSubmit}
              className="w-full h-12 text-base font-display tracking-wider"
              size="lg"
            >
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  {phase || "Creating..."}
                </>
              ) : (
                <>
                  <Play className="h-5 w-5 mr-2" />
                  {parsedScenes.length > 0
                    ? `Create & Generate — ${parsedScenes.length} scene${parsedScenes.length !== 1 ? "s" : ""}`
                    : "Paste JSON above to continue"}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
