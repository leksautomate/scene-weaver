import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Save, Eye, EyeOff } from "lucide-react";
import { loadProviderSettings, saveProviderSettings, INWORLD_VOICES, type ProviderSettings } from "@/lib/providers";

export default function Settings() {
  const [settings, setSettings] = useState<ProviderSettings>(loadProviderSettings);
  const [showGroq, setShowGroq] = useState(false);
  const [showWhisk, setShowWhisk] = useState(false);
  const [showInworld, setShowInworld] = useState(false);

  const save = () => {
    saveProviderSettings(settings);
    toast.success("Settings saved");
  };

  return (
    <div className="p-6 md:p-12 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-display text-foreground">Settings</h1>

      {/* API Keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-display">API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Groq API Key</label>
            <div className="flex gap-2">
              <Input
                type={showGroq ? "text" : "password"}
                placeholder="gsk_..."
                value={settings.groqApiKey}
                onChange={(e) => setSettings((s) => ({ ...s, groqApiKey: e.target.value }))}
                className="bg-secondary flex-1"
              />
              <Button variant="ghost" size="icon" onClick={() => setShowGroq(!showGroq)}>
                {showGroq ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Used for scene manifest generation. Get one at console.groq.com
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Whisk Cookie</label>
            <div className="flex gap-2">
              <Input
                type={showWhisk ? "text" : "password"}
                placeholder="Cookie from labs.google"
                value={settings.whiskCookie}
                onChange={(e) => setSettings((s) => ({ ...s, whiskCookie: e.target.value }))}
                className="bg-secondary flex-1"
              />
              <Button variant="ghost" size="icon" onClick={() => setShowWhisk(!showWhisk)}>
                {showWhisk ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Google account cookie from labs.google for Imagen 3.5 image generation
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Inworld API Key</label>
            <div className="flex gap-2">
              <Input
                type={showInworld ? "text" : "password"}
                placeholder="Base64 encoded key"
                value={settings.inworldApiKey}
                onChange={(e) => setSettings((s) => ({ ...s, inworldApiKey: e.target.value }))}
                className="bg-secondary flex-1"
              />
              <Button variant="ghost" size="icon" onClick={() => setShowInworld(!showInworld)}>
                {showInworld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Inworld TTS API key (Base64). Get one at inworld.ai
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Image Generation */}
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
                <SelectItem value="whisk">Whisk (Imagen 3.5)</SelectItem>
                <SelectItem value="mock">Mock (SVG Placeholders)</SelectItem>
              </SelectContent>
            </Select>
            {settings.imageProvider === "whisk" && !settings.whiskCookie && (
              <p className="text-xs text-destructive">⚠ Whisk Cookie required above</p>
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

      {/* Voice / TTS */}
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
            {settings.ttsProvider === "inworld" && !settings.inworldApiKey && (
              <p className="text-xs text-destructive">⚠ Inworld API Key required above</p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Voice</label>
            <Select
              value={settings.voiceId}
              onValueChange={(v) => setSettings((s) => ({ ...s, voiceId: v }))}
            >
              <SelectTrigger className="bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INWORLD_VOICES.map(v => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name} — {v.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Default voice for new scenes. Can be overridden per scene.
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
