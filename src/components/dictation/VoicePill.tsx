import { forwardRef, type HTMLAttributes } from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "../lib/utils";
import { PillWaveform } from "./PillWaveform";
import { VoiceIdentityIcon } from "./VoiceIdentityIcon";
import { RESTING_WAVE_SILHOUETTE, WAVEFORM_BAR_COUNT } from "./waveformMath";
import {
  LISTENING_ENTRANCE_TIMING,
  VOICE_PILL_FOOTPRINT,
} from "../../helpers/voicePillPresentation";

export type VoicePillState =
  "idle" | "hover" | "recording" | "processing" | "thinking" | "unavailable";

interface VoicePillProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  variant: "floating" | "panel";
  state: VoicePillState;
  getAudioLevel: () => number | null;
  expanded?: boolean;
  collapseToLogo?: boolean;
  waveformVisible?: boolean;
  waveformOnlyWhileRecording?: boolean;
  integratedWithPanel?: boolean;
  agentMode?: boolean;
  showExpandChevron?: boolean;
  isDragging?: boolean;
  horizontalDirection?: "left" | "right";
}

const GROW_TRANSITION = `${LISTENING_ENTRANCE_TIMING.expansionMs}ms cubic-bezier(0.2, 0, 0, 1)`;
// Sized from WAVEFORM_BAR_COUNT so a bar-count change can never silently
// desync the resting silhouette from the live waveform's footprint.
const RESTING_WAVE_HEIGHTS = Array.from(
  { length: WAVEFORM_BAR_COUNT },
  (_, index) => RESTING_WAVE_SILHOUETTE[index % RESTING_WAVE_SILHOUETTE.length]
);

const STATE_APPEARANCE: Record<VoicePillState, string> = {
  idle: "border-border-hover bg-surface-1 text-muted-foreground dark:border-border/50",
  hover: "border-border-hover bg-surface-3 text-foreground",
  recording: "border-border-hover bg-surface-1 text-foreground",
  processing: "border-border/60 bg-surface-1 text-foreground/70",
  thinking: "border-border/60 bg-surface-1 text-foreground",
  unavailable: "border-border/60 bg-surface-1 text-muted-foreground",
};

