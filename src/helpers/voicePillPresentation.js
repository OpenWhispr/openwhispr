import { LIVE_TRANSCRIPT_SURFACE_LIMITS } from "./voiceSurfaceGeometry.mjs";
import { MOTION_TIMING } from "../utils/springEasing";
import { waitForTransitionEnd, settleFallbackMs } from "../utils/transitionSettled";

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
  // The morph spring, played over its pinned duration (Task 1's MOTION_TIMING) —
  // imported, not re-hardcoded, so a change there can't silently stop reaching
  // the pill.
  expansionMs: MOTION_TIMING.listeningExpansionMs,
  // Hold the finished footprint briefly so the waveform reveal cannot be
  // perceived as part of the width animation.
  waveformDelayMs: 100,
});

/**
 * What a shrinking pill window should wait for before the native window
 * snaps down. Only the pill's own compact-to-idle narrow (RECORDING ->
 * BASE) has a width transition worth observing — every other shrink (a
 * menu or toast closing, the hands-free tip retiring) leaves the pill's own
 * footprint untouched, so there is nothing here to wait for and it resolves
 * at once. Reduced motion strips `width` from the pill's transition-property
 * outright (src/index.css's blanket rule), so even the pill's own narrow has
 * no real transitionend to wait for there either — waiting anyway would just
 * park the window at the old size for the whole fallback window, for
 * nothing.
 */
export function resolvePillShrinkWait({ target, prev, prefersReducedMotion, el }) {
  if (prev !== "RECORDING" || target !== "BASE") return Promise.resolve();
  if (prefersReducedMotion) return Promise.resolve("reduced-motion");
  return waitForTransitionEnd(el, "width", settleFallbackMs(LISTENING_ENTRANCE_TIMING.expansionMs));
}

/**
 * Whether the pill's exit must wait for its "zoop" (the transform collapse in
 * `.assistant-pill-presence[data-pill-exit="zoop"]`) before the native window
 * hides. Two states have no transform transition to wait for at all, and
 * waiting anyway would park the window on screen for the whole fallback
 * window instead of choreographing anything:
 *
 * - Reduced motion. src/index.css's blanket `*, *::before, *::after` rule
 *   sets `transition-property` with `!important` to a list that EXCLUDES
 *   transform, so the transform transitionend this waits on can structurally
 *   never fire — the same shape resolvePillShrinkWait above short-circuits
 *   for `width`. The pose still applies (instantly), so the window hides on
 *   exactly the hard cut reduced motion asks for.
 * - The pill is already collapsed (a repeat hide against a window that is
 *   already gone): re-applying a pose the element already holds starts no
 *   transition, so nothing would ever settle.
 */
export function shouldAwaitPillZoop({ prefersReducedMotion, alreadyExited }) {
  return !prefersReducedMotion && !alreadyExited;
}

/**
 * Whether the window-size ladder still needs to reserve HANDS_FREE_TIP room.
 * Tracks the Hold migration card through its whole MOUNTED lifetime (visible
 * OR exiting), not its `visible` sub-state alone: resolvePillShrinkWait
 * above correctly resolves a HANDS_FREE_TIP -> BASE shrink at once (the
 * pill's own width is not part of that transition), so this flag going
 * false the instant the card starts exiting — instead of when it actually
 * unmounts, 200ms later — would let the window shrink out from under the
 * still-fading card (`.hands-free-tip-card[data-exiting="true"]`,
 * dictation-panel.css) instead of waiting for it to finish. The hands-free
 * tip card itself has no such `exiting` sub-state (its own `tip` stays
 * non-null through its own fade), so widening only ever changes the
 * migration card's half of this decision.
 */
export function resolveHandsFreeTipLadderVisible({
  tip,
  holdMigrationCardVisible,
  holdMigrationCardExiting,
}) {
  return tip !== null || holdMigrationCardVisible || holdMigrationCardExiting;
}

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

/**
 * How long the persistent pill takes to glide to its next dock, and on what
 * easing. The Assistant panel's shell springs open on the pinned morph spring
 * (see .expanding-panel-surface in dictation-panel.css); the pill's travel
 * plays the SAME spring so it arrives at the footer dock as the shell
 * finishes opening, instead of the two motions disagreeing. Live Transcript's
 * entrance is out of scope here and keeps its own established timings and the
 * transition's default CSS easing (no override).
 */
export function resolveVoicePillTravelPresentation({
  assistantMounted,
  liveTranscriptOpen,
  liveTranscriptEntrancePhase,
}) {
  if (assistantMounted) {
    return { durationMs: MOTION_TIMING.morphMs, ease: "var(--motion-morph-ease)" };
  }
  return {
    durationMs:
      liveTranscriptOpen && liveTranscriptEntrancePhase === "encapsulate"
        ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
        : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs,
    ease: undefined,
  };
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
 * Keep Agent identity for the complete request lifecycle and the open panel,
 * end it at close intent so the colour fades inside the close spring, and
 * hold it through an auto-hide exit when asked (the mark leaves with the
 * pill; the leaf→ring morph runs while the window is hidden). Never let the
 * audio manager's last routing flag brand a later idle dictation pill.
 */
export function resolveAgentModeActive({
  isAssistantVoice,
  isRecording,
  isProcessing,
  assistantPanelMounted,
  assistantPanelClosing = false,
  heldThroughHide = false,
}) {
  return Boolean(
    (isAssistantVoice && (isRecording || isProcessing)) ||
    (assistantPanelMounted && !assistantPanelClosing) ||
    heldThroughHide
  );
}

/**
 * Whether closing the Agent panel should hold its mark through the pill's
 * exit (the `heldThroughHide` input above). Only an auto-hide exit needs it:
 * the window is on its way out, and the leaf→ring morph would otherwise
 * finish just before the pill vanishes, so the last thing a user who had
 * just talked to the Agent sees is the pill turning into the dictation logo.
 * With auto-hide off the pill stays on screen and that morph is a wanted,
 * visible return to the dictation identity.
 */
export function shouldHoldAgentMarkThroughHide({ floatingIconAutoHide, assistantPanelMounted }) {
  return Boolean(floatingIconAutoHide && assistantPanelMounted);
}

/**
 * Whether a held Agent mark must be released while the pill is still on
 * screen. The hold only exists to carry the leaf out of view, so anything
 * that keeps the pill there has to drop it: a new recording, which owns the
 * identity itself (a dictation wears the ring; an Agent command re-earns the
 * leaf through isAssistantVoice), and auto-hide being switched off, which
 * cancels the exit the hold was staged for. The third release — the
 * hideWindow IPC settling — is not derived state and lives at that call site.
 */
export function shouldReleaseAgentMarkHold({ isRecording, isPreparing, floatingIconAutoHide }) {
  return Boolean(isRecording || isPreparing || !floatingIconAutoHide);
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
