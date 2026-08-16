import type { CSSProperties, ReactNode } from "react";
import { LIVE_TRANSCRIPT_ENTRANCE_TIMING } from "../../helpers/voicePillPresentation";
import { ExpandingPanelShell } from "./ExpandingPanelShell";

export type VoiceModePanel = "assistant" | "live-transcript";
export type VoiceModePanelStage = "encapsulated" | "footer" | "content";

interface VoiceModePanelCoreProps {
  mode: VoiceModePanel | null;
  open: boolean;
  stage?: VoiceModePanelStage;
  label?: string;
  onPreferredHeightChange: (height: number) => void;
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
  stage = "content",
  label,
  onPreferredHeightChange,
  children,
}: VoiceModePanelCoreProps) {
  const isLiveTranscript = mode === "live-transcript";
  // The live footer first encapsulates the speaking pill at the right edge,
  // then grows leftward. Once that footprint exists, the full panel owns the
  // final bottom-left pill anchor without replacing the surface.
  const anchor = isLiveTranscript && stage === "content" ? "bottom-left" : "bottom-right";

  return (
    <ExpandingPanelShell
      open={open && mode !== null}
      anchor={anchor}
      className={isLiveTranscript ? "live-transcript-panel" : undefined}
      stabilizeHeight={open && mode !== null}
      onPreferredHeightChange={onPreferredHeightChange}
      aria-label={label}
      data-panel-mode={mode ?? undefined}
      data-panel-stage={isLiveTranscript ? stage : "content"}
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
