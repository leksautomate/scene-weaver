import { useState, useMemo, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Copy, Download, CheckCircle2, AlertCircle, X, Trash2, History, PlusCircle } from "lucide-react";
import { loadProviderSettings, COMPACT_STYLE_SUFFIX, COMPACT_WWII_STYLE_SUFFIX } from "@/lib/providers";
import { estimateSceneCount, type OutputScene } from "@/lib/scriptToJson";

const COMPACT_DOODLE_STYLE_SUFFIX =
  `simple hand-drawn digital doodle, felt-tip pen sketch, rough marker drawing style, rough imperfect black outlines, simple flat marker and crayon color fills with slight white gaps near outlines, soft muted mustard yellow, soft blue, warm red, and light gray palette on solid white background, no clean vector lines, no perfect geometric shapes, no 3D elements, no gradients, no photorealism, 16:9`;

const DURATION_OPTIONS = [
  { value: 10, label: "10s", words: 19 },
  { value: 15, label: "15s", words: 29 },
  { value: 20, label: "20s", words: 38 },
  { value: 30, label: "30s", words: 57 },
] as const;

type Style = "impasto" | "ww2" | "doodle" | "custom";
type Provider = "groq" | "inworld" | "claude" | "gemini";

interface JobProgress {
  phase: "pass1" | "pass2";
  done: number;
  total: number;
  partialScenes?: OutputScene[];
}

interface JobParams {
  title: string;
  script: string;
  secondsPerScene: number;
  style: "impasto" | "ww2" | "doodle" | "custom";
  provider: "groq" | "inworld" | "claude" | "gemini";
  apiKey?: string;
  claudeModel?: string;
  geminiModel?: string;
}

interface Job {
  id: string;
  status: "running" | "completed" | "failed";
  progress: JobProgress;
  result: { title: string; scenes: OutputScene[] } | null;
  error: string | null;
  createdAt: number;
  params?: Omit<JobParams, "apiKey">;
}

function highlightJson(json: string): string {
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")\s*:/g, '<span class="text-violet-400">$1</span>:')
    .replace(/: ("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")/g, ': <span class="text-emerald-400">$1</span>')
    .replace(/: (null)/g, ': <span class="text-slate-500">$1</span>');
}

