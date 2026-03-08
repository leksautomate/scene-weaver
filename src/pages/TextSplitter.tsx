import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Scissors, Download, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function TextSplitter() {
  const [text, setText] = useState("");
  const [numParts, setNumParts] = useState(10);
  const [parts, setParts] = useState<string[]>([]);
  const { toast } = useToast();

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  const handleSplit = () => {
    if (!text.trim()) return;
    const words = text.trim().split(/\s+/);
    const n = Math.min(numParts, words.length);
    const perPart = Math.ceil(words.length / n);
    const result: string[] = [];
    for (let i = 0; i < n; i++) {
      result.push(words.slice(i * perPart, (i + 1) * perPart).join(" "));
    }
    setParts(result);
  };

  const handleDownload = () => {
    const content = parts
      .map((p, i) => `--- Part ${i + 1} (${p.split(/\s+/).length} words) ---\n${p}`)
      .join("\n\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "split-text.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyPart = (part: string, index: number) => {
    navigator.clipboard.writeText(part);
    toast({ title: `Part ${index + 1} copied` });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-display font-bold text-foreground">Text Splitter</h1>

      <div className="space-y-4">
        <div>
          <Label htmlFor="text-input">Paste your text ({wordCount} words)</Label>
          <Textarea
            id="text-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste up to 5000+ words here..."
            className="mt-1 min-h-[200px]"
          />
        </div>

        <div className="flex items-end gap-4">
          <div>
            <Label htmlFor="num-parts">Number of parts</Label>
            <Input
              id="num-parts"
              type="number"
              min={2}
              max={20}
              value={numParts}
              onChange={(e) => setNumParts(Number(e.target.value))}
              className="mt-1 w-24"
            />
          </div>
          <Button onClick={handleSplit} disabled={!text.trim()}>
            <Scissors className="h-4 w-4 mr-2" /> Split
          </Button>
          {parts.length > 0 && (
            <Button variant="outline" onClick={handleDownload}>
              <Download className="h-4 w-4 mr-2" /> Download .txt
            </Button>
          )}
        </div>
      </div>

      {parts.length > 0 && (
        <div className="space-y-3">
          {parts.map((part, i) => (
            <Card key={i}>
              <CardHeader className="py-3 px-4 flex-row items-center justify-between">
                <CardTitle className="text-sm">
                  Part {i + 1} — {part.split(/\s+/).length} words
                </CardTitle>
                <Button size="icon" variant="ghost" onClick={() => handleCopyPart(part, i)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </CardHeader>
              <CardContent className="px-4 pb-3 pt-0">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{part}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
