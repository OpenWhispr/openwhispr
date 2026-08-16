export const LISTENING_ENTRANCE_TIMING = Object.freeze({
  // Give the Beam enough time to read as an intentional thinking state before
  // the persistent control begins changing shape.
  thinkingMs: 420,
  expansionMs: 300,
  // Hold the finished footprint briefly so the waveform reveal cannot be
  // perceived as part of the width animation.
  waveformDelayMs: 100,
});

export const LIVE_TRANSCRIPT_ENTRANCE_TIMING = Object.freeze({
  encapsulateMs: 180,
  horizontalMs: 320,
  controlsDelayMs: 70,
  controlsRevealMs: 200,
  contentDelayMs: 110,
});

export function getLiveTranscriptEntranceTimeline(timing = LIVE_TRANSCRIPT_ENTRANCE_TIMING) {
  const horizontalAtMs = timing.encapsulateMs;
  const controlsAtMs = horizontalAtMs + timing.horizontalMs + timing.controlsDelayMs;
  return {
    horizontalAtMs,
    controlsAtMs,
    contentAtMs: controlsAtMs + timing.controlsRevealMs + timing.contentDelayMs,
  };
}

export function resolveLiveTranscriptEntrancePresentation(phase) {
  const effectivePhase = phase === "idle" ? "encapsulate" : phase;
  const encapsulating = effectivePhase === "encapsulate";
  const controlsVisible = effectivePhase === "controls" || effectivePhase === "content";
  const contentVisible = effectivePhase === "content";

  return {
    coreStage: encapsulating ? "encapsulated" : contentVisible ? "content" : "footer",
    controlsVisible,
    contentVisible,
  };
}

export function resolveVoicePillDock({
  liveTranscriptOpen,
  liveTranscriptEntrancePhase,
  assistantOpen,
  panelStartPosition,
}) {
  if (liveTranscriptOpen) {
    return liveTranscriptEntrancePhase === "encapsulate"
      ? "live-transcript-encapsulated"
      : "live-transcript";
  }
  if (assistantOpen) return "assistant";
  if (panelStartPosition === "bottom-left") return "bottom-left";
  if (panelStartPosition === "center") return "center";
  return "bottom-right";
}

export function getListeningEntranceTimeline(timing = LISTENING_ENTRANCE_TIMING) {
  const settleAtMs = timing.thinkingMs + timing.expansionMs;
  return {
    expandAtMs: timing.thinkingMs,
    settleAtMs,
    waveformAtMs: settleAtMs + timing.waveformDelayMs,
  };
}

/**
 * Stage a recording entrance without delaying microphone capture. `idle` is
 * treated as the first thinking frame so a recording edge cannot paint the
 * final expanded waveform before the layout effect starts the timers.
 */
export function resolveListeningEntrancePresentation({ isRecording, phase }) {
  if (!isRecording) {
    return {
      activeState: null,
      beamActive: null,
      collapseToLogo: false,
      compactPill: false,
      waveformVisible: true,
    };
  }

  const effectivePhase = phase === "idle" ? "thinking" : phase;
  if (effectivePhase === "thinking") {
    return {
      // Keep the actual recording state stable across every visual phase. The
      // waveform can sample audio while hidden and its reveal changes opacity
      // only; it never remounts or changes the pill's layout.
      activeState: "recording",
      beamActive: true,
      collapseToLogo: true,
      compactPill: false,
      waveformVisible: false,
    };
  }

  if (effectivePhase === "expanding") {
    return {
      activeState: "recording",
      beamActive: false,
      collapseToLogo: false,
      compactPill: true,
      waveformVisible: false,
    };
  }

  if (effectivePhase === "settled") {
    return {
      activeState: "recording",
      beamActive: false,
      collapseToLogo: false,
      compactPill: true,
      waveformVisible: false,
    };
  }

  return {
    activeState: "recording",
    beamActive: false,
    collapseToLogo: false,
    compactPill: true,
    waveformVisible: true,
  };
}

/**
 * Resolve only the active voice presentation. Idle/hover styling remains owned
 * by App because it also depends on pointer and microphone availability state.
 */
export function resolveVoiceActivityPresentation({
  isRecording,
  isProcessing,
  isAssistantVoice,
  assistantThinking,
}) {
  if (isRecording) {
    return { activeState: "recording", compactPill: true, isAgentThinking: false };
  }

  if (assistantThinking || (isAssistantVoice && isProcessing)) {
    return { activeState: "thinking", compactPill: false, isAgentThinking: true };
  }

  if (isProcessing) {
    return { activeState: "thinking", compactPill: false, isAgentThinking: false };
  }

  return { activeState: null, compactPill: false, isAgentThinking: false };
}

/**
 * Select the content hosted by the persistent expanded voice surface. An open
 * mode outranks a sibling that is only mounted to finish its exit animation,
 * which lets the same core hand off without flashing the stale mode.
 */
export function resolveVoicePanelCorePresentation({
  assistantOpen,
  assistantMounted,
  liveTranscriptOpen,
  liveTranscriptMounted,
}) {
  const mode = assistantOpen
    ? "assistant"
    : liveTranscriptOpen
      ? "live-transcript"
      : assistantMounted
        ? "assistant"
        : liveTranscriptMounted
          ? "live-transcript"
          : null;

  return {
    mode,
    open:
      mode === "assistant"
        ? Boolean(assistantOpen)
        : mode === "live-transcript"
          ? Boolean(liveTranscriptOpen)
          : false,
  };
}

/**
 * A fresh request thinks in the floating logo circle. A follow-up that starts
 * from an open response panel keeps that surface mounted so its footer pill
 * can own the thinking feedback without a close/reopen transition.
 */
export function resolveAssistantThinkingTransition(panelOpen) {
  return {
    panelOpen: Boolean(panelOpen),
    panelMounted: true,
    responseReady: false,
    thinking: true,
  };
}
