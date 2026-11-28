import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function GnaniVoicePreview() {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState("Hello from OpenWhispr.");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [audio, setAudio] = useState<Blob | null>(null);
  const playerRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const player = playerRef.current;
    if (!audio || !player) return;
    const url = URL.createObjectURL(audio);
    player.src = url;
    return () => {
      player.pause();
      URL.revokeObjectURL(url);
    };
  }, [audio]);

  async function readAloud() {
    setError("");
    setAudio(null);
    setLoading(true);
    try {
      const result = await window.electronAPI.previewGnaniVoice(text.trim());
      if ("audio" in result) setAudio(new Blob([result.audio], { type: "audio/mpeg" }));
      else setError(result.messageKey ? t(result.messageKey, result.messageParams) : result.error);
    } catch {
      setError(t("transcription.gnani.voicePreviewFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {t("transcription.gnani.voicePreview")}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          dir="auto"
          maxLength={300}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !text.trim()}
          onClick={readAloud}
        >
          {t(loading ? "common.loading" : "agentWindow.actions.readAloud")}
        </Button>
      </div>
      {audio && (
        <audio
          ref={playerRef}
          controls
          autoPlay
          className="w-full"
          aria-label={t("transcription.gnani.voicePreview")}
          onError={() => setError(t("transcription.gnani.voicePreviewFailed"))}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
