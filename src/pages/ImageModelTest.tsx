import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, RotateCcw, Download, FlaskConical } from "lucide-react";
import { ASPECT_RATIOS, loadProviderSettings, generateGeminiImage } from "@/lib/providers";

type Status = "idle" | "generating" | "done" | "failed";

const DEFAULT_PROMPT =
  "Wide establishing shot of ancient Roman soldiers marching in formation through a dust-filled valley at golden hour, backs turned, lorica segmentata armor catching the light, dramatic chiaroscuro, cinematic oil painting style.";

export default function ImageModelTest() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "1:1" | "9:16">("16:9");
  const [status, setStatus] = useState<Status>("idle");
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [durationMs, setDurationMs] = useState<number | undefined>();

  async function generate() {
    setStatus("generating");
    setImageUrl(undefined);
    setError(undefined);
    const t0 = Date.now();
    try {
      const settings = loadProviderSettings();
      const blob = await generateGeminiImage(prompt, aspectRatio, settings.arkApiKey);
      setImageUrl(URL.createObjectURL(blob));
      setStatus("done");
      setDurationMs(Date.now() - t0);
    } catch (e: any) {
      setError(e.message);
      setStatus("failed");
      setDurationMs(Date.now() - t0);
    }
  }

  function reset() {
    setStatus("idle");
    setImageUrl(undefined);
    setError(undefined);
    setDurationMs(undefined);
  }

  function downloadImage() {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `seedream-${aspectRatio.replace(":", "x")}.png`;
    a.click();
  }

  return (
    <div className="h-full overflow-y-auto p-6 md:p-10 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <FlaskConical className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-display text-foreground">Image Model Test</h1>
      </div>

      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Prompt</label>
            <Textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              className="bg-secondary resize-none"
              placeholder="Describe the image you want to generate…"
            />
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Aspect Ratio</label>
              <Select value={aspectRatio} onValueChange={v => setAspectRatio(v as "16:9" | "1:1" | "9:16")}>
                <SelectTrigger className="bg-secondary w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASPECT_RATIOS.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2 pb-0.5">
              <Button onClick={generate} disabled={!prompt.trim() || status === "generating"}>
                {status === "generating" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Generate
              </Button>
              <Button variant="outline" onClick={reset} disabled={status === "generating"}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">Seedream (BytePlus Ark)</CardTitle>
            <StatusBadge status={status} />
          </div>
          {durationMs !== undefined && status !== "generating" && (
            <p className="text-xs text-muted-foreground">{(durationMs / 1000).toFixed(1)}s</p>
          )}
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div
            className={`bg-secondary rounded overflow-hidden flex items-center justify-center ${
              aspectRatio === "9:16" ? "aspect-[9/16]" : aspectRatio === "1:1" ? "aspect-square" : "aspect-video"
            }`}
          >
            {status === "generating" && (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            )}
            {status === "done" && imageUrl && (
              <img src={imageUrl} alt="Generated" className="w-full h-full object-cover" />
            )}
            {status === "failed" && (
              <p className="text-xs text-destructive text-center px-3">{error}</p>
            )}
            {status === "idle" && (
              <p className="text-xs text-muted-foreground">Not generated</p>
            )}
          </div>

          {imageUrl && (
            <Button size="sm" variant="outline" className="text-xs" onClick={downloadImage}>
              <Download className="h-3 w-3 mr-1" />
              Download
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "idle") return <Badge variant="secondary" className="text-xs shrink-0">Idle</Badge>;
  if (status === "generating") return (
    <Badge variant="secondary" className="text-xs shrink-0 text-amber-500 border-amber-500/30">
      <Loader2 className="h-3 w-3 animate-spin mr-1" />Generating
    </Badge>
  );
  if (status === "done") return <Badge className="text-xs shrink-0 bg-green-500/20 text-green-600 border-green-500/30">Done</Badge>;
  return <Badge variant="destructive" className="text-xs shrink-0">Failed</Badge>;
}
