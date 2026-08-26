import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { useLiveTranscriptPanel } from "../../hooks/useLiveTranscriptPanel";
import {
  getListeningEntranceTimeline,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  resolveListeningEntrancePresentation,
  resolveLiveTranscriptEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoicePillDock,
  shouldOfferLiveTranscriptReopen,
} from "../../helpers/voicePillPresentation";
import { LiveTranscriptPanel, type LiveTranscriptPhase } from "./LiveTranscriptPanel";
import { VoiceModePanelCore, type VoiceModePanelStage } from "./VoiceModePanelCore";
import { VoicePill, type VoicePillState } from "./VoicePill";
import "../../styles/agent-dictation-pill.css";

type DictationLifecycle = "idle" | "recording" | "processing";
type HorizontalDirection = "left" | "right";
type CompanionState = {
  lifecycle: DictationLifecycle;
  interactive: boolean;
  horizontalDirection: HorizontalDirection;
};

const DEFAULT_STATE: CompanionState = {
  lifecycle: "idle",
  interactive: true,
  horizontalDirection: "left",
};
const UNAVAILABLE_RESIZE = { success: false, message: "Window not available" };

export default function AgentDictationPillOverlay() {
  const { t } = useTranslation();
  const [companionState, setCompanionState] = useState(DEFAULT_STATE);
  const [hovered, setHovered] = useState(false);
  const [listeningEntrancePhase, setListeningEntrancePhase] = useState("idle");
  const audioLevelRef = useRef<number | null>(null);
  const assistantOpenRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const applyState = (state: CompanionState) => {
      if (!disposed) setCompanionState(state);
    };
    const disposeState = window.electronAPI.onAgentDictationPillStateChanged?.(applyState);
    const disposeAudio = window.electronAPI.onAgentDictationPillAudioLevelChanged?.((level) => {
      audioLevelRef.current = level;
    });
    window.electronAPI
      .getAgentDictationPillState?.()
      .then(applyState)
      .catch(() => {});
    return () => {
      disposed = true;
      disposeState?.();
      disposeAudio?.();
    };
  }, []);

  const resizeToContent = useCallback(
    (height: number) =>
      window.electronAPI.resizeAgentDictationPillToContent?.(height) ??
      Promise.resolve(UNAVAILABLE_RESIZE),
    []
  );
  const isRecording = companionState.lifecycle === "recording";
  const isProcessing = companionState.lifecycle === "processing";
  const liveTranscript = useLiveTranscriptPanel({
    resizeToContent,
    assistantOpenRef,
    onWillOpen: undefined,
    isRecording,
    isProcessing,
    isAssistantVoice: false,
  });
  const { close: closeLiveTranscript, mounted: liveTranscriptMounted } = liveTranscript;

  useEffect(() => {
    if (!liveTranscriptMounted) {
      void window.electronAPI.resizeAgentDictationPillToContent?.(null);
    }
  }, [liveTranscriptMounted]);

  useEffect(() => {
    if (!companionState.interactive && liveTranscriptMounted) {
      closeLiveTranscript({ clear: true });
    }
  }, [closeLiveTranscript, companionState.interactive, liveTranscriptMounted]);

  useLayoutEffect(() => {
    if (!isRecording) {
      setListeningEntrancePhase("idle");
      audioLevelRef.current = null;
      return undefined;
    }

    setListeningEntrancePhase("thinking");
    const timeline = getListeningEntranceTimeline();
    const expansionTimer = setTimeout(
      () => setListeningEntrancePhase("expanding"),
      timeline.expandAtMs
    );
    const settledTimer = setTimeout(
      () => setListeningEntrancePhase("settled"),
      timeline.settleAtMs
    );
    const waveformTimer = setTimeout(
      () => setListeningEntrancePhase("waveform"),
      timeline.waveformAtMs
    );
    return () => {
      clearTimeout(expansionTimer);
      clearTimeout(settledTimer);
      clearTimeout(waveformTimer);
    };
  }, [isRecording]);

  const listeningEntrance = resolveListeningEntrancePresentation({
    isRecording,
    phase: listeningEntrancePhase,
  });
  const voiceActivity = resolveVoiceActivityPresentation({
    isRecording,
    isProcessing,
    isAssistantVoice: false,
    assistantThinking: false,
  });
  const liveTranscriptEntrance = resolveLiveTranscriptEntrancePresentation(
    liveTranscript.entrancePhase
  );
  const canReopenLiveTranscript = shouldOfferLiveTranscriptReopen({
    manuallyCollapsed: liveTranscript.manuallyCollapsed,
    isRecording,
    isProcessing,
    isAssistantVoice: false,
  });
  const horizontalDirection = companionState.horizontalDirection;
  const voicePillDock = resolveVoicePillDock({
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptEntrancePhase: liveTranscript.entrancePhase,
    assistantOpen: false,
    panelStartPosition: `bottom-${horizontalDirection}`,
    horizontalDirection,
  });
  const voicePillTravelDuration =
    liveTranscript.open && liveTranscript.entrancePhase === "encapsulate"
      ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
      : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs;
  const state = (listeningEntrance.activeState ||
    voiceActivity.activeState ||
    (hovered && companionState.interactive ? "hover" : "idle")) as VoicePillState;
  const expanded = isRecording ? listeningEntrance.compactPill : voiceActivity.compactPill;
  const pillInteractive =
    companionState.interactive && !isProcessing && (!liveTranscript.mounted || isRecording);
  const label = isRecording
    ? t("app.mic.recording")
    : isProcessing
      ? t("app.mic.processing")
      : canReopenLiveTranscript
        ? t("transcriptionPreview.label")
        : t("app.mic.clickToSpeak");
  const getAudioLevel = useCallback(() => audioLevelRef.current, []);

  const activatePill = () => {
    if (!pillInteractive) return;
    if (canReopenLiveTranscript) {
      liveTranscript.reopen();
      return;
    }
    void window.electronAPI.toggleAgentPanelDictation?.();
  };

  return (
    <main className="agent-dictation-pill-window dictation-window">
      <div
        className={`voice-pill-position voice-pill-position-${voicePillDock} fixed z-50`}
        style={
          {
            "--voice-pill-travel-duration": `${voicePillTravelDuration}ms`,
          } as CSSProperties
        }
        onMouseEnter={() => {
          if (companionState.interactive) setHovered(true);
        }}
        onMouseLeave={() => setHovered(false)}
      >
        <VoicePill
          variant={liveTranscript.open ? "panel" : "floating"}
          state={state}
          expanded={!liveTranscript.open && expanded}
          collapseToLogo={listeningEntrance.collapseToLogo}
          waveformVisible={listeningEntrance.waveformVisible}
          waveformOnlyWhileRecording={liveTranscript.mounted}
          integratedWithPanel={liveTranscript.open}
          showExpandChevron={canReopenLiveTranscript && hovered}
          getAudioLevel={getAudioLevel}
          horizontalDirection={horizontalDirection}
          role={pillInteractive ? "button" : "status"}
          aria-label={label}
          aria-disabled={!pillInteractive}
          onClick={activatePill}
        />
      </div>

      <VoiceModePanelCore
        mode={liveTranscript.mounted ? "live-transcript" : null}
        open={liveTranscript.open}
        stage={liveTranscriptEntrance.coreStage as VoiceModePanelStage}
        horizontalDirection={horizontalDirection}
        label={t("transcriptionPreview.label")}
        measurementRevision={liveTranscript.measurementText}
        onPreferredHeightChange={liveTranscript.requestHeight}
      >
        {liveTranscript.mounted && (
          <LiveTranscriptPanel
            text={liveTranscript.text}
            measurementText={liveTranscript.measurementText}
            phase={liveTranscript.phase as LiveTranscriptPhase}
            processing={isProcessing}
            controlsVisible={liveTranscriptEntrance.controlsVisible}
            contentVisible={liveTranscriptEntrance.contentVisible}
            onCollapse={() => liveTranscript.close({ suppress: true })}
            onHoldChange={liveTranscript.holdFinal}
          />
        )}
      </VoiceModePanelCore>
    </main>
  );
}
