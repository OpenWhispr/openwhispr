import { LIVE_TRANSCRIPT_SURFACE_LIMITS } from "./voiceSurfaceGeometry.mjs";

export { LIVE_TRANSCRIPT_SURFACE_LIMITS };

// The pill's two rendered footprints (px). This is a real cross-process
// contract: WINDOW_SIZES.RECORDING in src/helpers/windowConfig.js sizes the
// native overlay window around the compact recording pill, so these values
// and that window size may only change together.
export const VOICE_PILL_FOOTPRINT = Object.freeze({
  idle: Object.freeze({ width: 40, height: 40 }),
  recording: Object.freeze({ width: 92, height: 36 }),
});

export const LISTENING_ENTRANCE_TIMING = Object.freeze({
  // Give the Beam enough time to read as an intentional thinking state before
  // the persistent control begins changing shape.
  thinkingMs: 420,
  expansionMs: 300,
  // Hold the finished footprint briefly so the waveform reveal cannot be
  // perceived as part of the width animation.
  waveformDelayMs: 100,
});

export const ASSISTANT_FOOTER_TRANSITION_TIMING = Object.freeze({
  pillRetreatMs: 180,
  actionsRetreatMs: 220,
  pillEntranceMs: 180,
  actionsEntranceMs: 220,
});

export function getAssistantFooterTransitionTimeline(
  responseReady,
  timing = ASSISTANT_FOOTER_TRANSITION_TIMING
) {
  if (responseReady) {
    return {
      initialPhase: "pill-exiting",
      handoffPhase: "actions-entering",
      settledPhase: "actions",
      handoffAtMs: timing.pillRetreatMs,
      settledAtMs: timing.pillRetreatMs + timing.actionsEntranceMs,
    };
  }

  return {
    initialPhase: "actions-exiting",
    handoffPhase: "pill-entering",
    settledPhase: "pill",
    handoffAtMs: timing.actionsRetreatMs,
    settledAtMs: timing.actionsRetreatMs + timing.pillEntranceMs,
  };
}

export function resolveAssistantFooterPresentation(phase) {
  return {
    pillVisible: phase === "pill" || phase === "pill-entering" || phase === "pill-exiting",
    actionsMounted:
      phase === "actions" || phase === "actions-entering" || phase === "actions-exiting",
    collapsePillToLogo: phase === "pill-exiting",
  };
}

export function resolveAssistantResponseReady({
  responseContent,
  isBusy,
  isStreaming,
  voiceState,
  requestPending,
}) {
  return Boolean(
    responseContent && !isBusy && !isStreaming && voiceState === "idle" && !requestPending
  );
}

export const LIVE_TRANSCRIPT_ENTRANCE_TIMING = Object.freeze({
  encapsulateMs: 180,
  encapsulateHoldMs: 140,
  horizontalMs: 320,
  controlsDelayMs: 70,
  controlsRevealMs: 200,
  contentDelayMs: 110,
  measurementSettleMs: 220,
  panelExpansionMs: 320,
  contentRevealDelayMs: 80,
  contentSettleMs: 280,
});

export function getLiveTranscriptEntranceTimeline(timing = LIVE_TRANSCRIPT_ENTRANCE_TIMING) {
  const horizontalAtMs = timing.encapsulateMs + timing.encapsulateHoldMs;
  const controlsAtMs = horizontalAtMs + timing.horizontalMs + timing.controlsDelayMs;
  const prepareAtMs = controlsAtMs + timing.controlsRevealMs + timing.contentDelayMs;
  const panelAtMs = prepareAtMs + timing.measurementSettleMs;
  const contentAtMs = panelAtMs + timing.panelExpansionMs + timing.contentRevealDelayMs;
  return {
    horizontalAtMs,
    controlsAtMs,
    prepareAtMs,
    panelAtMs,
    contentAtMs,
    streamAtMs: contentAtMs + timing.contentSettleMs,
  };
}

export function resolveLiveTranscriptEntrancePresentation(phase) {
  const effectivePhase = phase === "idle" ? "encapsulate" : phase;
  const encapsulating = effectivePhase === "encapsulate";
  const panelExpanded = effectivePhase === "panel" || effectivePhase === "content";
  const controlsVisible =
    effectivePhase === "controls" ||
    effectivePhase === "prepare" ||
    effectivePhase === "panel" ||
    effectivePhase === "content";
  const contentVisible = effectivePhase === "content";

  return {
    coreStage: encapsulating ? "encapsulated" : panelExpanded ? "content" : "footer",
    controlsVisible,
    contentVisible,
  };
}

