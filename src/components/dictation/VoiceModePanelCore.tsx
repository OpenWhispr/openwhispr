import { useEffect, useRef, type CSSProperties, type ReactNode, type TransitionEvent } from "react";
import {
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
  horizontalDirection?: "left" | "right";
  label?: string;
  measurementRevision?: string | number | null;
  onClosingFadeComplete?: () => void;
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
  horizontalDirection = "right",
  label,
  measurementRevision = null,
  onClosingFadeComplete,
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

    // A transition event is the primary signal. The fallback only covers
    // reduced-motion, a renderer teardown, or a child with no computed
    // opacity delta; it deliberately exceeds the real fade duration.
    const fallback = window.setTimeout(() => {
      if (closingFadeReportedRef.current) return;
      closingFadeReportedRef.current = true;
      onClosingFadeComplete();
    }, 220);
    return () => window.clearTimeout(fallback);
  }, [closing, mode, onClosingFadeComplete]);

  const handleTransitionEndCapture = (event: TransitionEvent<HTMLElement>) => {
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