function formatJobDate(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function ScriptToJson() {
  const { toast } = useToast();
  const settings = useMemo(() => loadProviderSettings(), []);

  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [secondsPerScene, setSecondsPerScene] = useState<10 | 15 | 20 | 30>(15);
  const [style, setStyle] = useState<Style>("impasto");
  const [stylePrompt, setStylePrompt] = useState(COMPACT_STYLE_SUFFIX);
  const [provider, setProvider] = useState<Provider>("groq");

  const handleStyleChange = (s: Style) => {
    setStyle(s);
    if (s === "ww2") {
      setStylePrompt(COMPACT_WWII_STYLE_SUFFIX);
    } else if (s === "doodle") {
      setStylePrompt(COMPACT_DOODLE_STYLE_SUFFIX);
    } else if (s === "custom") {
      setStylePrompt("");
    } else {
      setStylePrompt(COMPACT_STYLE_SUFFIX);
    }
  };

  const [jobsList, setJobsList] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"new" | "history">("new");
  const [rightTab, setRightTab] = useState<"json" | "script">("json");

  const selectedJob = useMemo(() => jobsList.find((j) => j.id === selectedJobId) || null, [jobsList, selectedJobId]);

  // Auto-switch right panel tab based on selected job status
  useEffect(() => {
    if (selectedJob) {
      if (selectedJob.status === "failed") {
        setRightTab("script");
      } else {
        setRightTab("json");
      }
    }
  }, [selectedJobId, selectedJob?.status]);

  const displayOutput = useMemo(() => {
    if (!selectedJob) return null;
    if (selectedJob.status === "completed") return selectedJob.result;
    if (selectedJob.status === "running") {
      const partials = selectedJob.progress?.partialScenes || [];
      if (partials.length > 0) {
        return { title: selectedJob.result?.title || "Generating", scenes: partials };
      }
    }
    return null;
  }, [selectedJob]);

  const jsonString = useMemo(() => (displayOutput ? JSON.stringify(displayOutput, null, 2) : ""), [displayOutput]);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/script-to-json");
      if (res.ok) {
        const data = await res.json();
        setJobsList(data);
      }
    } catch (e) {
      console.error("Failed to fetch job history:", e);
    }
  }, []);

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/script-to-json/${jobId}`);
      if (!res.ok) {
        if (res.status === 404) {
          fetchJobs();
          setSelectedJobId(null);
          toast({ title: "Job not found", variant: "destructive" });
        }
        return;
      }
      const job: Job = await res.json();
      setJobsList((prev) => prev.map((j) => (j.id === jobId ? job : j)));
      if (job.status !== "running") {
        fetchJobs();
      }
    } catch {
      // Network hiccup — will retry on next poll tick
    }
  }, [fetchJobs, toast]);

  // Load jobs list on mount
  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Set up polling for the selected job if it is running
  useEffect(() => {
    if (!selectedJobId) return;
    const currentJob = jobsList.find((j) => j.id === selectedJobId);
    if (!currentJob || currentJob.status !== "running") return;

    const interval = setInterval(() => {
      pollJob(selectedJobId);
    }, 2000);

    return () => clearInterval(interval);
  }, [selectedJobId, jobsList, pollJob]);

  // Auto-select the running job on mount if one exists
  useEffect(() => {
    const runningJob = jobsList.find((j) => j.status === "running");
    if (runningJob && !selectedJobId) {
      setSelectedJobId(runningJob.id);
      setActiveTab("history");
    }
  }, [jobsList, selectedJobId]);

  const handleDeleteJob = useCallback(async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/script-to-json/${jobId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast({ title: "Job deleted from history" });
        if (selectedJobId === jobId) {
          setSelectedJobId(null);
        }
        fetchJobs();
      } else {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete job");
      }
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    }
  }, [selectedJobId, fetchJobs, toast]);

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const estimatedScenes = wordCount > 0 ? estimateSceneCount(wordCount, secondsPerScene) : 0;
  const apiKey = provider === "groq"
    ? (settings.groqApiKeys?.find(k => k?.trim()) || "")
    : provider === "claude"
    ? settings.googleCloudApiKey 
    : provider === "gemini"
    ? settings.googleCloudApiKey
    : settings.inworldApiKey;
  
  const generating = useMemo(() => selectedJob?.status === "running", [selectedJob]);
  const canGenerate = title.trim().length > 0 && wordCount > 0 && !generating;

  const handleGenerate = useCallback(async () => {
    try {
      const res = await fetch("/api/script-to-json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          script: script.trim(),
          secondsPerScene,
          style,
          provider,
          apiKey,
          groqApiKeys: provider === "groq" ? settings.groqApiKeys?.filter(k => k?.trim()) : undefined,
          claudeModel: settings.claudeModel,
          geminiModel: settings.geminiModel,
          groqModel: settings.groqModel,
          stylePrompt: stylePrompt.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `Failed to start job (HTTP ${res.status})`);
      }
      const { jobId } = await res.json();
      setSelectedJobId(jobId);
      setActiveTab("history");
      fetchJobs();
    } catch (e: any) {
      toast({ title: "Generation failed", description: e.message, variant: "destructive" });
    }
  }, [title, script, secondsPerScene, style, provider, apiKey, settings.claudeModel, fetchJobs, toast]);

  const handleLoadAndRetry = useCallback(() => {
    if (!selectedJob?.params) return;
    const { title, script, secondsPerScene, style, provider, stylePrompt } = selectedJob.params as any;
    setTitle(title || "");
    setScript(script || "");
    setSecondsPerScene((secondsPerScene as 10 | 15 | 20 | 30) || 15);
    setStyle(style || "impasto");
    setStylePrompt(
      stylePrompt ??
        (style === "ww2"
          ? COMPACT_WWII_STYLE_SUFFIX
          : style === "doodle"
          ? COMPACT_DOODLE_STYLE_SUFFIX
          : style === "custom"
          ? ""
          : COMPACT_STYLE_SUFFIX)
    );
    setProvider(provider || "groq");
    setActiveTab("new");
    toast({
      title: "Settings loaded",
      description: "Original script and generator settings loaded into the editor.",
    });
  }, [selectedJob, toast]);

  async function handleCopy() {
    if (!jsonString) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(jsonString);
        toast({ title: "Copied to clipboard" });
      } else {
        throw new Error("Clipboard API not available");
      }
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = jsonString;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const successful = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (successful) {
          toast({ title: "Copied to clipboard" });
        } else {
          throw new Error("Fallback copy failed");
        }
      } catch (err) {
        toast({ title: "Copy failed", description: "Clipboard access denied", variant: "destructive" });
      }
    }
  }

  function handleDownload() {
    if (!jsonString) return;
    const slug = (displayOutput?.title ?? "output").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="h-full flex overflow-hidden bg-background">
      {/* ── Left Panel ── */}
      <div className="w-[420px] shrink-0 flex flex-col border-r border-border overflow-hidden bg-card">
        <div className="px-5 py-4 border-b border-border shrink-0">
          <h1 className="text-lg font-display font-semibold">Script → JSON</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Generate a cinematic scene manifest from your documentary script
          </p>
        </div>

        {/* Tab Headers */}
        <div className="flex border-b border-border shrink-0 bg-muted/20">
          <button
            onClick={() => setActiveTab("new")}
            className={`flex-1 py-3 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 transition-all ${
              activeTab === "new"
                ? "border-primary text-primary bg-background"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <PlusCircle className="h-3.5 w-3.5" />
            New Generator
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`flex-1 py-3 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 transition-all ${
              activeTab === "history"
                ? "border-primary text-primary bg-background"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className="h-3.5 w-3.5" />
            History ({jobsList.length})
          </button>
        </div>

        {activeTab === "new" ? (
          <div className="flex flex-col gap-4 p-5 flex-1 overflow-y-auto">
            {/* Title */}
            <div>
              <label className="text-xs font-medium text-primary uppercase tracking-wide block mb-1.5">
                Documentary Title
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="The Bridge at Remagen - March 7 1945"
                disabled={generating}
              />
            </div>

            {/* Script */}
            <div className="flex flex-col flex-1 min-h-[180px]">
              <label className="text-xs font-medium text-primary uppercase tracking-wide block mb-1.5">
                Script
              </label>
              <Textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder="Paste your documentary script here..."
                className="flex-1 min-h-[140px] resize-none font-mono text-xs"
                disabled={generating}
              />
              <div className="text-xs text-muted-foreground mt-1 text-right">
                {wordCount > 0 ? `${wordCount.toLocaleString()} words · ~${Math.round(wordCount / 117)} min` : ""}
              </div>
            </div>

            {/* Scene Duration */}
            <div>
              <label className="text-xs font-medium text-primary uppercase tracking-wide block mb-1">
                Scene Duration
              </label>
              <p className="text-xs text-muted-foreground mb-2">
                How long each scene displays — sets narration length per scene
              </p>
              <div className="grid grid-cols-4 gap-2">
                {DURATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setSecondsPerScene(opt.value as 10 | 15 | 20 | 30)}
                    disabled={generating}
                    className={`rounded-lg border py-2 px-1 text-center transition-colors ${
                      secondsPerScene === opt.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    <div className="text-sm font-bold">{opt.label}</div>
                    <div className="text-[10px] opacity-70">~{opt.words}w</div>
                  </button>
                ))}
              </div>
              {estimatedScenes > 0 && (
                <div className="mt-2 text-xs text-emerald-500 font-semibold">
                  Estimated ~{estimatedScenes} scenes
                </div>
              )}
            </div>

            {/* Visual Style */}
            <div>
              <label className="text-xs font-medium text-primary uppercase tracking-wide block mb-2">
                Visual Style
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(["impasto", "ww2", "doodle", "custom"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => handleStyleChange(s)}
                    disabled={generating}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      style === s
                        ? "border-primary bg-primary/10"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    <div className="text-xs font-semibold">
                      {s === "impasto" ? "🎨 Impasto Oil" : s === "ww2" ? "📷 WWII Archival" : s === "doodle" ? "✏️ Doodle Sketch" : "🛠️ Custom"}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-tight">
                      {s === "impasto"
                        ? "17th-century digital oil painting, heavy brushwork, chiaroscuro"
                        : s === "ww2"
                        ? "B&W photojournalism, Kodak grain, documentary realism"
                        : s === "doodle"
                        ? "Hand-drawn felt-tip stick-figure doodle, flat marker colors"
                        : "Write your own full visual-style template"}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Style Prompt Textarea */}
            <div>
              <label className="text-xs font-medium text-primary uppercase tracking-wide block mb-1.5">
                {style === "custom" ? "Custom Visual Style" : "Style Prompt Suffix"}
              </label>
              <Textarea
                value={stylePrompt}
                onChange={(e) => setStylePrompt(e.target.value)}
                className={`bg-secondary border-border font-mono text-[10px] leading-normal ${style === "custom" ? "min-h-[220px]" : "min-h-[90px]"}`}
                rows={style === "custom" ? 10 : 4}
                placeholder={
                  style === "custom"
                    ? "Describe the art style, medium, line/color rules, and 2-4 example prompts. Everything else — narration fidelity, NARRATIVE/INFOGRAPHIC scene tagging, and the JSON output format — is handled automatically, so you only need to write the visual style itself. Overlay text is optional and not required for custom style."
                    : "Describe the visual style suffix..."
                }
                disabled={generating}
              />
              <p className="text-[10px] text-muted-foreground mt-1 leading-normal">
                {style === "custom"
                  ? "This text fully replaces the built-in style rules. Describe only the visual aesthetic (medium, linework, color, camera variety, reference examples) — scene tagging and JSON output are added automatically."
                  : "This suffix is appended to the system prompts for scene generation."}
              </p>
            </div>

            {/* AI Provider */}
            <div>
              <label className="text-xs font-medium text-primary uppercase tracking-wide block mb-2">
                AI Provider
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(["groq", "inworld", "claude", "gemini"] as const).map((p) => {
                  const key = p === "groq" ? (settings.groqApiKeys?.find(k => k?.trim()) || "") : p === "claude" || p === "gemini" ? settings.googleCloudApiKey : settings.inworldApiKey;
                  const isVertex = p === "claude" || p === "gemini";
                  return (
                    <button
                      key={p}
                      onClick={() => setProvider(p)}
                      disabled={generating}
                      className={`rounded-lg border p-2.5 text-left transition-colors flex flex-col justify-between h-[82px] ${
                        provider === p
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      }`}
                    >
                      <div>
                        <div className="text-xs font-semibold">
                          {p === "groq" ? "Groq" : p === "inworld" ? "Inworld" : p === "claude" ? "Claude" : "Gemini"}
                        </div>
                        <div className="text-[9px] text-muted-foreground mt-0.5 leading-tight">
                          {p === "groq" ? "Batch 8" : p === "inworld" ? "Batch 15" : p === "claude" ? "Batch 5" : "Batch 10"}
                        </div>
                      </div>
                      {isVertex ? (
                        <div className="text-[9px] text-emerald-500 font-semibold">Vertex AI</div>
                      ) : !key ? (
                        <div className="text-[9px] text-amber-500 font-semibold">No key</div>
                      ) : (
                        <div className="text-[9px] text-emerald-500 font-semibold">Key set</div>
                      )}
                    </button>
                  );
                })}
              </div>
              {provider === "claude" || provider === "gemini" ? (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-500">
                  <CheckCircle2 className="h-3 w-3" />
                  Using {provider === "claude" ? `Claude (${settings.claudeModel || "claude-sonnet-4-6"})` : `Gemini (${settings.geminiModel || "gemini-3.1-pro-preview"})`} via Vertex AI
                </div>
              ) : apiKey ? (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-500">
                  <CheckCircle2 className="h-3 w-3" />
                  Using {provider === "groq" ? "Groq" : "Inworld"} key from Settings
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-500">
                  <AlertCircle className="h-3 w-3" />
                  No local API key — will attempt to use server key fallback
                </div>
              )}
            </div>

            <div className="pt-2">
              <Button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="w-full"
                size="lg"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  "▶ Generate Scene Manifest"
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col p-4 gap-2 flex-1 overflow-y-auto">
            {jobsList.length === 0 ? (
              <div className="h-40 flex flex-col items-center justify-center text-muted-foreground gap-2">
                <History className="h-8 w-8 opacity-40" />
                <span className="text-xs">No generation history found.</span>
              </div>
            ) : (
              jobsList.map((job) => {
                const isSelected = selectedJobId === job.id;
                return (
                  <div
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    className={`p-3 rounded-lg border text-left cursor-pointer transition-all flex flex-col gap-1.5 relative group ${
                      isSelected
                        ? "bg-primary/5 border-primary text-card-foreground shadow-sm"
                        : "border-border hover:bg-muted/40 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="flex justify-between items-start pr-6">
                      <span className="font-semibold text-xs text-foreground truncate block max-w-[280px]">
                        {job.result?.title || "Untitled Generation"}
                      </span>
                      <button
                        onClick={(e) => handleDeleteJob(e, job.id)}
                        className="opacity-0 group-hover:opacity-100 hover:text-destructive text-muted-foreground p-1 rounded transition-all absolute top-2.5 right-2.5"
                        title="Delete from history"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="flex justify-between items-center text-[10px]">
                      <span>{formatJobDate(job.createdAt)}</span>
                      <span>
                        {job.status === "completed" && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                            Completed
                          </span>
                        )}
                        {job.status === "failed" && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-destructive/10 text-destructive border border-destructive/20">
                            Failed
                          </span>
                        )}
                        {job.status === "running" && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-primary/10 text-primary border border-primary/20 animate-pulse">
                            Generating
                          </span>
                        )}
                      </span>
                    </div>

                    <div className="text-[10px] text-muted-foreground/80 flex gap-2">
                      <span>{job.result?.scenes?.length || job.progress?.partialScenes?.length || 0} scenes</span>
                      <span>·</span>
                      <span className="capitalize">{job.status === "running" ? "Active" : job.status}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ── Right Panel ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-sm font-semibold">JSON Output</h2>
            {selectedJob && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {selectedJob.result?.title || "Untitled"}
                {selectedJob.status === "completed" && " · complete"}
                {selectedJob.status === "running" && " · generating..."}
                {selectedJob.status === "failed" && " · failed"}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {rightTab === "json" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  disabled={!jsonString}
                >
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  disabled={!displayOutput || selectedJob?.status !== "completed"}
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  Download .json
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Right Panel Tabs */}
        {selectedJob?.params && (
          <div className="flex border-b border-border shrink-0 bg-muted/15">
            {selectedJob.status !== "failed" && (
              <button
                onClick={() => setRightTab("json")}
                className={`px-5 py-2.5 text-xs font-semibold border-b-2 transition-all ${
                  rightTab === "json"
                    ? "border-primary text-primary bg-background"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                JSON Manifest
              </button>
            )}
            <button
              onClick={() => setRightTab("script")}
              className={`px-5 py-2.5 text-xs font-semibold border-b-2 transition-all ${
                rightTab === "script"
                  ? "border-primary text-primary bg-background"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Original Script
            </button>
          </div>
        )}

        {/* Background job banner */}
        {selectedJob?.status === "running" && (
          <div className="px-5 py-2.5 border-b border-border bg-primary/5 shrink-0 flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
            <span className="text-xs text-primary">
              Running in background — you can navigate away and return to see results
            </span>
            <span className="text-[10px] text-muted-foreground ml-auto font-mono">
              {selectedJob.id.slice(0, 8)}
            </span>
          </div>
        )}

        {/* Progress */}
        {selectedJob?.status === "running" && selectedJob.progress && (
          <div className="px-5 py-3 border-b border-border bg-muted/30 shrink-0">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-primary">
                {selectedJob.progress.phase === "pass1"
                  ? `Pass 1: Splitting script (chunk ${selectedJob.progress.done}/${selectedJob.progress.total})...`
                  : `Pass 2: Generating prompts...`}
              </span>
              {selectedJob.progress.phase === "pass2" && (
                <span className="text-muted-foreground">
                  {selectedJob.progress.done} / {selectedJob.progress.total} scenes
                </span>
              )}
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{
                  width: `${selectedJob.progress.total > 0 ? (selectedJob.progress.done / selectedJob.progress.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {selectedJob?.status === "failed" && selectedJob.error && (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive shrink-0">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            {selectedJob.error}
          </div>
        )}

        {/* Content Panel */}
        {rightTab === "script" && selectedJob?.params ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto p-5 space-y-4">
              <div className="rounded-lg border border-border bg-muted/20 p-4 shrink-0">
                <h3 className="text-xs font-semibold text-primary uppercase tracking-wide mb-2">
                  Generator Configuration
                </h3>
                <div className="grid grid-cols-3 gap-4 text-xs">
                  <div>
                    <span className="text-muted-foreground">Scene Duration:</span>{" "}
                    <span className="font-semibold text-foreground">{selectedJob.params.secondsPerScene}s</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Visual Style:</span>{" "}
                    <span className="font-semibold text-foreground capitalize">{selectedJob.params.style}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">AI Provider:</span>{" "}
                    <span className="font-semibold text-foreground capitalize">{selectedJob.params.provider}</span>
                  </div>
                </div>
              </div>
              <div className="flex-1 min-h-0 flex flex-col">
                <h3 className="text-xs font-semibold text-primary uppercase tracking-wide mb-2">
                  Original Script Text
                </h3>
                <pre className="flex-1 overflow-auto p-4 rounded-lg border border-border bg-card font-mono text-xs whitespace-pre-wrap leading-relaxed text-foreground select-text">
                  {selectedJob.params.script}
                </pre>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border bg-card shrink-0 flex justify-end">
              <Button onClick={handleLoadAndRetry} size="sm">
                <History className="h-3.5 w-3.5 mr-1.5" />
                Load into Generator
              </Button>
            </div>
          </div>
        ) : jsonString ? (
          <div className="flex-1 overflow-auto p-5">
            <pre
              className="text-xs leading-relaxed font-mono whitespace-pre-wrap"
              dangerouslySetInnerHTML={{ __html: highlightJson(jsonString) }}
            />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            {selectedJob?.status === "running"
              ? "Processing..."
              : selectedJob?.status === "failed"
                ? "Generation failed. Review the error details above."
                : "Select a task from History or generate a new one"}
          </div>
        )}
      </div>
    </div>
  );
}
