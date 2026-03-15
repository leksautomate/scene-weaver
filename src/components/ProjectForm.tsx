import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createProjectFrontend } from "@/lib/api";
import { loadProviderSettings, getAvailableVoices, COMPACT_STYLE_SUFFIX } from "@/lib/providers";
import { Upload, Scroll, Loader2, Sparkles, Type, Image } from "lucide-react";
import { toast } from "sonner";

export default function ProjectForm() {
  const navigate = useNavigate();
  const [settings] = useState(loadProviderSettings);
  const allVoices = getAvailableVoices(settings);
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [imageMode, setImageMode] = useState<"refs" | "style-prompt">("refs");
  const [style1, setStyle1] = useState<File | null>(null);
  const [style2, setStyle2] = useState<File | null>(null);
  const [stylePrompt, setStylePrompt] = useState(COMPACT_STYLE_SUFFIX);
  const [voiceId, setVoiceId] = useState(settings.voiceId || "Dennis");
  const [splitMode, setSplitMode] = useState<"smart" | "exact" | "duration">("smart");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const file1Ref = useRef<HTMLInputElement>(null);
  const file2Ref = useRef<HTMLInputElement>(null);

  const canSubmit = title.trim() && script.trim() && !loading &&
    (imageMode === "style-prompt" ? stylePrompt.trim().length > 0 : !!(style1 && style2));

  const handleSubmit = async () => {
    if (!canSubmit) return;

    const settings = loadProviderSettings();
    if (!settings.groqApiKey) {
      toast.error("Groq API key required. Go to Settings to configure it.");
      return;
    }

    setLoading(true);
    setPhase("Generating scene manifest...");
    setProgress(0);

    try {
      const { projectId, serverPipeline, sceneCount } = await createProjectFrontend(
        title.trim(),
        script.trim(),
        imageMode === "refs" ? style1 : null,
        imageMode === "refs" ? style2 : null,
        { voiceId, splitMode, stylePrompt: imageMode === "style-prompt" ? stylePrompt.trim() : undefined },
        {
          onPhase: (p) => setPhase(p),
          onSceneProgress: () => {},
          onStats: () => {},
        }
      );

      if (serverPipeline) {
        toast.success(`Project created! ${sceneCount} scenes generating in background.`);
      } else {
        toast.success(`Project created with ${sceneCount} scenes. Generating assets...`);
      }

      navigate(`/projects/${projectId}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to create project");
      setLoading(false);
      setPhase("");
      setProgress(0);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 md:p-12">
      <div className="mx-auto max-w-3xl space-y-8">
        <div className="text-center space-y-3">
          <div className="flex items-center justify-center gap-3">
            <Scroll className="h-8 w-8 text-primary" />
            <h1 className="text-3xl md:text-4xl font-display tracking-wide text-foreground">
              Historia
            </h1>
          </div>
          <p className="text-muted-foreground text-lg">
            Transform historical scripts into cinematic scene asset packs
          </p>
          <Badge variant="outline" className="border-primary/30 text-primary">
            POV History Mode
          </Badge>
        </div>

        <Card className="border-border/50 glow-gold">
          <CardHeader>
            <CardTitle className="font-display text-xl text-foreground">New Project</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Video Title</label>
              <Input
                placeholder="The Fall of an Empire"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="bg-secondary border-border"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Full Script</label>
              <Textarea
                placeholder="Paste your full history script here..."
                value={script}
                onChange={(e) => setScript(e.target.value)}
                className="bg-secondary border-border min-h-[200px] font-body"
                rows={10}
              />
              {script && (
                <p className="text-xs text-muted-foreground">
                  {script.split(/\s+/).length} words
                </p>
              )}
            </div>

            {/* Image mode toggle */}
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Image Style Mode</label>
              <div className="grid grid-cols-2 gap-2">
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
              </div>
            </div>

            {imageMode === "refs" && (
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: "Style Reference 1", file: style1, setFile: setStyle1, ref: file1Ref },
                  { label: "Style Reference 2", file: style2, setFile: setStyle2, ref: file2Ref },
                ].map(({ label, file, setFile, ref }) => (
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
                      className="w-full aspect-video rounded-lg border-2 border-dashed border-border hover:border-primary/50 bg-secondary flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      {file ? (
                        <img
                          src={URL.createObjectURL(file)}
                          alt={label}
                          className="w-full h-full object-cover rounded-lg"
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

            {imageMode === "style-prompt" && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Style Prompt</label>
                <Textarea
                  value={stylePrompt}
                  onChange={(e) => setStylePrompt(e.target.value)}
                  className="bg-secondary border-border min-h-[120px] font-body text-xs leading-relaxed"
                  rows={6}
                  placeholder="Describe the visual style for all generated images..."
                />
                <p className="text-xs text-muted-foreground">
                  This suffix is appended to every scene's image prompt. Groq will generate only the scene subject; the style is applied automatically.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
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

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Script Split Mode</label>
                <Select value={splitMode} onValueChange={(v) => setSplitMode(v as "smart" | "exact" | "duration")}>
                  <SelectTrigger className="bg-secondary border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="smart">Smart — 3 sentences per scene</SelectItem>
                    <SelectItem value="exact">Exact — 1 sentence per scene</SelectItem>
                    <SelectItem value="duration">Duration — adapts to speaking pace</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {loading && (
              <div className="space-y-2">
                <Progress value={progress} className="h-2" />
                <p className="text-xs text-muted-foreground text-center animate-pulse">{phase}</p>
              </div>
            )}

            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full h-12 text-base font-display tracking-wider"
              size="lg"
            >
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Generating Project...
                </>
              ) : (
                <>
                  <Sparkles className="h-5 w-5 mr-2" />
                  Generate Project
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
