import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "./BrandMarkIcon";
import { LiveWaveform } from "./LiveWaveform";

export type VoicePillState = "idle" | "hover" | "recording" | "processing" | "unavailable";

interface VoicePillProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  variant: "floating" | "panel";
  state: VoicePillState;
  getAudioLevel: () => number | null;
  expanded?: boolean;
  isDragging?: boolean;
}

const GROW_TRANSITION = "320ms cubic-bezier(0.2, 0, 0, 1)";
const RESTING_WAVE_HEIGHTS = [5, 10, 14, 8, 16, 11, 7, 13];

const STATE_APPEARANCE: Record<VoicePillState, string> = {
  idle: "border-border/50 bg-surface-1 text-muted-foreground",
  hover: "border-border-hover bg-surface-2 text-foreground",
  recording: "border-border-hover bg-surface-1 text-foreground",
  processing: "border-border/60 bg-surface-1 text-foreground/70",
  unavailable: "border-border/60 bg-surface-1 text-muted-foreground",
};

/** One persistent control that resizes between the floating and panel layouts. */
export const VoicePill = forwardRef<HTMLDivElement, VoicePillProps>(function VoicePill(
  {
    variant,
    state,
    getAudioLevel,
    expanded = false,
    isDragging = false,
    className,
    style,
    ...props
  },
  ref
) {
  const isRecording = state === "recording";
  const isProcessing = state === "processing";
  const isUnavailable = state === "unavailable";
  const isPanel = variant === "panel";
  const showCompactPill = isPanel || expanded;
  const restingWaveHeights = isPanel ? RESTING_WAVE_HEIGHTS.slice(0, 6) : RESTING_WAVE_HEIGHTS;

  return (
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
        width: isPanel ? 92 : showCompactPill ? 112 : 40,
        height: isPanel ? 36 : showCompactPill ? 44 : 40,
        cursor: isProcessing ? "not-allowed" : isDragging ? "grabbing" : "pointer",
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
        size={isPanel ? 16 : showCompactPill ? 20 : state === "hover" ? 24 : 22}
        className={cn(
          "shrink-0 transition-[color,width,height] duration-200",
          (isUnavailable || isProcessing) && "animate-pulse"
        )}
      />

      <div
        className="shrink-0 overflow-hidden bg-border/60"
        style={{
          height: isPanel ? 16 : 20,
          width: showCompactPill ? 1 : 0,
          marginLeft: showCompactPill ? (isPanel ? 4 : 6) : 0,
          marginRight: showCompactPill ? (isPanel ? 4 : 6) : 0,
          opacity: showCompactPill ? 1 : 0,
          transition: `width ${GROW_TRANSITION}, margin ${GROW_TRANSITION}, opacity 180ms ease-out`,
        }}
      />

      <div
        className="shrink-0 overflow-hidden text-current"
        style={{
          width: showCompactPill ? (isPanel ? 52 : 64) : 0,
          height: isPanel ? 24 : 32,
          opacity: showCompactPill ? 1 : 0,
          transition: `width ${GROW_TRANSITION}, opacity 200ms ease-out 80ms`,
        }}
      >
        {showCompactPill && !isRecording ? (
          <div
            className={cn(
              "flex h-full items-center justify-center gap-0.5",
              isProcessing && "animate-pulse"
            )}
            aria-hidden="true"
          >
            {restingWaveHeights.map((height, index) => (
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
            barCount={isPanel ? 6 : 8}
            className={isRecording ? "" : "opacity-60"}
          />
        )}
      </div>

      {isUnavailable && (
        <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-foreground/30 animate-pulse" />
      )}
    </div>
  );
});
