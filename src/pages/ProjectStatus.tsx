import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { getProject, getAssetUrl, downloadProject } from "@/lib/api";
import type { Project, Scene } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import SceneCard from "@/components/SceneCard";
import Timeline from "@/components/Timeline";
import {
  ArrowLeft,
  Download,
  Image as ImageIcon,
  Volume2,
  AlertTriangle,
  CheckCircle2,
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
  const [activeScene, setActiveScene] = useState<number | undefined>();
  const sceneRefs = useRef<Record<number, HTMLDivElement | null>>({});

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
    const interval = setInterval(() => {
      if (project?.status === "processing" || project?.status === "created") {
        fetchData();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchData, project?.status]);

  const scrollToScene = (num: number) => {
    setActiveScene(num);
    sceneRefs.current[num]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex items-center justify-center h-full">
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
  const imgProgress = stats.sceneCount > 0 ? (stats.imagesCompleted / stats.sceneCount) * 100 : 0;
  const audioProgress = stats.sceneCount > 0 ? (stats.audioCompleted / stats.sceneCount) * 100 : 0;

  return (
    <div className="p-6 md:p-12">
      <div className="mx-auto max-w-5xl space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <Link to="/projects">
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
          {[
            { value: stats.sceneCount, label: "Scenes", color: "text-primary" },
            { value: stats.imagesCompleted, label: "Images Done", color: "text-success" },
            { value: stats.audioCompleted, label: "Audio Done", color: "text-success" },
            { value: stats.needsReviewCount, label: "Needs Review", color: "text-destructive" },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="p-4 text-center">
                <p className={`text-2xl font-display ${s.color}`}>{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </CardContent>
            </Card>
          ))}
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

        {/* Timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-display">Scene Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <Timeline
              scenes={scenes}
              projectId={project.id}
              onSelectScene={scrollToScene}
              activeScene={activeScene}
            />
          </CardContent>
        </Card>

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
          <h2 className="text-xl font-display text-foreground">Scenes ({scenes.length})</h2>
          {scenes.length === 0 && project.status === "processing" && (
            <Card>
              <CardContent className="p-8 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-3" />
                <p className="text-muted-foreground">Generating scene manifest...</p>
              </CardContent>
            </Card>
          )}
          {scenes.map((scene) => (
            <div
              key={scene.scene_number}
              ref={(el) => { sceneRefs.current[scene.scene_number] = el; }}
            >
              <SceneCard scene={scene} projectId={project.id} onRefresh={fetchData} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
