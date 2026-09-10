import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  ChevronDown,
  Download,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Toggle } from "./ui/toggle";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { useSettingsStore } from "../stores/settingsStore";

const MAX_TEXT_CHARS = 15000;
type TtsVoice = {
  voiceId: string;
  name: string;
  language: string;
  gender: string;
  source: "default" | "custom";
};

type StreamingQuality = 0 | 1 | 2;

const EXAMPLE_IDS = ["support", "sales", "podcast", "announcement", "meditation"] as const;

const INSTANT_TAGS = [
  { tag: "[pause]", key: "pause", category: "pauses" },
  { tag: "[long-pause]", key: "longPause", category: "pauses" },
  { tag: "[hum-tune]", key: "humTune", category: "pauses" },
  { tag: "[laugh]", key: "laugh", category: "laughter" },
  { tag: "[chuckle]", key: "chuckle", category: "laughter" },
  { tag: "[giggle]", key: "giggle", category: "laughter" },
  { tag: "[cry]", key: "cry", category: "laughter" },
  { tag: "[tsk]", key: "tsk", category: "mouth" },
  { tag: "[tongue-click]", key: "tongueClick", category: "mouth" },
  { tag: "[lip-smack]", key: "lipSmack", category: "mouth" },
  { tag: "[breath]", key: "breath", category: "breathing" },
  { tag: "[inhale]", key: "inhale", category: "breathing" },
  { tag: "[exhale]", key: "exhale", category: "breathing" },
  { tag: "[sigh]", key: "sigh", category: "breathing" },
] as const;

const WRAPPING_TAGS = [
  { open: "<soft>", close: "</soft>", key: "soft", category: "volume" },
  { open: "<whisper>", close: "</whisper>", key: "whisper", category: "volume" },
  { open: "<loud>", close: "</loud>", key: "loud", category: "volume" },
  { open: "<build-intensity>", close: "</build-intensity>", key: "buildIntensity", category: "volume" },
  { open: "<decrease-intensity>", close: "</decrease-intensity>", key: "decreaseIntensity", category: "volume" },
  { open: "<higher-pitch>", close: "</higher-pitch>", key: "higherPitch", category: "pitch" },
  { open: "<lower-pitch>", close: "</lower-pitch>", key: "lowerPitch", category: "pitch" },
  { open: "<slow>", close: "</slow>", key: "slow", category: "pitch" },
  { open: "<fast>", close: "</fast>", key: "fast", category: "pitch" },
  { open: "<sing-song>", close: "</sing-song>", key: "singSong", category: "style" },
  { open: "<singing>", close: "</singing>", key: "singing", category: "style" },
  { open: "<emphasis>", close: "</emphasis>", key: "emphasis", category: "style" },
] as const;

const SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];
const BIT_RATES = [32000, 64000, 96000, 128000, 192000];

function voiceSubtitle(voice: TtsVoice, t: (key: string) => string) {
  const gender =
    voice.gender === "male"
      ? t("settingsPage.textToSpeech.voices.male")
      : voice.gender === "female"
        ? t("settingsPage.textToSpeech.voices.female")
        : "";
  const language = t("settingsPage.textToSpeech.voices.multilingual");
  return [gender, language].filter(Boolean).join(", ");
}

