import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Save } from "lucide-react";

interface AppSettings {
  imageProvider: string;
  ttsProvider: string;
  voiceId: string;
  modelId: string;
  imageConcurrency: number;
  audioConcurrency: number;
}

const DEFAULTS: AppSettings = {
  imageProvider: "ai",
  ttsProvider: "inworld",
  voiceId: "Dennis",
  modelId: "inworld-tts-1.5-max",
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
                <SelectItem value="whisk">Whisk (Imagen 3.5)</SelectItem>
                <SelectItem value="mock">Mock (SVG Placeholders)</SelectItem>
              </SelectContent>
            </Select>
            {settings.imageProvider === "whisk" && (
              <p className="text-xs text-muted-foreground">
                Requires WHISK_COOKIE secret. Uses Google Imagen 3.5 via Labs.
              </p>
            )}
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
            <label className="text-sm font-medium text-foreground">TTS Provider</label>
            <Select
              value={settings.ttsProvider}
              onValueChange={(v) => setSettings((s) => ({ ...s, ttsProvider: v }))}
            >
              <SelectTrigger className="bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inworld">Inworld AI</SelectItem>
                <SelectItem value="mock">Mock (Silent Audio)</SelectItem>
              </SelectContent>
            </Select>
            {settings.ttsProvider === "inworld" && (
              <p className="text-xs text-muted-foreground">
                Requires INWORLD_API_KEY secret. Uses Inworld TTS 1.5 Max.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Voice ID</label>
            <Input
              placeholder="Dennis"
              value={settings.voiceId}
              onChange={(e) => setSettings((s) => ({ ...s, voiceId: e.target.value }))}
              className="bg-secondary"
            />
            <p className="text-xs text-muted-foreground">
              Inworld voice name (e.g. Dennis, Eleanor, James)
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">TTS Model</label>
            <Select
              value={settings.modelId}
              onValueChange={(v) => setSettings((s) => ({ ...s, modelId: v }))}
            >
              <SelectTrigger className="bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inworld-tts-1.5-max">TTS 1.5 Max (Best Quality)</SelectItem>
                <SelectItem value="inworld-tts-1.5-mini">TTS 1.5 Mini (Faster)</SelectItem>
                <SelectItem value="inworld-tts-1-max">TTS 1.0 Max (Legacy)</SelectItem>
                <SelectItem value="inworld-tts-1">TTS 1.0 (Legacy)</SelectItem>
              </SelectContent>
            </Select>
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
