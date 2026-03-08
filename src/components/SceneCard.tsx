import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getAssetUrl, regenerateImage, regenerateAudio } from "@/lib/api";
import type { Scene } from "@/lib/types";
import {
  Image as ImageIcon,
  Volume2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

interface Props {
  scene: Scene;
  projectId: string;
  onRefresh: () => void;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed")
    return <Badge className="bg-success/20 text-success border-success/30"><CheckCircle2 className="h-3 w-3 mr-1" />Done</Badge>;
  if (status === "failed")
    return <Badge variant="destructive"><AlertTriangle className="h-3 w-3 mr-1" />Failed</Badge>;
  return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
}

export default function SceneCard({ scene, projectId, onRefresh }: Props) {
  const [regenImage, setRegenImage] = useState(false);
  const [regenAudio, setRegenAudio] = useState(false);

  const imgUrl = scene.image_status === "completed"
    ? getAssetUrl(projectId, "images", scene.image_file)
    : null;
  const audioUrl = scene.audio_status === "completed"
    ? getAssetUrl(projectId, "audio", scene.audio_file)
    : null;

  const handleRegenImage = async () => {
    setRegenImage(true);
    try {
      await regenerateImage(projectId, scene.scene_number);
      toast.success(`Scene ${scene.scene_number} image regenerated`);
      onRefresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRegenImage(false);
    }
  };

  const handleRegenAudio = async () => {
    setRegenAudio(true);
    try {
      await regenerateAudio(projectId, scene.scene_number);
      toast.success(`Scene ${scene.scene_number} audio regenerated`);
      onRefresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRegenAudio(false);
    }
  };

  return (
    <Card className={`border-border/50 ${scene.needs_review ? "border-warning/50 glow-gold" : ""}`}>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-display text-primary font-bold">
              {scene.scene_number}
            </span>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">{scene.scene_type}</Badge>
                <Badge variant="outline" className="text-xs">{scene.historical_period}</Badge>
              </div>
            </div>
          </div>
          {scene.needs_review && (
            <Badge className="bg-warning/20 text-warning border-warning/30">
              <AlertTriangle className="h-3 w-3 mr-1" />Needs Review
            </Badge>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          {/* Image section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <ImageIcon className="h-4 w-4" /> Image
              </div>
              <StatusBadge status={scene.image_status} />
            </div>
            <div className="aspect-video rounded-md overflow-hidden bg-secondary border border-border">
              {imgUrl ? (
                <img src={imgUrl} alt={`Scene ${scene.scene_number}`} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRegenImage}
                disabled={regenImage}
                className="text-xs"
              >
                {regenImage ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                <span className="ml-1">Regen Image</span>
              </Button>
              <span className="text-xs text-muted-foreground">
                {scene.image_attempts} attempt{scene.image_attempts !== 1 ? "s" : ""}
              </span>
            </div>
            {scene.image_error && (
              <p className="text-xs text-destructive">{scene.image_error}</p>
            )}
          </div>

          {/* Audio section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Volume2 className="h-4 w-4" /> Audio
              </div>
              <StatusBadge status={scene.audio_status} />
            </div>
            <div className="aspect-video rounded-md bg-secondary border border-border flex items-center justify-center p-4">
              {audioUrl ? (
                <audio controls className="w-full" src={audioUrl} />
              ) : (
                <Volume2 className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRegenAudio}
                disabled={regenAudio}
                className="text-xs"
              >
                {regenAudio ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                <span className="ml-1">Regen Audio</span>
              </Button>
              <span className="text-xs text-muted-foreground">
                {scene.audio_attempts} attempt{scene.audio_attempts !== 1 ? "s" : ""}
              </span>
            </div>
            {scene.audio_error && (
              <p className="text-xs text-destructive">{scene.audio_error}</p>
            )}
          </div>
        </div>

        {/* Text content */}
        <div className="space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground font-medium">Script:</span>
            <p className="text-foreground/80 mt-1">{scene.script_text}</p>
          </div>
          <div>
            <span className="text-muted-foreground font-medium">TTS:</span>
            <p className="text-foreground/80 mt-1 italic">{scene.tts_text}</p>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground font-medium">Image Prompt:</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(scene.image_prompt);
                  toast.success("Prompt copied!");
                }}
                className="text-primary hover:text-primary/80"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <p className="text-foreground/70 mt-1 text-xs font-mono bg-secondary p-2 rounded">
              {scene.image_prompt}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
