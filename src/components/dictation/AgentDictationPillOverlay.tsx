import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { useListeningEntrancePhase } from "../../hooks/useListeningEntrancePhase";
import { useLiveTranscriptPanel } from "../../hooks/useLiveTranscriptPanel";
import {
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  VOICE_PILL_FOOTPRINT,
  resolveCompanionPillInteractive,
  resolveListeningEntrancePresentation,
  resolveLiveTranscriptEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoicePillDock,
  resolveVoicePillInteraction,
  shouldOfferLiveTranscriptReopen,
} from "../../helpers/voicePillPresentation";
import { LiquidCancelButton } from "./LiquidCancelButton";
import { LiveTranscriptPanel, type LiveTranscriptPhase } from "./LiveTranscriptPanel";
import { VoiceModePanelCore, type VoiceModePanelStage } from "./VoiceModePanelCore";
import { VoicePill, type VoicePillState } from "./VoicePill";
import "../../styles/agent-dictation-pill.css";

type DictationLifecycle = "idle" | "preparing" | "recording" | "processing";
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

  // hideAgentDictationPill force-resets native click-through, but a hidden
  // window never fires mouseleave, so React's hovered flag would survive the
  // hide and desync the interactivity effect on the next show (first click
  // falls through). Electron marks hidden windows document.hidden.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") setHovered(false);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const resizeToContent = useCallback(
    (height: number) =>
      window.electronAPI.resizeAgentDictationPillToContent?.(height) ??
      Promise.resolve(UNAVAILABLE_RESIZE),
    []
  );
  const isRecording = companionState.lifecycle === "recording";
  const isProcessing = companionState.lifecycle === "processing";
  const isPreparing = companionState.lifecycle === "preparing";
  const liveTranscript = useLiveTranscriptPanel({
    resizeToContent,
    assistantOpenRef,
    onWillOpen: undefined,
    isRecording,
    isProcessing,
    isAssistantVoice: false,
  });
  const { close: closeLiveTranscript, mounted: liveTranscriptMounted } = liveTranscript;

  const { showFinalText } = liveTranscript;
  useEffect(
    () =>
      window.electronAPI.onAgentDictationPillFinalTranscript?.((text) => {
        showFinalText(text);
      }),
    [showFinalText]
  );

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

  // The window is click-through (macOS) until something needs real clicks:
  // the hovered pill, or the Live Transcript surface with its controls.
  const captureMouseEvents = hovered || liveTranscriptMounted;
  useEffect(() => {
    void window.electronAPI.setAgentDictationPillInteractivity?.(captureMouseEvents);
  }, [captureMouseEvents]);

  const listeningEntrancePhase = useListeningEntrancePhase(isRecording);
  useLayoutEffect(() => {
    if (!isRecording) audioLevelRef.current = null;
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
    (isPreparing
      ? "processing"
      : hovered && companionState.interactive
        ? "hover"
        : "idle")) as VoicePillState;
  const expanded = isRecording ? listeningEntrance.compactPill : voiceActivity.compactPill;
  // Same liquid cancel as the main pill (App.jsx): footprint targets for the
  // skin's geometry tween, and the pill goes headless while the skin owns the
  // fused surface.
  const [cancelSkinActive, setCancelSkinActive] = useState(false);
  const cancelPillFootprint = expanded ? VOICE_PILL_FOOTPRINT.recording : VOICE_PILL_FOOTPRINT.idle;
  // The shared rule (a mounted transcript locks the pill except while
  // recording) comes from the tested helper; the companion additionally
  // requires main-process consent and no transcript still processing.
  const { pillInteractive: surfaceInteractive, cancelVisible } = resolveVoicePillInteraction({
    assistantMounted: false,
    liveTranscriptMounted: liveTranscript.mounted,
    isRecording,
    isProcessing,
    isHovered: hovered,
  });
  const pillInteractive = resolveCompanionPillInteractive({
    mainProcessInteractive: companionState.interactive,
    surfaceInteractive,
    isProcessing,
    canReopenLiveTranscript,
  });
  const label = isRecording
    ? t("app.mic.recording")
    : isProcessing || isPreparing
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
        <div className="relative flex items-center">
          <VoicePill
            variant={liveTranscript.open ? "panel" : "floating"}
            state={state}
            expanded={!liveTranscript.open && expanded}
            collapseToLogo={listeningEntrance.collapseToLogo}
            waveformVisible={listeningEntrance.waveformVisible}
            waveformOnlyWhileRecording={liveTranscript.mounted}
            integratedWithPanel={liveTranscript.open}
            liquidFused={cancelSkinActive}
            showExpandChevron={canReopenLiveTranscript && hovered}
            getAudioLevel={getAudioLevel}
            horizontalDirection={horizontalDirection}
            role={pillInteractive ? "button" : "status"}
            aria-label={label}
            aria-disabled={!pillInteractive}
            onClick={activatePill}
          />
          <LiquidCancelButton
            visible={cancelVisible}
            fused={!liveTranscript.open}
            pillWidth={cancelPillFootprint.width}
            pillHeight={cancelPillFootprint.height}
            pillState={state}
            ariaLabel={
              isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
            }
            onCancel={() => {
              void window.electronAPI.cancelAgentPanelDictation?.();
            }}
            onFusedSkinChange={setCancelSkinActive}
          />
        </div>
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