/** One persistent control that resizes between the floating and panel layouts. */
export const VoicePill = forwardRef<HTMLDivElement, VoicePillProps>(function VoicePill(
  {
    variant,
    state,
    getAudioLevel,
    expanded = false,
    collapseToLogo = false,
    waveformVisible = true,
    waveformOnlyWhileRecording = false,
    integratedWithPanel = false,
    agentMode = false,
    showExpandChevron = false,
    isDragging = false,
    horizontalDirection = "right",
    className,
    style,
    ...props
  },
  ref
) {
  const isRecording = state === "recording";
  const isProcessing = state === "processing";
  const isThinking = state === "thinking";
  const isUnavailable = state === "unavailable";
  // One Signal glow (comet orbit over a breathing halo) serves both
  // identities; only the palette differs. It lights for the real thinking
  // state alone — glowing during the entrance or while listening would read
  // as work already in flight before any transcript exists.
  const showSignalGlow = !isUnavailable && isThinking;
  const isPanel = variant === "panel";
  const collapseToIdentity = collapseToLogo || isThinking;
  const showCompactPill =
    !collapseToIdentity && (isRecording || expanded || (isPanel && !waveformOnlyWhileRecording));
  const showDivider = showCompactPill && waveformVisible && !isRecording;
  const dividerMargin = showCompactPill ? (showDivider ? 4 : 3) : 0;
  const identitySize = 22;
  const floatingHover = !isPanel && state === "hover";
  const footprint = showCompactPill ? VOICE_PILL_FOOTPRINT.recording : VOICE_PILL_FOOTPRINT.idle;

  const pill = (
    <div
      ref={ref}
      className={cn(
        "voice-pill-control relative flex items-center justify-center overflow-hidden rounded-full border",
        showCompactPill && "pr-1",
        "shadow-[var(--shadow-card)]",
        STATE_APPEARANCE[state],
        className
      )}
      style={{
        // Listening uses the same compact pill as the assistant panel. The
        // previous wide recording bar made the control feel like a different
        // surface and forced an unnecessary large window resize.
        width: footprint.width,
        height: footprint.height,
        cursor: isProcessing || isThinking ? "not-allowed" : isDragging ? "grabbing" : "pointer",
        boxShadow: floatingHover ? "var(--shadow-card-hover-subtle)" : undefined,
        transition: `width ${GROW_TRANSITION}, height ${GROW_TRANSITION}, padding-left ${GROW_TRANSITION}, padding-right ${GROW_TRANSITION}, background-color 220ms ease-out, border-color 220ms ease-out, box-shadow 220ms ease-out`,
        ...style,
      }}
      data-horizontal-direction={horizontalDirection}
      data-integrated-with-panel={integratedWithPanel || undefined}
      data-agent-mode={agentMode || undefined}
      data-agent-beam-active={(agentMode && isThinking) || undefined}
      data-expand-chevron={showExpandChevron || undefined}
      {...props}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-foreground/10 to-transparent transition-opacity duration-200 ease-out"
        style={{ opacity: state === "hover" ? 0.72 : 0 }}
      />

      <span
        className="voice-pill-identity-slot relative inline-block shrink-0 transition-[width,height] duration-200"
        style={{ width: identitySize, height: identitySize }}
        aria-hidden="true"
      >
        <span
          className={cn(
            "voice-pill-identity-logo absolute inset-0 transition-[opacity,transform] duration-200 ease-out",
            showExpandChevron ? "translate-y-1 scale-75 opacity-0" : "scale-100 opacity-100"
          )}
        >
          <VoiceIdentityIcon
            size={identitySize}
            agentMode={agentMode}
            className={cn(
              "transition-[width,height] duration-200",
              state === "idle" && "text-foreground",
              (isUnavailable || isProcessing) && "animate-pulse"
            )}
          />
        </span>
        <ChevronUp
          className={cn(
            "voice-pill-expand-chevron absolute inset-0 m-auto size-5 transition-[opacity,transform] duration-200 ease-out",
            showExpandChevron ? "scale-100 opacity-100" : "translate-y-1 scale-75 opacity-0"
          )}
          strokeWidth={2}
        />
      </span>

      <div
        className="shrink-0 overflow-hidden bg-border/60"
        style={{
          height: showCompactPill ? 16 : 20,
          width: showDivider ? 1 : 0,
          marginLeft: dividerMargin,
          marginRight: dividerMargin,
          opacity: showDivider ? 1 : 0,
          transition: `width ${GROW_TRANSITION}, margin ${GROW_TRANSITION}, opacity 180ms ease-out`,
        }}
      />

      <div
        className="voice-pill-waveform relative shrink-0 overflow-hidden text-foreground"
        style={{
          width: showCompactPill ? 52 : 0,
          height: showCompactPill ? 24 : 32,
          transition: `width ${GROW_TRANSITION}, height ${GROW_TRANSITION}`,
        }}
      >
        <div
          className="absolute inset-0 flex items-center justify-center gap-0.75 transition-opacity duration-200 ease-out"
          style={{ opacity: showCompactPill && waveformVisible && !isRecording ? 1 : 0 }}
          aria-hidden="true"
        >
          {RESTING_WAVE_HEIGHTS.map((height, index) => (
            <span
              key={`${height}-${index}`}
              className="w-0.5 rounded-full bg-current"
              style={{ height }}
            />
          ))}
        </div>
        <PillWaveform
          getLevel={getAudioLevel}
          active={isRecording}
          className={cn(
            "absolute inset-0 transition-opacity duration-200 ease-out",
            showCompactPill && waveformVisible && isRecording ? "opacity-100" : "opacity-0"
          )}
        />
      </div>

      {isUnavailable && (
        <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-foreground/30 animate-pulse" />
      )}
    </div>
  );

  return (
    <span className="voice-pill-glow-anchor">
      <span
        aria-hidden="true"
        className="processing-signal-glow"
        data-active={showSignalGlow ? "true" : undefined}
        data-agent={agentMode || undefined}
      >
        <span className="processing-signal-ring" />
      </span>
      {pill}
    </span>
  );
});
