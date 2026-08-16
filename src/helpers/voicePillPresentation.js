export const LISTENING_ENTRANCE_TIMING = Object.freeze({
  thinkingMs: 240,
  expansionMs: 320,
  waveformDelayMs: 80,
});

export function getListeningEntranceTimeline(timing = LISTENING_ENTRANCE_TIMING) {
  return {
    expandAtMs: timing.thinkingMs,
    waveformAtMs: timing.thinkingMs + timing.expansionMs + timing.waveformDelayMs,
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
      collapseToLogo: false,
      compactPill: false,
      waveformVisible: true,
    };
  }

  const effectivePhase = phase === "idle" ? "thinking" : phase;
  if (effectivePhase === "thinking") {
    return {
      activeState: "thinking",
      collapseToLogo: true,
      compactPill: false,
      waveformVisible: false,
    };
  }

  if (effectivePhase === "expanding") {
    return {
      activeState: "thinking",
      collapseToLogo: false,
      compactPill: true,
      waveformVisible: false,
    };
  }

  return {
    activeState: "recording",
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
