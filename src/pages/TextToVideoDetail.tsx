import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  Download,
  ArrowLeft,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";
import { toast } from "sonner";

interface TtvItem {
  index: number;
  prompt: string;
  status: "pending" | "generating" | "completed" | "failed";
  error?: string;
}

interface TtvJob {
  id: string;
  status: "running" | "done" | "stopped";
  aspectRatio: "16:9" | "9:16";
  items: TtvItem[];
  createdAt: string;
  completedAt?: string;
}

export default function TextToVideoDetail() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<TtvJob | null>(null);
  const [editPrompts, setEditPrompts] = useState<Record<number, string>>({});
  const [retrying, setRetrying] = useState<Record<number, boolean>>({});
  const [downloading, setDownloading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchJob();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId]);

  useEffect(() => {
    if (!job) return;
    const isActive = job.items.some(
      (i) => i.status === "pending" || i.status === "generating"
    );
    if (isActive && !pollRef.current) {
      pollRef.current = setInterval(fetchJob, 3000);
    } else if (!isActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [job]);

  async function fetchJob() {
    try {
      const res = await fetch(`/api/text-to-video/${jobId}`);
      if (!res.ok) { navigate("/text-to-video"); return; }
      setJob(await res.json());
    } catch {}
  }

  async function handleRetry(item: TtvItem) {
    const prompt = editPrompts[item.index] ?? item.prompt;
    setRetrying((prev) => ({ ...prev, [item.index]: true }));
    try {
      const res = await fetch(`/api/text-to-video/${jobId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: item.index, prompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchJob();
    } catch (e: any) {
      toast.error(e.message || "Retry failed");
    } finally {
      setRetrying((prev) => ({ ...prev, [item.index]: false }));
    }
  }

  async function handleDownloadZip() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/text-to-video/${jobId}/zip`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `videos-${jobId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e.message || "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const completed = job.items.filter((i) => i.status === "completed").length;
  const failed = job.items.filter((i) => i.status === "failed").length;
  const total = job.items.length;
  const pct = total === 0 ? 0 : Math.round(((completed + failed) / total) * 100);
  const isPortrait = job.aspectRatio === "9:16";

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button
            onClick={() => navigate("/text-to-video")}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Dashboard
          </button>
          <h1 className="text-2xl font-display font-bold">Batch Preview</h1>
          <p className="text-sm text-muted-foreground">
            {job.aspectRatio} · {total} videos ·{" "}
            {new Date(job.createdAt).toLocaleString()}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={completed === 0 || downloading}
          onClick={handleDownloadZip}
        >
          {downloading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Download ZIP ({completed})
        </Button>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <Progress value={pct} className="h-2" />
        <p className="text-xs text-muted-foreground">
          {completed} completed · {failed} failed · {total - completed - failed} remaining
        </p>
      </div>

      {/* Video grid */}
      <div
        className={`grid gap-4 ${
          isPortrait
            ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        }`}
      >
        {job.items.map((item) => {
          const filename = String(item.index).padStart(3, "0") + ".mp4";
          const editPrompt = editPrompts[item.index] ?? item.prompt;

          return (
            <Card
              key={item.index}
              className={item.status === "failed" ? "border-destructive/50" : ""}
            >
              <CardContent className="p-3 space-y-2">
                {/* Video / state placeholder */}
                <div
                  className={`relative rounded overflow-hidden bg-muted ${
                    isPortrait ? "aspect-[9/16]" : "aspect-video"
                  }`}
                >
                  {item.status === "completed" ? (
                    <video
                      className="w-full h-full object-cover"
                      src={`/uploads/text-to-video/${jobId}/${filename}`}
                      controls
                      playsInline
                    />
                  ) : item.status === "generating" ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      <span className="text-xs text-muted-foreground">Generating…</span>
                    </div>
                  ) : item.status === "failed" ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <AlertCircle className="h-8 w-8 text-destructive/60" />
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <Clock className="h-5 w-5 text-muted-foreground/50" />
                      <span className="text-xs text-muted-foreground">Queued</span>
                    </div>
                  )}
                </div>

                {/* Filename + status icon */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-muted-foreground">{filename}</span>
                  {item.status === "completed" && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  )}
                  {item.status === "failed" && (
                    <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  )}
                  {item.status === "generating" && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                  )}
                  {item.status === "pending" && (
                    <Clock className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  )}
                </div>

                {/* Prompt display or editable retry form */}
                {item.status === "failed" ? (
                  <div className="space-y-1.5">
                    {item.error && (
                      <p className="text-xs text-destructive leading-snug">{item.error}</p>
                    )}
                    <Textarea
                      className="text-xs min-h-[64px] font-mono resize-y"
                      value={editPrompt}
                      onChange={(e) =>
                        setEditPrompts((prev) => ({ ...prev, [item.index]: e.target.value }))
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={retrying[item.index]}
                      onClick={() => handleRetry(item)}
                    >
                      {retrying[item.index] ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Retry
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.prompt}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