export default function XaiTtsPlayground() {
  const { t } = useTranslation();
  const xaiOAuthConnected = useSettingsStore((s) => s.xaiOAuthConnected);
  const xaiApiKey = useSettingsStore((s) => s.xaiApiKey);
  const setXaiOAuthConnected = useSettingsStore((s) => s.setXaiOAuthConnected);
  const ready = xaiOAuthConnected || Boolean(xaiApiKey.trim());

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef<string | null>(null);

  const [text, setText] = useState("");
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voiceId, setVoiceId] = useState("carina");
  const [voiceTab, setVoiceTab] = useState<"custom" | "default">("default");
  const [voiceQuery, setVoiceQuery] = useState("");
  const [speed, setSpeed] = useState(1);
  const [streaming, setStreaming] = useState<StreamingQuality>(1);
  const [sampleRate, setSampleRate] = useState(24000);
  const [bitRate, setBitRate] = useState(128000);
  const [normalize, setNormalize] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [effectsTab, setEffectsTab] = useState<"instant" | "wrapping">("instant");
  const [effectsQuery, setEffectsQuery] = useState("");

  const selectedVoice = voices.find((voice) => voice.voiceId === voiceId) ?? voices[0];

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const listed = await window.electronAPI.xaiTtsVoices?.();
        if (cancelled || !Array.isArray(listed) || listed.length === 0) return;
        setVoices(listed as TtsVoice[]);
        setVoiceId((current) =>
          listed.some((voice) => voice.voiceId === current) ? current : listed[0].voiceId
        );
      } catch {
        /* bundled fallback lives in main */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  useEffect(
    () => () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    },
    []
  );
  const insertAtCursor = useCallback((snippet: string, wrap?: { open: string; close: string }) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const selected = text.slice(start, end);
    const inner = selected || (wrap ? "…" : snippet);
    const inserted = wrap ? wrap.open + inner + wrap.close : snippet;
    const next = text.slice(0, start) + inserted + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = start + inserted.length;
      el?.setSelectionRange(caret, caret);
    });
  }, [text]);

  const applyExample = (id: (typeof EXAMPLE_IDS)[number]) => {
    setText(t(`settingsPage.textToSpeech.examples.${id}Text`));
  };

  const handleLogin = async () => {
    setOauthBusy(true);
    try {
      const result = await window.electronAPI.xaiOAuthLogin?.();
      setXaiOAuthConnected(Boolean(result?.connected) && !result?.error);
    } catch {
      const status = await window.electronAPI.xaiOAuthStatus?.();
      setXaiOAuthConnected(Boolean(status?.connected));
    } finally {
      setOauthBusy(false);
    }
  };

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setPlaying(false);
    try {
      const result = await window.electronAPI.xaiTtsGenerate?.({
        text,
        voiceId: selectedVoice?.voiceId || voiceId,
        language: "auto",
        speed,
        optimizeStreamingLatency: streaming,
        codec: "mp3",
        sampleRate,
        bitRate,
        textNormalization: normalize,
        withTimestamps: timestamps,
      });
      if (!result?.success || !result.audioBase64) {
        setError(
          result?.errorCode
            ? t(`settingsPage.textToSpeech.errors.${result.errorCode}`, {
                defaultValue: result.error || t("settingsPage.textToSpeech.errors.generic"),
              })
            : t("settingsPage.textToSpeech.errors.generic")
        );
        return;
      }
      const binary = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([binary], { type: result.contentType || "audio/mpeg" });
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      setHasAudio(true);
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
        setPlaying(true);
      }
    } catch {
      setError(t("settingsPage.textToSpeech.errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!audioUrlRef.current) return;
    const link = document.createElement("a");
    link.href = audioUrlRef.current;
    link.download = "openwhispr-tts.mp3";
    link.click();
  };

  const filteredVoices = useMemo(() => {
    const q = voiceQuery.trim().toLowerCase();
    return voices.filter((voice) => {
      if (voiceTab === "custom" ? voice.source !== "custom" : voice.source !== "default") return false;
      if (!q) return true;
      return voice.name.toLowerCase().includes(q) || voice.voiceId.toLowerCase().includes(q);
    });
  }, [voices, voiceQuery, voiceTab]);

  if (!ready) {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
        <p className="text-sm text-muted-foreground">{t("settings.speech.xaiOauth.hint")}</p>
        <Button type="button" size="sm" disabled={oauthBusy} onClick={() => void handleLogin()}>
          {oauthBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t("settings.speech.xaiOauth.connect")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-center space-y-2">
        <p className="text-sm font-medium text-foreground">
          {t("settingsPage.textToSpeech.examples.pick")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.textToSpeech.examples.orCustom")}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {EXAMPLE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => applyExample(id)}
              className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted"
            >
              {t(`settingsPage.textToSpeech.examples.${id}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="outline" className="gap-1.5">
                <AudioLines className="h-3.5 w-3.5" />
                {selectedVoice?.name || t("settingsPage.textToSpeech.voices.label")}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={voiceQuery}
                  onChange={(event) => setVoiceQuery(event.target.value)}
                  placeholder={t("settingsPage.textToSpeech.voices.search")}
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <div className="mb-2 flex gap-1 rounded-lg bg-muted p-0.5">
                {(["custom", "default"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setVoiceTab(tab)}
                    className={`flex-1 rounded-md px-2 py-1 text-[11px] ${
                      voiceTab === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                    }`}
                  >
                    {t(`settingsPage.textToSpeech.voices.${tab}`)}
                  </button>
                ))}
              </div>
              <div className="max-h-64 overflow-y-auto">
                {filteredVoices.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    {t("settingsPage.textToSpeech.voices.empty")}
                  </p>
                ) : (
                  filteredVoices.map((voice) => (
                    <button
                      key={voice.voiceId}
                      type="button"
                      onClick={() => setVoiceId(voice.voiceId)}
                      className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left ${
                        voice.voiceId === voiceId ? "bg-muted" : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="text-xs font-medium">{voice.name}</span>
                      <span className="text-[11px] text-muted-foreground">{voiceSubtitle(voice, t)}</span>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="outline" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                {t("settingsPage.textToSpeech.effects.add")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-2" align="start">
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={effectsQuery}
                  onChange={(event) => setEffectsQuery(event.target.value)}
                  placeholder={t("settingsPage.textToSpeech.effects.search")}
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <div className="mb-2 flex gap-1 rounded-lg bg-muted p-0.5">
                {(["instant", "wrapping"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setEffectsTab(tab)}
                    className={`flex-1 rounded-md px-2 py-1 text-[11px] ${
                      effectsTab === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                    }`}
                  >
                    {t(`settingsPage.textToSpeech.effects.${tab}`)}
                  </button>
                ))}
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {effectsTab === "instant"
                  ? INSTANT_TAGS.filter((item) => {
                      const q = effectsQuery.trim().toLowerCase();
                      if (!q) return true;
                      return item.tag.includes(q) || item.key.toLowerCase().includes(q);
                    }).map((item, index, list) => (
                      <div key={item.tag}>
                        {(index === 0 || list[index - 1]?.category !== item.category) && (
                          <p className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t(`settingsPage.textToSpeech.effects.categories.${item.category}`)}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => insertAtCursor(item.tag)}
                          className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                        >
                          <div className="text-xs font-medium">{item.tag}</div>
                        </button>
                      </div>
                    ))
                  : WRAPPING_TAGS.filter((item) => {
                      const q = effectsQuery.trim().toLowerCase();
                      if (!q) return true;
                      return item.key.toLowerCase().includes(q) || item.open.includes(q);
                    }).map((item, index, list) => (
                      <div key={item.key}>
                        {(index === 0 || list[index - 1]?.category !== item.category) && (
                          <p className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t(`settingsPage.textToSpeech.effects.categories.${item.category}`)}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => insertAtCursor("", { open: item.open, close: item.close })}
                          className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                        >
                          <div className="text-xs font-medium">
                            {item.open}…{item.close}
                          </div>
                        </button>
                      </div>
                    ))}
              </div>
            </PopoverContent>
          </Popover>


          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="ghost" className="gap-1 text-xs text-muted-foreground">
                {speed.toFixed(1)}x · {t(`settingsPage.textToSpeech.format.streaming.${streaming}`)} · MP3
                <ChevronDown className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 space-y-3 p-3" align="start">
              <label className="block space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{t("settingsPage.textToSpeech.format.speed")}</span>
                  <span>{speed.toFixed(1)}x</span>
                </div>
                <input
                  type="range"
                  min={0.7}
                  max={1.5}
                  step={0.1}
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                  className="w-full"
                />
              </label>
              <div className="space-y-1">
                <p className="text-xs">{t("settingsPage.textToSpeech.format.streamingLabel")}</p>
                <div className="flex gap-1 rounded-lg bg-muted p-0.5">
                  {([2, 1, 0] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setStreaming(value)}
                      className={`flex-1 rounded-md px-2 py-1 text-[11px] ${
                        streaming === value ? "bg-background shadow-sm" : "text-muted-foreground"
                      }`}
                    >
                      {t(`settingsPage.textToSpeech.format.streaming.${value}`)}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{t("settingsPage.textToSpeech.format.sampleRate")}</span>
                  <span>{sampleRate / 1000} kHz</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={SAMPLE_RATES.length - 1}
                  step={1}
                  value={SAMPLE_RATES.indexOf(sampleRate)}
                  onChange={(event) => setSampleRate(SAMPLE_RATES[Number(event.target.value)] ?? 24000)}
                  className="w-full"
                />
              </label>
              <label className="block space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{t("settingsPage.textToSpeech.format.bitRate")}</span>
                  <span>{Math.round(bitRate / 1000)} kbps</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={BIT_RATES.length - 1}
                  step={1}
                  value={BIT_RATES.indexOf(bitRate)}
                  onChange={(event) => setBitRate(BIT_RATES[Number(event.target.value)] ?? 128000)}
                  className="w-full"
                />
              </label>
              <div className="flex items-center justify-between">
                <span className="text-xs">{t("settingsPage.textToSpeech.format.textNormalization")}</span>
                <Toggle checked={normalize} onChange={setNormalize} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs">{t("settingsPage.textToSpeech.format.timestamps")}</span>
                <Toggle checked={timestamps} onChange={setTimestamps} />
              </div>
            </PopoverContent>
          </Popover>

          <div className="ml-auto flex items-center gap-2">
            {hasAudio && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const audio = audioRef.current;
                    if (!audio) return;
                    if (playing) {
                      audio.pause();
                      setPlaying(false);
                    } else {
                      void audio.play();
                      setPlaying(true);
                    }
                  }}
                >
                  {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={download}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button type="button" size="sm" disabled={busy || !text.trim()} onClick={() => void generate()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {t("settingsPage.textToSpeech.generate")}
            </Button>
          </div>
        </div>

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT_CHARS))}
          placeholder={t("settingsPage.textToSpeech.placeholder")}
          className="min-h-[240px] resize-y rounded-none border-0 shadow-none focus:ring-0"
        />
        <div className="flex justify-end px-3 py-1.5 text-[11px] text-muted-foreground">
          {t("settingsPage.textToSpeech.charCount", { count: text.length, max: MAX_TEXT_CHARS })}
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <audio
        ref={audioRef}
        className="hidden"
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
      />
    </div>
  );
}
