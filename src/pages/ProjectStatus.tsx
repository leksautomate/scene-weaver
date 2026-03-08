import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { getProject, getAssetUrl, downloadProject } from "@/lib/api";
import type { Project, Scene } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import SceneCard from "@/components/SceneCard";
import {
  ArrowLeft,
  Download,
  Image as ImageIcon,
  Volume2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Scroll,
} from "lucide-react";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    created: { label: "Created", className: "bg-info/20 text-info border-info/30" },
    processing: { label: "Processing", className: "bg-warning/20 text-warning border-warning/30" },
    completed: { label: "Completed", className: "bg-success/20 text-success border-success/30" },
    partial: { label: "Partial", className: "bg-warning/20 text-warning border-warning/30" },
    failed: { label: "Failed", className: "bg-destructive/20 text-destructive border-destructive/30" },
  };
  const s = map[status] || map.created;
  return <Badge className={s.className}>{s.label}</Badge>;
}

export default function ProjectStatus() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await getProject(projectId);
      setProject(data.project);
      setScenes(data.scenes);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchData();
    // Poll while processing
    const interval = setInterval(() => {
      if (project?.status === "processing" || project?.status === "created") {
        fetchData();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchData, project?.status]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center space-y-4">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto" />
            <p className="text-destructive">{error || "Project not found"}</p>
            <Link to="/">
              <Button variant="outline"><ArrowLeft className="h-4 w-4 mr-2" />Back</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const stats = project.stats;
  const imgProgress = stats.sceneCount > 0 ? ((stats.imagesCompleted / stats.sceneCount) * 100) : 0;
  const audioProgress = stats.sceneCount > 0 ? ((stats.audioCompleted / stats.sceneCount) * 100) : 0;

  return (
    <div className="min-h-screen bg-background p-6 md:p-12">
      <div className="mx-auto max-w-5xl space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/">
              <Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button>
            </Link>
            <div>
              <div className="flex items-center gap-3">
                <Scroll className="h-6 w-6 text-primary" />
                <h1 className="text-2xl font-display text-foreground">{project.title}</h1>
                <StatusBadge status={project.status} />
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Created {new Date(project.created_at).toLocaleString()}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={async () => {
              const url = await downloadProject(project.id);
              window.open(url, "_blank");
            }}
          >
            <Download className="h-4 w-4 mr-2" />Download ZIP
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-display text-primary">{stats.sceneCount}</p>
              <p className="text-xs text-muted-foreground">Scenes</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-display text-success">{stats.imagesCompleted}</p>
              <p className="text-xs text-muted-foreground">Images Done</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-display text-success">{stats.audioCompleted}</p>
              <p className="text-xs text-muted-foreground">Audio Done</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-display text-destructive">{stats.needsReviewCount}</p>
              <p className="text-xs text-muted-foreground">Needs Review</p>
            </CardContent>
          </Card>
        </div>

        {/* Progress */}
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <ImageIcon className="h-4 w-4 text-primary" />
                <span>Images</span>
                <span className="ml-auto text-muted-foreground">
                  {stats.imagesCompleted}/{stats.sceneCount}
                </span>
              </div>
              <Progress value={imgProgress} className="h-2" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Volume2 className="h-4 w-4 text-primary" />
                <span>Audio</span>
                <span className="ml-auto text-muted-foreground">
                  {stats.audioCompleted}/{stats.sceneCount}
                </span>
              </div>
              <Progress value={audioProgress} className="h-2" />
            </CardContent>
          </Card>
        </div>

        {/* Style References */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-display">Style References</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <img
                src={getAssetUrl(project.id, "style", "style1.png")}
                alt="Style Reference 1"
                className="rounded-lg border border-border aspect-video object-cover"
              />
              <img
                src={getAssetUrl(project.id, "style", "style2.png")}
                alt="Style Reference 2"
                className="rounded-lg border border-border aspect-video object-cover"
              />
            </div>
          </CardContent>
        </Card>

        <Separator />

        {/* Scenes */}
        <div className="space-y-4">
          <h2 className="text-xl font-display text-foreground">
            Scenes ({scenes.length})
          </h2>
          {scenes.length === 0 && project.status === "processing" && (
            <Card>
              <CardContent className="p-8 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-3" />
                <p className="text-muted-foreground">Generating scene manifest...</p>
              </CardContent>
            </Card>
          )}
          {scenes.map((scene) => (
            <SceneCard
              key={scene.scene_number}
              scene={scene}
              projectId={project.id}
              onRefresh={fetchData}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
