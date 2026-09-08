import { useEffect, useRef, type CSSProperties, type ReactNode, type TransitionEvent } from "react";
import {
  ASSISTANT_CLOSE_TIMING,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  LIVE_TRANSCRIPT_SURFACE_LIMITS,
} from "../../helpers/voicePillPresentation";
import { ExpandingPanelShell } from "./ExpandingPanelShell";

export type VoiceModePanel = "assistant" | "live-transcript";
export type VoiceModePanelStage = "encapsulated" | "footer" | "content";

interface VoiceModePanelCoreProps {
  mode: VoiceModePanel | null;
  open: boolean;
  closing?: boolean;
  stage?: VoiceModePanelStage;
  // Live Transcript's raw entrance phase (useLiveTranscriptPanel's
  // entrancePhase, e.g. "encapsulate" | "idle" | ...), passed through
  // untouched — NOT the derived coreStage `stage` above, which normalises
  // "idle" (closing) and "encapsulate" (freshly mounted, not yet open) to
  // the SAME "encapsulated" value. Only the raw phase can tell those two
  // apart, which is what gates the fresh-mount snap in dictation-panel.css
  // without also silencing the closing animation.
  entrancePhase?: string | null;
  // True only when THIS open is a genuine rest -> mounted transition (see
  // useLiveTranscriptPanel's freshMount). Reopening while still mounted
  // (mid-collapse, inside close()'s unmount delay) also passes through
  // entrancePhase="encapsulate", so entrancePhase alone cannot tell a real
  // fresh mount apart from that case — freshMount is the second, required
  // signal the snap-gate needs so a mid-collapse reopen reverses smoothly
  // instead of popping (fix round 2, Finding B, review 2026-09-08).
  freshMount?: boolean;
  horizontalDirection?: "left" | "right";
  label?: string;
  measurementRevision?: string | number | null;
  onClosingFadeComplete?: () => void;
  // Fired once when the shell's own clip-path transition ends while
  // closing && !open && mode === "assistant" — the morph that carries the
  // shell down to the pill's circle has genuinely finished, distinct from
  // onClosingFadeComplete above (the CHILDREN's opacity fade, which reports
  // much earlier in the same close sequence).
  onCollapsed?: () => void;
  // Fired on the shell's own clip-path transitionend while
  // mode === "live-transcript" && open, naming the stage that has just
  // finished settling. Only the two GATED stages report: "encapsulated" and
  // "footer" are each followed by another beat of the entrance, so each one
  // is something to wait for; "content" is the last stage and gates nothing.
  // Distinct from onCollapsed above, which reads the same property on the
  // same element for the assistant's CLOSE — mode and open/closing keep the
  // two apart.
  onStageSettled?: (stage: "encapsulated" | "footer") => void;
  onPreferredHeightChange: (
    height: number,
    measurementRevision?: string | number | null
  ) => void | Promise<unknown>;
  children?: ReactNode;
}

/**
 * One persistent animated surface for every expanded voice experience. Modes
 * provide only their inner sections so switching content never replaces the
 * geometry, height observer, or pill-to-panel transition owner.
 */
export function VoiceModePanelCore({
  mode,
  open,
  closing = false,
  stage = "content",
  entrancePhase = null,
  freshMount = false,
  horizontalDirection = "right",
  label,
  measurementRevision = null,
  onClosingFadeComplete,
  onCollapsed,
  onStageSettled,
  onPreferredHeightChange,
  children,
}: VoiceModePanelCoreProps) {
  const isLiveTranscript = mode === "live-transcript";
  // Keep one origin for the complete lifecycle. Swapping transform origins
  // once content appears makes the closing motion disagree with the entrance.
  const anchor = horizontalDirection === "left" ? "bottom-left" : "bottom-right";
  const closingFadeReportedRef = useRef(false);

  useEffect(() => {
    closingFadeReportedRef.current = false;
    if (!closing || mode !== "assistant" || !onClosingFadeComplete) return undefined;

    // A transition event is the primary signal. The fallback only covers a
    // renderer teardown or a child with no computed opacity delta — NOT
    // reduced motion, which keeps opacity in transition-property and so still
    // fires the real event. It is derived from the fade it is a net for
    // (ASSISTANT_CLOSE_TIMING.reportMs = the fade plus one grace window), so
    // it can never drift from the CSS, and useAssistantPanel's own guarantee
    // sits one further grace window past it (Finding 2, final review
    // 2026-09-08).
    const fallback = window.setTimeout(() => {
      if (closingFadeReportedRef.current) return;
      closingFadeReportedRef.current = true;
      onClosingFadeComplete();
    }, ASSISTANT_CLOSE_TIMING.reportMs);
    return () => window.clearTimeout(fallback);
  }, [closing, mode, onClosingFadeComplete]);

  const handleTransitionEndCapture = (event: TransitionEvent<HTMLElement>) => {
    if (
      mode === "live-transcript" &&
      open &&
      event.propertyName === "clip-path" &&
      event.target === event.currentTarget &&
      (stage === "encapsulated" || stage === "footer")
    ) {
      onStageSettled?.(stage);
      return;
    }

    if (
      closing &&
      !open &&
      mode === "assistant" &&
      event.propertyName === "clip-path" &&
      event.target === event.currentTarget
    ) {
      onCollapsed?.();
      return;
    }

    if (
      !closing ||
      mode !== "assistant" ||
      event.propertyName !== "opacity" ||
      event.target === event.currentTarget ||
      (event.target as HTMLElement).parentElement !== event.currentTarget ||
      closingFadeReportedRef.current
    ) {
      return;
    }
    closingFadeReportedRef.current = true;
    onClosingFadeComplete?.();
  };

  return (
    <ExpandingPanelShell
      open={open && mode !== null}
      anchor={anchor}
      className={isLiveTranscript ? "live-transcript-panel" : undefined}
      stabilizeHeight={isLiveTranscript && open}
      fillAvailableHeight={mode === "assistant"}
      preferredHeightCap={isLiveTranscript ? LIVE_TRANSCRIPT_SURFACE_LIMITS.maxHeight : undefined}
      measurementKey={mode}
      measurementRevision={isLiveTranscript ? measurementRevision : null}
      onPreferredHeightChange={isLiveTranscript ? onPreferredHeightChange : undefined}
      onTransitionEndCapture={handleTransitionEndCapture}
      aria-label={label}
      data-panel-mode={mode ?? undefined}
      data-panel-closing={closing ? "true" : undefined}
      data-panel-stage={isLiveTranscript ? stage : "content"}
      data-panel-entrance-phase={isLiveTranscript ? (entrancePhase ?? undefined) : undefined}
      data-panel-fresh-mount={isLiveTranscript && freshMount ? "true" : undefined}
      data-panel-direction={horizontalDirection}
      style={
        {
          "--live-transcript-horizontal-duration": `${LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs}ms`,
          "--live-transcript-encapsulation-duration": `${LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs}ms`,
        } as CSSProperties
      }
    >
      {children}
    </ExpandingPanelShell>
  );
}
