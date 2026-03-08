import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Copy, Scissors } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const normalizeText = (text: string) =>
  text.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/[ ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

const countWords = (text: string) => {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
};

const splitIntoSentences = (text: string): string[] => {
  const clean = normalizeText(text);
  if (!clean) return [];
  const matches = clean.match(/[^.!?\n]+(?:[.!?]+["')\]]*)?|\n+/g) || [];
  return matches.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
};

const splitLongSentence = (sentence: string, limit: number): string[] => {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return [sentence];
  const pieces: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(start + limit, words.length);
    if (end < words.length) {
      for (let i = end; i > start + Math.floor(limit * 0.6); i -= 1) {
        if (/[,:;)]$/.test(words[i - 1])) { end = i; break; }
      }
    }
    pieces.push(words.slice(start, end).join(" "));
    start = end;
  }
  return pieces;
};

export default function TextSplitter() {
  const [input, setInput] = useState("");
  const [targetWords, setTargetWords] = useState(150);
  const [tolerance, setTolerance] = useState(35);
  const [splitMode, setSplitMode] = useState("smart");
  const [joinMode, setJoinMode] = useState("double");
  const { toast } = useToast();

  const words = useMemo(() => {
    const clean = normalizeText(input);
    return clean ? clean.split(/\s+/) : [];
  }, [input]);

  const chunks = useMemo(() => {
    if (!input.trim() || !targetWords || targetWords < 1) return [];

    if (splitMode === "exact") {
      const result: string[] = [];
      for (let i = 0; i < words.length; i += targetWords) {
        result.push(words.slice(i, i + targetWords).join(" "));
      }
      return result;
    }

    const sentences = splitIntoSentences(input).flatMap((s) =>
      countWords(s) > targetWords + tolerance ? splitLongSentence(s, targetWords) : [s]
    );

    const result: string[] = [];
    let current = "";
    let currentCount = 0;

    for (const sentence of sentences) {
      const sentenceCount = countWords(sentence);
      if (!current) { current = sentence; currentCount = sentenceCount; continue; }
      const nextCount = currentCount + sentenceCount;
      const lowerBound = Math.max(1, targetWords - tolerance);
      const upperBound = targetWords + tolerance;
      if (nextCount <= upperBound || currentCount < lowerBound) {
        current += " " + sentence;
        currentCount = countWords(current);
      } else {
        result.push(current.trim());
        current = sentence;
        currentCount = sentenceCount;
      }
    }
    if (current.trim()) result.push(current.trim());
    return result;
  }, [input, splitMode, targetWords, tolerance, words]);

  const outputText = useMemo(() => {
    const sep = joinMode === "single" ? "\n" : "\n\n";
    return chunks.join(sep);
  }, [chunks, joinMode]);

  const handleDownload = () => {
    const blob = new Blob([outputText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "split-text.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyAll = () => {
    navigator.clipboard.writeText(outputText);
    toast({ title: "All parts copied" });
  };

  const handleCopyPart = (part: string, index: number) => {
    navigator.clipboard.writeText(part);
    toast({ title: `Part ${index + 1} copied` });
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-display font-bold text-foreground">Smart Text Splitter</h1>
      <p className="text-sm text-muted-foreground max-w-3xl">
        Smart mode keeps sentences together and breaks at natural punctuation. Exact mode splits strictly by word count.
      </p>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Total words</div><div className="text-2xl font-semibold">{words.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Total characters</div><div className="text-2xl font-semibold">{normalizeText(input).length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Output parts</div><div className="text-2xl font-semibold">{chunks.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Split style</div><div className="text-2xl font-semibold">{splitMode === "smart" ? "Smart" : "Exact"}</div></CardContent></Card>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label>Split mode</Label>
          <Select value={splitMode} onValueChange={setSplitMode}>
            <SelectTrigger className="mt-1 w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="smart">Smart (sentences)</SelectItem>
              <SelectItem value="exact">Exact (word count)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Target words/part</Label>
          <Input type="number" min={1} value={targetWords} onChange={(e) => setTargetWords(Math.max(1, Number(e.target.value) || 1))} className="mt-1 w-28" />
        </div>
        {splitMode === "smart" && (
          <div>
            <Label>Tolerance</Label>
            <Input type="number" min={0} value={tolerance} onChange={(e) => setTolerance(Math.max(0, Number(e.target.value) || 0))} className="mt-1 w-28" />
          </div>
        )}
        <div>
          <Label>Spacing</Label>
          <Select value={joinMode} onValueChange={setJoinMode}>
            <SelectTrigger className="mt-1 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="double">Blank line between</SelectItem>
              <SelectItem value="single">Single line between</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div>
          <Label htmlFor="text-input">Input text</Label>
          <Textarea id="text-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste up to 5000+ words here..." className="mt-1 min-h-[380px]" />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label>Output</Label>
            <div className="flex gap-2">
              {chunks.length > 0 && (
                <>
                  <Button size="sm" variant="outline" onClick={handleCopyAll}><Copy className="h-4 w-4 mr-1" /> Copy All</Button>
                  <Button size="sm" variant="outline" onClick={handleDownload}><Download className="h-4 w-4 mr-1" /> Download</Button>
                </>
              )}
            </div>
          </div>
          <Textarea readOnly value={outputText} placeholder="Split text appears here..." className="mt-1 min-h-[380px] bg-muted/30" />
        </div>
      </div>

      {/* Individual parts */}
      {chunks.length > 0 && (
        <div className="space-y-3">
          {chunks.map((chunk, i) => (
            <Card key={i}>
              <CardHeader className="py-3 px-4 flex-row items-center justify-between">
                <CardTitle className="text-sm">Part {i + 1} — {countWords(chunk)} words</CardTitle>
                <Button size="icon" variant="ghost" onClick={() => handleCopyPart(chunk, i)}><Copy className="h-4 w-4" /></Button>
              </CardHeader>
              <CardContent className="px-4 pb-3 pt-0">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{chunk}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
