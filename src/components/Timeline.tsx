import { getAssetUrl } from "@/lib/api";
import type { Scene } from "@/lib/types";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Image as ImageIcon, Volume2 } from "lucide-react";

interface Props {
  scenes: Scene[];
  projectId: string;
  onSelectScene: (sceneNumber: number) => void;
  activeScene?: number;
}

export default function Timeline({ scenes, projectId, onSelectScene, activeScene }: Props) {
  if (scenes.length === 0) return null;

  return (
    <ScrollArea className="w-full">
      <div className="flex gap-3 pb-4 px-1">
        {scenes.map((scene) => {
          const imgUrl =
            scene.image_status === "completed"
              ? getAssetUrl(projectId, "images", scene.image_file)
              : null;

          const borderColor =
            scene.image_status === "completed"
              ? "border-success/60"
              : scene.image_status === "failed"
              ? "border-destructive/60"
              : "border-warning/40";

          const isActive = activeScene === scene.scene_number;

          return (
            <button
              key={scene.scene_number}
              onClick={() => onSelectScene(scene.scene_number)}
              className={`relative shrink-0 w-28 aspect-video rounded-md border-2 overflow-hidden transition-all ${borderColor} ${
                isActive ? "ring-2 ring-primary scale-105" : "hover:scale-105"
              }`}
            >
              {imgUrl ? (
                <img
                  src={imgUrl}
                  alt={`Scene ${scene.scene_number}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-secondary flex items-center justify-center">
                  <ImageIcon className="h-5 w-5 text-muted-foreground" />
                </div>
              )}
              <div className="absolute bottom-0 left-0 right-0 bg-background/80 px-1.5 py-0.5 flex items-center justify-between">
                <span className="text-xs font-display text-primary font-bold">
                  {scene.scene_number}
                </span>
                <div className="flex gap-1">
                  {scene.audio_status === "completed" && (
                    <Volume2 className="h-3 w-3 text-success" />
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
