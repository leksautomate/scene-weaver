import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getProjects } from "@/lib/api";
import type { Project } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, FolderOpen } from "lucide-react";

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

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProjects().then(setProjects).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-12 max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-display text-foreground">Projects</h1>
      {projects.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center space-y-3">
            <FolderOpen className="h-12 w-12 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground">No projects yet. Create one to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`}>
              <Card className="hover:border-primary/30 transition-colors cursor-pointer h-full">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between">
                    <h3 className="font-display text-foreground font-medium truncate">{p.title}</h3>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>{p.stats.sceneCount} scenes</span>
                    <span>{p.stats.imagesCompleted} images</span>
                    <span>{p.stats.audioCompleted} audio</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(p.created_at).toLocaleDateString()}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
