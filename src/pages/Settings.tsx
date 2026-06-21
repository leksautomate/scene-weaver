import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Save, Eye, EyeOff, CheckCircle2, XCircle, Loader2, Wifi, Plus, Trash2, Key, Server, Mic, HardDrive, RefreshCw, AlertTriangle } from "lucide-react";
import { loadProviderSettings, saveProviderSettings, INWORLD_VOICES, IMAGE_MODELS, ASPECT_RATIOS, OVERLAY_POSITIONS, OVERLAY_FONTS, type ProviderSettings, type OverlayPosition } from "@/lib/providers";
import { GROQ_MODELS } from "../../shared/scriptToJsonUtils";

type HealthStatus = "idle" | "checking" | "ok" | "error";
type Tab = "connections" | "providers" | "voices" | "maintenance";

type StorageInfo = {
  projectCount: number;
  images:  { files: number; bytes: number };
  audio:   { files: number; bytes: number };
  videos:  { files: number; bytes: number };
  renders: { files: number; bytes: number };
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
  const [activeTab, setActiveTab] = useState<Tab>("connections");
  const [newVoiceId, setNewVoiceId] = useState("");
  const [newVoiceName, setNewVoiceName] = useState("");
  const [showGroq, setShowGroq] = useState(false);
  const [showGoogleCloud, setShowGoogleCloud] = useState(false);
  const [showInworld, setShowInworld] = useState(false);

  const [groqStatus, setGroqStatus] = useState<HealthStatus>("idle");
  const [groqMsg, setGroqMsg] = useState("");
  const [googleCloudStatus, setGoogleCloudStatus] = useState<HealthStatus>("idle");
  const [googleCloudMsg, setGoogleCloudMsg] = useState("");
  const [inworldStatus, setInworldStatus] = useState<HealthStatus>("idle");
  const [inworldMsg, setInworldMsg] = useState("");
  const [renderStatus, setRenderStatus] = useState<HealthStatus>("idle");
  const [renderMsg, setRenderMsg] = useState("");

  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [purgeLoading, setPurgeLoading] = useState(false);

  const [bgTrackCount, setBgTrackCount] = useState<number | null>(null);

  const fetchBgTracks = async () => {
    try {
      const res = await fetch("/api/render/bgmusic/tracks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBgTrackCount(data.count);
    } catch {
      setBgTrackCount(0);
    }
  };

  useEffect(() => { fetchBgTracks(); }, []);

  const save = () => {
    saveProviderSettings(settings);
    toast.success("Settings saved");
  };

  const testGroq = async () => {
    const firstKey = (settings.groqApiKeys || []).find(k => k?.trim());
    if (!firstKey) { setGroqStatus("error"); setGroqMsg("No API key provided"); return; }
    setGroqStatus("checking"); setGroqMsg("");
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${firstKey}` },
      });
      if (res.status === 401) { setGroqStatus("error"); setGroqMsg("Invalid API key"); return; }
      if (res.status === 429) { setGroqStatus("error"); setGroqMsg("Rate limited — try again later"); return; }
      if (!res.ok) { setGroqStatus("error"); setGroqMsg(`HTTP ${res.status}`); return; }
      setGroqStatus("ok");
    } catch (e: any) {
      setGroqStatus("error"); setGroqMsg(e.message?.includes("fetch") ? "Network error" : e.message);
    }
  };

  const testGoogleCloud = async () => {
    if (!settings.googleCloudApiKey) {
      setGoogleCloudStatus("error");
      setGoogleCloudMsg("No API key provided");
      return;
    }
    setGoogleCloudStatus("checking"); setGoogleCloudMsg("");
    try {
      const res = await fetch("/api/gemini-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "gemini-chat",
          apiKey: settings.googleCloudApiKey,
          payload: {
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts: [{ text: "Say ok" }] }],
            generationConfig: {
              maxOutputTokens: 10,
            }
          }
        })
      });
      const data = await res.json();
      if (res.status === 401 || data?.status === 401) { setGoogleCloudStatus("error"); setGoogleCloudMsg("Invalid API key"); return; }
      if (!res.ok || data?.error) { setGoogleCloudStatus("error"); setGoogleCloudMsg(data?.error || `HTTP ${res.status}`); return; }
      setGoogleCloudStatus("ok");
    } catch (e: any) {
      setGoogleCloudStatus("error"); setGoogleCloudMsg(e.message?.includes("fetch") ? "Network error" : e.message);
    }
  };


  const testInworld = async () => {
    if (!settings.inworldApiKey) { setInworldStatus("error"); setInworldMsg("No API key provided"); return; }
    setInworldStatus("checking"); setInworldMsg("");
    try {
      const res = await fetch("https://api.inworld.ai/tts/v1/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${settings.inworldApiKey}` },
        body: JSON.stringify({
          text: "test", voiceId: "Dennis", modelId: "inworld-tts-1.5-max",
          audioConfig: { audioEncoding: "MP3", sampleRateHertz: 22050 },
          temperature: 1.0, applyTextNormalization: "ON",
        }),
      });
      if (res.status === 401 || res.status === 403) { setInworldStatus("error"); setInworldMsg("Invalid API key"); return; }
      if (res.status === 429) { setInworldStatus("error"); setInworldMsg("Rate limited"); return; }
      if (!res.ok) { setInworldStatus("error"); setInworldMsg(`HTTP ${res.status}`); return; }
      const data = await res.json();
      if (!data?.audioContent) { setInworldStatus("error"); setInworldMsg("No audio returned"); return; }
      setInworldStatus("ok");
    } catch (e: any) {
      setInworldStatus("error"); setInworldMsg(e.message?.includes("fetch") ? "Network error" : e.message);
    }
  };

  const testRenderApi = async () => {
    setRenderStatus("checking"); setRenderMsg("");
    try {
      const res = await fetch("/api/render/health");
      const data = await res.json();
      if (data.ok) { setRenderStatus("ok"); setRenderMsg(`${data.ms}ms · ${data.url}`); }
      else { setRenderStatus("error"); setRenderMsg(data.error ?? `HTTP ${data.status}`); }
    } catch (e: any) {
      setRenderStatus("error"); setRenderMsg("Could not reach server");
    }
  };

  const testAll = () => { testGroq(); testGoogleCloud(); testInworld(); testRenderApi(); };

  const fetchStorage = async () => {
    setStorageLoading(true);
    try {
      const res = await fetch("/api/admin/storage");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStorageInfo(await res.json());
    } catch (e: any) {
      toast.error(`Storage scan failed: ${e.message}`);
    } finally {
      setStorageLoading(false);
    }
  };

  const executePurge = async (scope: string) => {
    if (confirmPurge !== scope) {
      setConfirmPurge(scope);
      setTimeout(() => setConfirmPurge(c => c === scope ? null : c), 6000);
      return;
    }
    setConfirmPurge(null);
    setPurgeLoading(true);
    try {
      const res = await fetch("/api/admin/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success(`Purged ${data.deleted.files} file(s) (${formatBytes(data.deleted.bytes)})`);
      fetchStorage();
    } catch (e: any) {
      toast.error(`Purge failed: ${e.message}`);
    } finally {
      setPurgeLoading(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "connections",  label: "Connections",  icon: <Key className="h-4 w-4" /> },
    { id: "providers",    label: "Providers",    icon: <Server className="h-4 w-4" /> },
    { id: "voices",       label: "Voices",       icon: <Mic className="h-4 w-4" /> },
    { id: "maintenance",  label: "Maintenance",  icon: <HardDrive className="h-4 w-4" /> },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 md:p-12 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-display text-foreground">Settings</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={testAll}>
            <Wifi className="h-4 w-4 mr-2" />Test All
          </Button>
          <Button onClick={save} size="sm" className="font-display">
            <Save className="h-4 w-4 mr-2" />Save
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── CONNECTIONS TAB ───────────────────────────────────────────── */}
      {activeTab === "connections" && (
        <div className="space-y-6">
          {/* Render API */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Render API (FFmpeg Server)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">FFmpeg Render Server</p>
                  <p className="text-xs text-muted-foreground">Ken Burns animation, video merging, transitions</p>
                </div>
                <div className="flex items-center gap-2">
                  {renderStatus !== "idle" && (
                    <div className="space-y-1 text-right">
                      <StatusIndicator status={renderStatus} />
                      {renderMsg && <p className="text-xs text-muted-foreground max-w-[200px] truncate">{renderMsg}</p>}
                    </div>
                  )}
                  <Button variant="outline" size="sm" onClick={testRenderApi} className="text-xs h-7">
                    {renderStatus === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test Connection"}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground bg-secondary rounded px-3 py-2">
                <span className="text-foreground font-medium">Endpoints:</span> /animate · /merge · /concat-transitions
              </p>
            </CardContent>
          </Card>

          {/* API Keys */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">API Keys</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Groq */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">Groq API Keys</label>
                  <div className="flex items-center gap-2">
                    <StatusIndicator status={groqStatus} message={groqMsg} />
                    <Button variant="ghost" size="icon" onClick={() => setShowGroq(!showGroq)} title={showGroq ? "Hide keys" : "Show keys"}>
                      {showGroq ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={testGroq} className="text-xs h-7">
                      {groqStatus === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                    </Button>
                  </div>
                </div>
                {(settings.groqApiKeys || [""]).map((key, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      type={showGroq ? "text" : "password"}
                      placeholder="gsk_..."
                      value={key}
                      onChange={(e) => {
                        const keys = [...(settings.groqApiKeys || [""])];
                        keys[i] = e.target.value;
                        setSettings(s => ({ ...s, groqApiKeys: keys }));
                        setGroqStatus("idle");
                      }}
                      className="bg-secondary flex-1"
                    />
                    {(settings.groqApiKeys || [""]).length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          const keys = (settings.groqApiKeys || [""]).filter((_, idx) => idx !== i);
                          setSettings(s => ({ ...s, groqApiKeys: keys }));
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {(settings.groqApiKeys || [""]).length < 5 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => setSettings(s => ({ ...s, groqApiKeys: [...(s.groqApiKeys || [""]), ""] }))}
                  >
                    <Plus className="h-3 w-3 mr-1" />Add backup key
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">Scene splitting and prompt generation — add up to 5 keys for automatic failover on rate limits. Get keys at console.groq.com</p>
              </div>

              {(settings.textProvider === "groq" || (settings.groqApiKeys || []).some(k => k?.trim())) && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Groq Model</label>
                  <Select
                    value={settings.groqModel || "llama-3.3-70b-versatile"}
                    onValueChange={(v) => setSettings(s => ({ ...s, groqModel: v }))}
                  >
                    <SelectTrigger className="bg-secondary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GROQ_MODELS.map(m => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name} {m.tpd !== "No limit" ? `(${(m.tpd as number / 1000).toFixed(0)}K TPD)` : "(No limit)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Free plan: Llama 4 Scout has 500K tokens/day vs 100K for 70B</p>
                </div>
              )}

              <div className="border-t border-border" />

              {/* Google Cloud */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">Google Cloud API Key</label>
                  <div className="flex items-center gap-2">
                    <StatusIndicator status={googleCloudStatus} message={googleCloudMsg} />
                    <Button variant="ghost" size="sm" onClick={testGoogleCloud} className="text-xs h-7">
                      {googleCloudStatus === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                    </Button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Input
                    type={showGoogleCloud ? "text" : "password"}
                    placeholder="AIzaSy..."
                    value={settings.googleCloudApiKey || ""}
                    onChange={(e) => { setSettings(s => ({ ...s, googleCloudApiKey: e.target.value })); setGoogleCloudStatus("idle"); }}
                    className="bg-secondary flex-1"
                  />
                  <Button variant="ghost" size="icon" onClick={() => setShowGoogleCloud(!showGoogleCloud)}>
                    {showGoogleCloud ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Google Cloud API Key — used for Vertex AI Gemini models.</p>
              </div>

              {settings.textProvider === "claude" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Claude Model</label>
                  <Select
                    value={settings.claudeModel || "claude-sonnet-4-6"}
                    onValueChange={(v) => setSettings(s => ({ ...s, claudeModel: v }))}
                  >
                    <SelectTrigger className="bg-secondary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude-sonnet-4-6">Sonnet 4.6 (Vertex AI)</SelectItem>
                      <SelectItem value="claude-haiku-4-5">Haiku 4.5 (Vertex AI)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {settings.textProvider === "gemini" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Gemini Model</label>
                  <Select
                    value={settings.geminiModel || "gemini-3.1-pro-preview"}
                    onValueChange={(v) => setSettings(s => ({ ...s, geminiModel: v }))}
                  >
                    <SelectTrigger className="bg-secondary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Vertex AI)</SelectItem>
                      <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro (Vertex AI)</SelectItem>
                      <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash (Vertex AI)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="border-t border-border" />

              {/* Inworld */}
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
                    onChange={(e) => { setSettings(s => ({ ...s, inworldApiKey: e.target.value })); setInworldStatus("idle"); }}
                    className="bg-secondary flex-1"
                  />
                  <Button variant="ghost" size="icon" onClick={() => setShowInworld(!showInworld)}>
                    {showInworld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Inworld TTS key (Base64 encoded) — get one at inworld.ai/studio</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── PROVIDERS TAB ─────────────────────────────────────────────── */}
      {activeTab === "providers" && (
        <div className="space-y-6">
          {/* Text Generation */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Text Generation / Script Parsing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">AI Text Provider</label>
                <Select
                  value={settings.textProvider || "groq"}
                  onValueChange={(v) => setSettings(s => ({ ...s, textProvider: v as "groq" | "claude" | "inworld" | "gemini" }))}
                >
                  <SelectTrigger className="bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="groq">Llama 3.3 70B (Groq)</SelectItem>
                    <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                    <SelectItem value="inworld">Llama 4 Maverick (Inworld - 128k context)</SelectItem>
                    <SelectItem value="gemini">Gemini 3.5 Flash (Google)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Select the AI provider used for scene manifest creation and prompt generation.</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Image Generation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Image Provider</label>
                <Select
                  value={settings.imageProvider}
                  onValueChange={(v) => setSettings(s => ({ ...s, imageProvider: v }))}
                >
                  <SelectTrigger className="bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gemini">Vertex AI (Imagen / Gemini)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Default Image Model</label>
                <Select
                  value={settings.imageModel || "imagen-4.0-fast-generate-001"}
                  onValueChange={(v) => setSettings(s => ({ ...s, imageModel: v }))}
                >
                  <SelectTrigger className="bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IMAGE_MODELS.map(m => (
                      <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Aspect Ratio</label>
                <Select
                  value={settings.aspectRatio || "16:9"}
                  onValueChange={(v) => setSettings(s => ({ ...s, aspectRatio: v as "16:9" | "9:16" }))}
                >
                  <SelectTrigger className="bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECT_RATIOS.map(r => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Applied to all image models — 16:9 for landscape, 9:16 for portrait</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Image Concurrency: {settings.imageConcurrency}
                </label>
                <Slider
                  value={[settings.imageConcurrency]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, imageConcurrency: v }))}
                  min={1} max={5} step={1}
                />
                <p className="text-xs text-muted-foreground">Number of images generated in parallel</p>
              </div>
              <div className="flex items-center justify-between pt-1">
                <div>
                  <label className="text-sm font-medium text-foreground">Generate Images</label>
                  <p className="text-xs text-muted-foreground">Turn off to skip image generation for new projects</p>
                </div>
                <Switch
                  checked={!settings.skipImageGeneration}
                  onCheckedChange={(checked) => setSettings(s => ({ ...s, skipImageGeneration: !checked }))}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Veo Video Animation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Veo Ambient Audio Volume: {Math.round((settings.veoAudioVolume ?? 0.03) * 100)}%
                </label>
                <Slider
                  value={[settings.veoAudioVolume ?? 0.03]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, veoAudioVolume: v }))}
                  min={0.0} max={0.3} step={0.01}
                />
                <p className="text-xs text-muted-foreground">
                  Ambient audio from the Veo video mixed quietly under the narrator. Set to 0% to silence it. Default: 3%.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Background Music</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-foreground">Enable Background Music</label>
                  <p className="text-xs text-muted-foreground">Mix a random track from the bg_music/ folder into the final video</p>
                </div>
                <Switch
                  checked={settings.bgMusicEnabled ?? true}
                  onCheckedChange={(checked) => setSettings(s => ({ ...s, bgMusicEnabled: checked }))}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Music Volume: {Math.round((settings.bgMusicVolume ?? 0.10) * 100)}%
                </label>
                <Slider
                  value={[settings.bgMusicVolume ?? 0.10]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, bgMusicVolume: v }))}
                  min={0.0} max={1.0} step={0.01}
                  disabled={!(settings.bgMusicEnabled ?? true)}
                />
                <p className="text-xs text-muted-foreground">Volume of the background track under the narration. Default: 10%.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Narration Volume: {Math.round((settings.narrationVolume ?? 2.0) * 100)}%
                </label>
                <Slider
                  value={[settings.narrationVolume ?? 2.0]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, narrationVolume: v }))}
                  min={0.5} max={3.0} step={0.1}
                  disabled={!(settings.bgMusicEnabled ?? true)}
                />
                <p className="text-xs text-muted-foreground">Boost applied to the narrator audio when music is mixed in. Default: 200%.</p>
              </div>

              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-muted-foreground">
                  {bgTrackCount === null
                    ? "Checking bg_music/ folder…"
                    : `${bgTrackCount} track${bgTrackCount === 1 ? "" : "s"} in bg_music/ — picks one at random per render`}
                </p>
                <Button variant="ghost" size="sm" className="text-xs h-7" onClick={fetchBgTracks}>
                  <RefreshCw className="h-3 w-3 mr-1" />Refresh
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Text-to-Speech</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">TTS Provider</label>
                <Select
                  value={settings.ttsProvider}
                  onValueChange={(v) => setSettings(s => ({ ...s, ttsProvider: v }))}
                >
                  <SelectTrigger className="bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inworld">Inworld AI</SelectItem>
                  </SelectContent>
                </Select>
                {settings.ttsProvider === "inworld" && !settings.inworldApiKey && (
                  <p className="text-xs text-destructive">⚠ Inworld API Key required — configure it in the Connections tab</p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">TTS Model</label>
                <Select
                  value={settings.modelId}
                  onValueChange={(v) => setSettings(s => ({ ...s, modelId: v }))}
                >
                  <SelectTrigger className="bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inworld-tts-2">TTS 2 (Latest)</SelectItem>
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
                  onValueChange={([v]) => setSettings(s => ({ ...s, audioConcurrency: v }))}
                  min={1} max={5} step={1}
                />
                <p className="text-xs text-muted-foreground">Number of audio tracks generated in parallel</p>
              </div>
            </CardContent>
          </Card>

          {/* Subtitles / Overlay */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Video Subtitles / Overlay</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Start Delay: {settings.subtitleDelay ?? 0.8} seconds
                </label>
                <Slider
                  value={[settings.subtitleDelay ?? 0.8]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, subtitleDelay: v }))}
                  min={0.0} max={5.0} step={0.1}
                />
                <p className="text-xs text-muted-foreground">
                  Delay before subtitle typing animation starts on each scene (offsetting TTS audio silence/breathing room).
                </p>
              </div>

              <div className="border-t border-border" />

              {/* Font */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Overlay Font</label>
                <Select
                  value={settings.overlayFont ?? "Tox Typewriter"}
                  onValueChange={(v) => setSettings(s => ({ ...s, overlayFont: v }))}
                >
                  <SelectTrigger className="bg-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OVERLAY_FONTS.map(f => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Font used for burned-in overlay text in the exported video.</p>
              </div>

              <div className="border-t border-border" />

              {/* Font Size */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Overlay Font Size: {settings.overlayFontSize ?? 36} px
                </label>
                <Slider
                  value={[settings.overlayFontSize ?? 36]}
                  onValueChange={([v]) => setSettings(s => ({ ...s, overlayFontSize: v }))}
                  min={12} max={80} step={1}
                />
                <p className="text-xs text-muted-foreground">Size of the overlay text (defaults to 36 px).</p>
              </div>

              <div className="border-t border-border" />

              {/* Position grid */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Overlay Position</label>
                <div className="grid grid-cols-3 gap-1.5 w-fit">
                  {OVERLAY_POSITIONS.map(p => {
                    const active = (settings.overlayPosition ?? "bottom-left") === p.value;
                    return (
                      <button
                        key={p.value}
                        onClick={() => setSettings(s => ({ ...s, overlayPosition: p.value as OverlayPosition }))}
                        className={`px-3 py-2 rounded text-xs font-medium transition-colors ${
                          active
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-muted-foreground hover:bg-primary/20 hover:text-foreground"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">Where the overlay text appears in the frame.</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── MAINTENANCE TAB ──────────────────────────────────────────── */}
      {activeTab === "maintenance" && (
        <div className="space-y-6">
          {/* Storage Overview */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-display">Storage Overview</CardTitle>
                <Button
                  variant="outline" size="sm"
                  onClick={fetchStorage}
                  disabled={storageLoading}
                  className="text-xs h-7"
                >
                  {storageLoading
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <><RefreshCw className="h-3 w-3 mr-1" />Scan</>
                  }
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {storageInfo === null ? (
                <p className="text-sm text-muted-foreground">Click Scan to check server storage usage.</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">{storageInfo.projectCount} project folder(s) on server</p>
                  <div className="grid grid-cols-2 gap-3">
                    {([
                      { key: "images",  label: "Images",         ext: "PNG/JPG" },
                      { key: "audio",   label: "TTS Audio",      ext: "MP3" },
                      { key: "videos",  label: "Veo Videos",     ext: "MP4" },
                      { key: "renders", label: "Render Outputs", ext: "Clips + Output" },
                    ] as const).map(({ key, label, ext }) => {
                      const info = storageInfo[key];
                      return (
                        <div key={key} className="bg-secondary rounded p-3 space-y-1">
                          <p className="text-xs font-medium text-foreground">{label}</p>
                          <p className="text-xs text-muted-foreground">{ext}</p>
                          <p className="text-sm font-mono">{info.files} files · {formatBytes(info.bytes)}</p>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Total generated: {formatBytes(
                      storageInfo.images.bytes + storageInfo.audio.bytes +
                      storageInfo.videos.bytes + storageInfo.renders.bytes
                    )}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Purge Controls */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <CardTitle className="text-base font-display">Purge Generated Assets</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-xs text-muted-foreground mb-4">
                Permanently deletes generated files from the server. Project records, settings, and style reference images are preserved. Scene statuses reset so assets can be regenerated.
              </p>

              {([
                {
                  scope: "images",
                  label: "Purge Images",
                  description: "All generated scene images (PNG/JPG). Resets image status to pending.",
                },
                {
                  scope: "audio",
                  label: "Purge Audio",
                  description: "All TTS narration tracks (MP3). Resets audio status to pending.",
                },
                {
                  scope: "videos",
                  label: "Purge Veo Videos + Renders",
                  description: "All Veo-animated clips, Ken Burns clips, and merged output.mp4.",
                },
                {
                  scope: "renders",
                  label: "Purge Render Outputs Only",
                  description: "Only final clips and output.mp4 — keeps Veo-animated source videos.",
                },
                {
                  scope: "all",
                  label: "Purge Everything",
                  description: "All images, audio, videos, and render outputs across all projects.",
                  danger: true,
                },
              ] as const).map(({ scope, label, description, danger }) => {
                const isArmed = confirmPurge === scope;
                return (
                  <div key={scope} className="flex items-center justify-between py-3 border-b border-border last:border-0">
                    <div className="flex-1 pr-4">
                      <p className="text-sm font-medium text-foreground">{label}</p>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                    <Button
                      size="sm"
                      variant={isArmed ? "destructive" : (danger ? "outline" : "outline")}
                      className={`text-xs shrink-0 ${danger && !isArmed ? "border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground" : ""}`}
                      disabled={purgeLoading}
                      onClick={() => executePurge(scope)}
                    >
                      {purgeLoading && confirmPurge === null
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : isArmed
                          ? "Confirm Delete"
                          : <><Trash2 className="h-3 w-3 mr-1" />{scope === "all" ? "Purge All" : "Purge"}</>
                      }
                    </Button>
                  </div>
                );
              })}

              {confirmPurge && (
                <p className="text-xs text-destructive pt-2">
                  Click "Confirm Delete" to proceed, or wait 6 seconds to cancel.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── VOICES TAB ────────────────────────────────────────────────── */}
      {activeTab === "voices" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Default Voice</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="text-sm font-medium text-foreground">Voice</label>
              <Select
                value={settings.voiceId}
                onValueChange={(v) => setSettings(s => ({ ...s, voiceId: v }))}
              >
                <SelectTrigger className="bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_group_builtin" disabled className="text-xs font-semibold text-muted-foreground">— Built-in Voices —</SelectItem>
                  {INWORLD_VOICES.map(v => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} — {v.description}
                    </SelectItem>
                  ))}
                  {(settings.customVoices || []).length > 0 && (
                    <SelectItem value="_group_custom" disabled className="text-xs font-semibold text-muted-foreground">— Custom Voices —</SelectItem>
                  )}
                  {(settings.customVoices || []).map(v => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} (custom)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Default voice for all new scenes. Can be overridden per scene.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-display">Custom Voices</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">Add a voice by its Inworld voice ID and a display name.</p>
              <div className="flex gap-2">
                <Input
                  placeholder="Voice ID (e.g. Jordan)"
                  value={newVoiceId}
                  onChange={(e) => setNewVoiceId(e.target.value)}
                  className="bg-secondary flex-1"
                  data-testid="input-custom-voice-id"
                />
                <Input
                  placeholder="Display name"
                  value={newVoiceName}
                  onChange={(e) => setNewVoiceName(e.target.value)}
                  className="bg-secondary flex-1"
                  data-testid="input-custom-voice-name"
                />
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-add-custom-voice"
                  onClick={() => {
                    const id = newVoiceId.trim();
                    const name = newVoiceName.trim() || id;
                    if (!id) return;
                    const existing = settings.customVoices || [];
                    if (existing.some(v => v.id === id)) { toast.error("A voice with that ID already exists."); return; }
                    setSettings(s => ({ ...s, customVoices: [...(s.customVoices || []), { id, name }] }));
                    setNewVoiceId("");
                    setNewVoiceName("");
                  }}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {(settings.customVoices || []).length > 0 ? (
                <div className="space-y-2">
                  {(settings.customVoices || []).map(v => (
                    <div key={v.id} className="flex items-center justify-between bg-secondary rounded px-3 py-2">
                      <div>
                        <span className="text-sm font-medium">{v.name}</span>
                        <span className="text-xs text-muted-foreground ml-2">ID: {v.id}</span>
                      </div>
                      <Button
                        size="sm" variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        data-testid={`button-remove-voice-${v.id}`}
                        onClick={() => setSettings(s => ({ ...s, customVoices: (s.customVoices || []).filter(x => x.id !== v.id) }))}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">No custom voices added yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
