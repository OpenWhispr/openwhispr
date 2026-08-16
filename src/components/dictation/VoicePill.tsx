import { forwardRef, type HTMLAttributes } from "react";
import { BorderBeam } from "border-beam";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "./BrandMarkIcon";
import { LiveWaveform } from "./LiveWaveform";

export type VoicePillState =
  "idle" | "hover" | "recording" | "processing" | "thinking" | "unavailable";

interface VoicePillProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  variant: "floating" | "panel";
  state: VoicePillState;
  getAudioLevel: () => number | null;
  expanded?: boolean;
  waveformOnlyWhileRecording?: boolean;
  isDragging?: boolean;
}

const GROW_TRANSITION = "320ms cubic-bezier(0.2, 0, 0, 1)";
// Matches the reference's eleven-bar rhythm. The exact same silhouette and
// footprint is used in dictation, Agent Mode, and live transcript.
const RESTING_WAVE_HEIGHTS = [7, 11, 7, 7, 7, 16, 16, 7, 16, 11, 16];

const STATE_APPEARANCE: Record<VoicePillState, string> = {
  idle: "border-border/50 bg-surface-1 text-muted-foreground",
  hover: "border-border-hover bg-surface-2 text-foreground",
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
    waveformOnlyWhileRecording = false,
    isDragging = false,
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
  const isPanel = variant === "panel";
  const showCompactPill = isRecording || expanded || (isPanel && !waveformOnlyWhileRecording);
  const showDivider = showCompactPill && !isRecording;
  const dividerMargin = showCompactPill ? (isRecording ? 3 : 4) : 0;

  const pill = (
    <div
      ref={ref}
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-full border",
        "shadow-[var(--shadow-card)]",
        STATE_APPEARANCE[state],
        className
      )}
      style={{
        // Listening uses the same compact pill as the assistant panel. The
        // previous wide recording bar made the control feel like a different
        // surface and forced an unnecessary large window resize.
        width: isThinking && !isPanel ? 40 : showCompactPill ? 92 : 40,
        height: showCompactPill ? 36 : 40,
        cursor: isProcessing || isThinking ? "not-allowed" : isDragging ? "grabbing" : "pointer",
        transform: !isPanel && state === "hover" ? "scale(1.05)" : "scale(1)",
        transition: `width ${GROW_TRANSITION}, height ${GROW_TRANSITION}, transform 200ms cubic-bezier(0.2, 0, 0, 1), background-color 200ms ease-out`,
        ...style,
      }}
      {...props}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-foreground/10 to-transparent transition-opacity duration-150"
        style={{ opacity: state === "hover" ? 0.8 : 0 }}
      />

      <BrandMarkIcon
        size={isThinking && !isPanel ? 22 : showCompactPill ? 16 : state === "hover" ? 24 : 22}
        className={cn(
          "shrink-0 transition-[color,width,height] duration-200",
          (isUnavailable || isProcessing) && "animate-pulse"
        )}
      />

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
        className="shrink-0 overflow-hidden text-muted-foreground"
        style={{
          width: showCompactPill ? 52 : 0,
          height: showCompactPill ? 24 : 32,
          opacity: showCompactPill ? 1 : 0,
          transition: `width ${GROW_TRANSITION}, opacity 200ms ease-out 80ms`,
        }}
      >
        {showCompactPill && !isRecording ? (
          <div className="flex h-full items-center justify-center gap-0.75" aria-hidden="true">
            {RESTING_WAVE_HEIGHTS.map((height, index) => (
              <span
                key={`${height}-${index}`}
                className="w-0.5 rounded-full bg-current"
                style={{ height }}
              />
            ))}
          </div>
        ) : (
          <LiveWaveform
            getLevel={getAudioLevel}
            active={isRecording}
            className={isRecording ? "" : "opacity-60"}
          />
        )}
      </div>

      {isUnavailable && (
        <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-foreground/30 animate-pulse" />
      )}
    </div>
  );

  if (!isThinking) return pill;

  return (
    <BorderBeam
      size="sm"
      colorVariant="colorful"
      theme="auto"
      duration={1.6}
      brightness={1.3}
      strength={0.85}
      borderRadius={showCompactPill ? 18 : 20}
      className="agent-thinking-beam inline-flex rounded-full"
    >
      {pill}
    </BorderBeam>
  );
});
