import type { CSSProperties, ReactNode } from "react";
import {
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  LIVE_TRANSCRIPT_SURFACE_LIMITS,
} from "../../helpers/voicePillPresentation";
import { ExpandingPanelShell } from "./ExpandingPanelShell";

export type VoiceModePanel = "live-transcript";
export type VoiceModePanelStage = "encapsulated" | "footer" | "content";

interface VoiceModePanelCoreProps {
  mode: VoiceModePanel | null;
  open: boolean;
  stage?: VoiceModePanelStage;
  horizontalDirection?: "left" | "right";
  label?: string;
  measurementRevision?: string | number | null;
  onPreferredHeightChange: (
    height: number,
    measurementRevision?: string | number | null
  ) => void | Promise<unknown>;
  children?: ReactNode;
}

/**
 * The persistent animated surface for the expanded voice experience (Live
 * Transcript). Its content provides only the inner sections, so it never
 * replaces the geometry, height observer, or pill-to-panel transition owner.
 */
export function VoiceModePanelCore({
  mode,
  open,
  stage = "content",
  horizontalDirection = "right",
  label,
  measurementRevision = null,
  onPreferredHeightChange,
  children,
}: VoiceModePanelCoreProps) {
  const isLiveTranscript = mode === "live-transcript";
  // Keep one origin for the complete lifecycle. Swapping transform origins
  // once content appears makes the closing motion disagree with the entrance.
  const anchor = horizontalDirection === "left" ? "bottom-left" : "bottom-right";
  return (
    <ExpandingPanelShell
      open={open && mode !== null}
      anchor={anchor}
      className={isLiveTranscript ? "live-transcript-panel" : undefined}
      stabilizeHeight={isLiveTranscript && open}
      preferredHeightCap={isLiveTranscript ? LIVE_TRANSCRIPT_SURFACE_LIMITS.maxHeight : undefined}
      measurementKey={mode}
      measurementRevision={isLiveTranscript ? measurementRevision : null}
      onPreferredHeightChange={isLiveTranscript ? onPreferredHeightChange : undefined}
      aria-label={label}
      data-panel-mode={mode ?? undefined}
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
