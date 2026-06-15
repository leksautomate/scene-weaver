import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, Trash2 } from "lucide-react";
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

export default function TextToVideo() {
  const navigate = useNavigate();
  const [promptText, setPromptText] = useState("");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [generating, setGenerating] = useState(false);
  const [jobs, setJobs] = useState<TtvJob[]>([]);

  useEffect(() => {
    fetchJobs();
  }, []);

  async function fetchJobs() {
    try {
      const res = await fetch("/api/text-to-video");
      if (res.ok) setJobs(await res.json());
    } catch {}
  }

  const prompts = promptText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  async function handleGenerate() {
    if (prompts.length === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/text-to-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompts, aspectRatio }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { id } = await res.json();
      navigate(`/text-to-video/${id}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to start job");
      setGenerating(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, jobId: string) {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/text-to-video/${jobId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    } catch (e: any) {
      toast.error(e.message || "Failed to delete job");
    }
  }

  function jobProgress(job: TtvJob): number {
    const done = job.items.filter((i) => i.status === "completed" || i.status === "failed").length;
    return job.items.length === 0 ? 0 : Math.round((done / job.items.length) * 100);
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">Text to Video</h1>
        <p className="text-muted-foreground text-sm mt-1">Generate Veo videos from text prompts in bulk</p>
      </div>

      {/* Creation form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New Batch</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Textarea
              placeholder="Enter one prompt per line…"
              className="min-h-[160px] font-mono text-sm resize-y"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {prompts.length} prompt{prompts.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-44">
              <Select value={aspectRatio} onValueChange={(v) => setAspectRatio(v as "16:9" | "9:16")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="16:9">16:9 Landscape</SelectItem>
                  <SelectItem value="9:16">9:16 Portrait</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleGenerate} disabled={generating || prompts.length === 0}>
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                "Generate Videos"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Job list */}
      {jobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Past Batches
          </h2>
          {jobs.map((job) => {
            const pct = jobProgress(job);
            const completed = job.items.filter((i) => i.status === "completed").length;
            const failed = job.items.filter((i) => i.status === "failed").length;
            return (
              <Card
                key={job.id}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate(`/text-to-video/${job.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <Badge variant={job.status === "running" ? "default" : job.status === "stopped" ? "destructive" : "secondary"}>
                          {job.status === "running" ? "Running" : job.status === "stopped" ? "Interrupted" : "Done"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{job.aspectRatio}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">{job.items.length} videos</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(job.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <Progress value={pct} className="h-1.5" />
                      <p className="text-xs text-muted-foreground mt-1">
                        {completed} done · {failed} failed ·{" "}
                        {job.items.length - completed - failed} pending
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={(e) => handleDelete(e, job.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
