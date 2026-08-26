import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { VoicePill, type VoicePillState } from "./VoicePill";
import "../../styles/agent-dictation-pill.css";

type DictationLifecycle = "idle" | "recording" | "processing";
const getUnavailableAudioLevel = () => null;

export default function AgentDictationPillOverlay() {
  const { t } = useTranslation();
  const [lifecycle, setLifecycle] = useState<DictationLifecycle>("idle");
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const dispose = window.electronAPI.onAgentDictationPillStateChanged?.(setLifecycle);
    void window.electronAPI.getAgentDictationPillState?.().then(setLifecycle);
    return dispose;
  }, []);

  const state: VoicePillState = lifecycle === "idle" && hovered ? "hover" : lifecycle;
  const label =
    lifecycle === "recording"
      ? t("app.mic.recording")
      : lifecycle === "processing"
        ? t("app.mic.processing")
        : t("app.mic.clickToSpeak");

  return (
    <main className="agent-dictation-pill-window flex h-full w-full items-center justify-center bg-transparent">
      <VoicePill
        variant="floating"
        state={state}
        expanded={lifecycle === "recording"}
        waveformOnlyWhileRecording
        getAudioLevel={getUnavailableAudioLevel}
        role="button"
        aria-label={label}
        aria-disabled={lifecycle === "processing"}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          if (lifecycle !== "processing") void window.electronAPI.toggleAgentPanelDictation?.();
        }}
      />
    </main>
  );
}
