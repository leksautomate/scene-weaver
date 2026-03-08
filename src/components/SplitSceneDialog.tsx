import { useState, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Scissors } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  scriptText: string;
  onSplit: (splitIndex: number) => void;
}

export default function SplitSceneDialog({ open, onClose, scriptText, onSplit }: Props) {
  const sentences = useMemo(() => {
    return scriptText.match(/[^.!?]+[.!?]+/g)?.map(s => s.trim()).filter(Boolean) || [scriptText];
  }, [scriptText]);

  const [splitAfter, setSplitAfter] = useState(Math.floor(sentences.length / 2));

  if (sentences.length < 2) {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cannot Split</DialogTitle>
            <DialogDescription>This scene has only one sentence and cannot be split further.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4" /> Split Scene
          </DialogTitle>
          <DialogDescription>Click between sentences to choose the split point.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1 text-sm">
          {sentences.map((sentence, i) => (
            <div key={i}>
              <p className={`px-2 py-1 rounded ${i < splitAfter ? "bg-primary/10" : "bg-muted"}`}>
                {sentence}
              </p>
              {i < sentences.length - 1 && (
                <button
                  onClick={() => setSplitAfter(i + 1)}
                  className={`w-full text-center text-xs py-1 border-y border-dashed transition-colors ${
                    splitAfter === i + 1
                      ? "border-primary text-primary font-medium"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  ✂ Split here {splitAfter === i + 1 && "▸"}
                </button>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { onSplit(splitAfter); onClose(); }}>
            <Scissors className="h-4 w-4 mr-2" /> Split
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