/**
 * Expanded voice modes only animate horizontally from the two supported edge
 * docks. Keep center on the established right-origin choreography until a
 * dedicated centered transition is designed.
 */
export function resolveVoiceHorizontalDirection(panelStartPosition) {
  return panelStartPosition === "bottom-left" ? "left" : "right";
}

export function resolveVoicePillDock({
  liveTranscriptOpen,
  liveTranscriptEntrancePhase,
  assistantOpen,
  panelStartPosition,
  horizontalDirection = resolveVoiceHorizontalDirection(panelStartPosition),
}) {
  if (liveTranscriptOpen) {
    if (liveTranscriptEntrancePhase === "encapsulate") {
      return `live-transcript-encapsulated-bottom-${horizontalDirection}`;
    }

    // The established right-origin flow carries the pill to the left side as
    // the footer grows leftward. A left-origin flow already occupies that
    // anchor, so keep it fixed while the footer grows rightward around it.
    return "live-transcript-bottom-left";
  }
  if (assistantOpen) return `assistant-bottom-${horizontalDirection}`;
  if (panelStartPosition === "center") return "center";
  return `bottom-${horizontalDirection}`;
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
      collapseToLogo: true,
      compactPill: false,
      waveformVisible: false,
    };
  }

  if (effectivePhase === "expanding" || effectivePhase === "settled") {
    // Both phases render identically on purpose: "settled" exists only as a
    // timing beat that holds the finished footprint before the waveform
    // reveal, so the presentation must not change between them.
    return {
      activeState: "recording",
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
 * Keep Agent identity for the complete request/panel lifecycle, but do not let
 * the audio manager's last routing flag brand a later idle dictation pill.
 */
export function resolveAgentModeActive({
  isAssistantVoice,
  isRecording,
  isProcessing,
  assistantPanelMounted,
}) {
  return Boolean((isAssistantVoice && (isRecording || isProcessing)) || assistantPanelMounted);
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
 * A collapsed Live Transcript can be reopened only while its owning dictation
 * is still recording or finalizing. Completed and Agent sessions must return
 * the pill to its normal identity instead of inheriting a stale chevron.
 */
export function shouldOfferLiveTranscriptReopen({
  manuallyCollapsed,
  isRecording,
  isProcessing,
  isAssistantVoice,
}) {
  return Boolean(
    manuallyCollapsed && !isAssistantVoice && (Boolean(isRecording) || Boolean(isProcessing))
  );
}

/**
 * Keeps the shared pill's action semantics scoped to the surface that owns it.
 * Live Transcript may stop an active recording through the pill and always
 * exposes a distinct discard action while recording or processing.
 */
export function resolveVoicePillInteraction({
  assistantMounted,
  liveTranscriptMounted,
  isRecording,
  isProcessing,
  isHovered = false,
}) {
  if (assistantMounted) {
    return { pillInteractive: false, cancelVisible: false };
  }

  const active = Boolean(isRecording) || Boolean(isProcessing);
  return {
    pillInteractive: !liveTranscriptMounted || Boolean(isRecording),
    // Live Transcript always shows its discard control; the bare pill shows
    // it on hover so a stalled processing step can still be cancelled.
    cancelVisible: active && (Boolean(liveTranscriptMounted) || Boolean(isHovered)),
  };
}

// The companion pill defers to the main process's interactivity verdict and
// keeps toggle clicks away from a transcript still processing — except to
// reopen a manually collapsed transcript, which must stay reachable until the
// final text lands (activatePill routes the reopen before any toggle).
export function resolveCompanionPillInteractive({
  mainProcessInteractive,
  surfaceInteractive,
  isProcessing,
  canReopenLiveTranscript,
}) {
  if (!mainProcessInteractive || !surfaceInteractive) return false;
  if (!isProcessing) return true;
  return Boolean(canReopenLiveTranscript);
}

// Final Agent actions own the footer, so the pill node stays mounted but
// hidden until the panel finishes closing. Live activity handed back at close
// INTENT is the exception: the companion hides on that same tick, so keeping
// the pill hidden until the fade completes would leave a running recording
// with no visible owner at all.
export function shouldSuppressPillForAssistantActions({
  assistantOpen,
  footerPillVisible,
  assistantClosing,
  hasLiveActivity,
}) {
  if (!assistantOpen || footerPillVisible) return false;
  return !(assistantClosing && hasLiveActivity);
}

export function shouldActivateVoicePill({
  hasDragged,
  liveTranscriptMounted,
  isProcessing,
  isAgentThinking,
}) {
  return Boolean((!hasDragged || liveTranscriptMounted) && !isProcessing && !isAgentThinking);
}

export function isVoicePillActivationKey(key) {
  return key === "Enter" || key === " ";
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
