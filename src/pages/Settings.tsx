import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Save, Eye, EyeOff, CheckCircle2, XCircle, Loader2, Wifi } from "lucide-react";
import { loadProviderSettings, saveProviderSettings, INWORLD_VOICES, type ProviderSettings } from "@/lib/providers";

type HealthStatus = "idle" | "checking" | "ok" | "error";

function StatusIndicator({ status, message }: { status: HealthStatus; message?: string }) {
  if (status === "idle") return null;
  if (status === "checking") return <Badge variant="secondary" className="text-xs"><Loader2 className="h-3 w-3 animate-spin mr-1" />Checking...</Badge>;
  if (status === "ok") return <Badge className="bg-success/20 text-success border-success/30 text-xs"><CheckCircle2 className="h-3 w-3 mr-1" />Connected</Badge>;
  return (
    <div className="space-y-1">
      <Badge variant="destructive" className="text-xs"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>
      {message && <p className="text-xs text-destructive">{message}</p>}
    </div>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState<ProviderSettings>(loadProviderSettings);
  const [showGroq, setShowGroq] = useState(false);
  const [showWhisk, setShowWhisk] = useState(false);
  const [showInworld, setShowInworld] = useState(false);

  const [groqStatus, setGroqStatus] = useState<HealthStatus>("idle");
  const [groqMsg, setGroqMsg] = useState("");
  const [whiskStatus, setWhiskStatus] = useState<HealthStatus>("idle");
  const [whiskMsg, setWhiskMsg] = useState("");
  const [inworldStatus, setInworldStatus] = useState<HealthStatus>("idle");
  const [inworldMsg, setInworldMsg] = useState("");

  const save = () => {
    saveProviderSettings(settings);
    toast.success("Settings saved");
  };

  const testGroq = async () => {
    if (!settings.groqApiKey) { setGroqStatus("error"); setGroqMsg("No API key provided"); return; }
    setGroqStatus("checking"); setGroqMsg("");
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${settings.groqApiKey}` },
      });
      if (res.status === 401) { setGroqStatus("error"); setGroqMsg("Invalid API key"); return; }
      if (res.status === 429) { setGroqStatus("error"); setGroqMsg("Rate limited — try again later"); return; }
      if (!res.ok) { setGroqStatus("error"); setGroqMsg(`HTTP ${res.status}`); return; }
      setGroqStatus("ok");
    } catch (e: any) {
      setGroqStatus("error"); setGroqMsg(e.message?.includes("fetch") ? "Network error — check connectivity" : e.message);
    }
  };

  const testWhisk = async () => {
    if (!settings.whiskCookie) { setWhiskStatus("error"); setWhiskMsg("No cookie provided"); return; }
    setWhiskStatus("checking"); setWhiskMsg("");
    try {
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/whisk-proxy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ action: "session", cookie: settings.whiskCookie }),
      });
      if (!res.ok) { setWhiskStatus("error"); setWhiskMsg(`Proxy error: HTTP ${res.status}`); return; }
      const result = await res.json();
      if (result.status === 401 || result.status === 403) { setWhiskStatus("error"); setWhiskMsg("Cookie expired or invalid"); return; }
      if (result.status && result.status >= 400) { setWhiskStatus("error"); setWhiskMsg(`HTTP ${result.status}`); return; }
      if (!result.data?.access_token) { setWhiskStatus("error"); setWhiskMsg("No access token — cookie may be expired"); return; }
      setWhiskStatus("ok");
    } catch (e: any) {
      setWhiskStatus("error"); setWhiskMsg(e.message?.includes("fetch") ? "Network error — check connectivity" : e.message);
    }
  };

  const testInworld = async () => {
    if (!settings.inworldApiKey) { setInworldStatus("error"); setInworldMsg("No API key provided"); return; }
    setInworldStatus("checking"); setInworldMsg("");
    try {
      const res = await fetch("https://api.inworld.ai/tts/v1/voice", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${settings.inworldApiKey}`,
        },
        body: JSON.stringify({
          text: "test",
          voiceId: "Dennis",
          modelId: "inworld-tts-1.5-max",
          audioConfig: { audioEncoding: "MP3", sampleRateHertz: 22050 },
          temperature: 1.0,
          applyTextNormalization: "ON",
        }),
      });
      if (res.status === 401 || res.status === 403) { setInworldStatus("error"); setInworldMsg("Invalid API key"); return; }
      if (res.status === 429) { setInworldStatus("error"); setInworldMsg("Rate limited"); return; }
      if (!res.ok) { setInworldStatus("error"); setInworldMsg(`HTTP ${res.status}`); return; }
      const data = await res.json();
      if (!data?.audioContent) { setInworldStatus("error"); setInworldMsg("No audio returned"); return; }
      setInworldStatus("ok");
    } catch (e: any) {
      setInworldStatus("error"); setInworldMsg(e.message?.includes("fetch") ? "Network error — check connectivity" : e.message);
    }
  };

  const testAll = () => {
    testGroq();
    testWhisk();
    testInworld();
  };

  return (
    <div className="p-6 md:p-12 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-display text-foreground">Settings</h1>
        <Button variant="outline" size="sm" onClick={testAll}>
          <Wifi className="h-4 w-4 mr-2" />Test All Connections
        </Button>
      </div>

      {/* API Keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-display">API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">Groq API Key</label>
              <div className="flex items-center gap-2">
                <StatusIndicator status={groqStatus} message={groqMsg} />
                <Button variant="ghost" size="sm" onClick={testGroq} className="text-xs h-7">
                  {groqStatus === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                </Button>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                type={showGroq ? "text" : "password"}
                placeholder="gsk_..."
                value={settings.groqApiKey}
                onChange={(e) => { setSettings((s) => ({ ...s, groqApiKey: e.target.value })); setGroqStatus("idle"); }}
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
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">Whisk Cookie</label>
              <div className="flex items-center gap-2">
                <StatusIndicator status={whiskStatus} message={whiskMsg} />
                <Button variant="ghost" size="sm" onClick={testWhisk} className="text-xs h-7">
                  {whiskStatus === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                </Button>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                type={showWhisk ? "text" : "password"}
                placeholder="Cookie from labs.google"
                value={settings.whiskCookie}
                onChange={(e) => { setSettings((s) => ({ ...s, whiskCookie: e.target.value })); setWhiskStatus("idle"); }}
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
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">Inworld API Key</label>
              <div className="flex items-center gap-2">
                <StatusIndicator status={inworldStatus} message={inworldMsg} />
                <Button variant="ghost" size="sm" onClick={testInworld} className="text-xs h-7">
                  {inworldStatus === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                </Button>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                type={showInworld ? "text" : "password"}
                placeholder="Base64 encoded key"
                value={settings.inworldApiKey}
                onChange={(e) => { setSettings((s) => ({ ...s, inworldApiKey: e.target.value })); setInworldStatus("idle"); }}
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
