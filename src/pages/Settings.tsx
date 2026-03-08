import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Save } from "lucide-react";

interface AppSettings {
  imageProvider: string;
  voiceId: string;
  modelId: string;
  imageConcurrency: number;
  audioConcurrency: number;
}

const DEFAULTS: AppSettings = {
  imageProvider: "ai",
  voiceId: "",
  modelId: "",
  imageConcurrency: 2,
  audioConcurrency: 2,
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("historia-settings");
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const save = () => {
    localStorage.setItem("historia-settings", JSON.stringify(settings));
    toast.success("Settings saved");
  };

  return (
    <div className="p-6 md:p-12 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-display text-foreground">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-display">Image Generation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Image Provider</label>
            <Select
              value={settings.imageProvider}
              onValueChange={(v) => setSettings((s) => ({ ...s, imageProvider: v }))}
            >
              <SelectTrigger className="bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ai">Lovable AI (Gemini)</SelectItem>
                <SelectItem value="whisk">Whisk (Google Cookie)</SelectItem>
                <SelectItem value="mock">Mock (SVG Placeholders)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Image Concurrency: {settings.imageConcurrency}
            </label>
            <Slider
              value={[settings.imageConcurrency]}
              onValueChange={([v]) => setSettings((s) => ({ ...s, imageConcurrency: v }))}
              min={1}
              max={5}
              step={1}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-display">Voice / TTS</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Voice ID</label>
            <Input
              placeholder="e.g. en-US-Standard-D"
              value={settings.voiceId}
              onChange={(e) => setSettings((s) => ({ ...s, voiceId: e.target.value }))}
              className="bg-secondary"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">TTS Model</label>
            <Input
              placeholder="e.g. tts-1-hd"
              value={settings.modelId}
              onChange={(e) => setSettings((s) => ({ ...s, modelId: e.target.value }))}
              className="bg-secondary"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Audio Concurrency: {settings.audioConcurrency}
            </label>
            <Slider
              value={[settings.audioConcurrency]}
              onValueChange={([v]) => setSettings((s) => ({ ...s, audioConcurrency: v }))}
              min={1}
              max={5}
              step={1}
            />
          </div>
        </CardContent>
      </Card>

      <Button onClick={save} className="font-display">
        <Save className="h-4 w-4 mr-2" />
        Save Settings
      </Button>
    </div>
  );
}
