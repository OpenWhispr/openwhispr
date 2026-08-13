import { forwardRef, type HTMLAttributes } from "react";
import { X } from "lucide-react";
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
  cancelLabel?: string;
  onCancel?: () => void;
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

/**
 * Shared visual for the floating dictation control and the capsule nested in
 * the assistant panel. Keeping one DOM shape lets the View Transitions API
 * carry the pill between the two layouts instead of cross-fading replacements.
 */
export const VoicePill = forwardRef<HTMLDivElement, VoicePillProps>(function VoicePill(
  {
    variant,
    state,
    getAudioLevel,
    expanded = false,
    isDragging = false,
    cancelLabel,
    onCancel,
    className,
    style,
    ...props
  },
  ref
) {
  const isRecording = state === "recording";
  const isProcessing = state === "processing";
  const isUnavailable = state === "unavailable";

  if (variant === "panel") {
    return (
      <div
        ref={ref}
        className={cn(
          "flex h-11 w-28 shrink-0 items-center rounded-full border px-2",
          "shadow-[var(--shadow-card)]",
          STATE_APPEARANCE[state],
          className
        )}
        style={{ viewTransitionName: "assistant-voice-pill", ...style }}
        {...props}
      >
        <BrandMarkIcon size={20} className="shrink-0" />
        <div className="mx-1.5 h-5 w-px bg-border/60" />
        <div className="flex h-7 min-w-0 flex-1 items-center justify-center">
          {isRecording ? (
            <LiveWaveform getLevel={getAudioLevel} active barCount={8} />
          ) : (
            <div
              className={cn("flex items-center gap-0.5", isProcessing && "animate-pulse")}
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
          )}
        </div>
      </div>
    );
  }

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
        // The orb grows sideways toward the screen center, never upward.
        width: expanded ? 264 : 40,
        height: 40,
        cursor: isProcessing ? "not-allowed" : isDragging ? "grabbing" : "pointer",
        transform: state === "hover" ? "scale(1.05)" : "scale(1)",
        transition: `width ${GROW_TRANSITION}, transform 200ms cubic-bezier(0.2, 0, 0, 1), background-color 200ms ease-out`,
        viewTransitionName: "assistant-voice-pill",
        ...style,
      }}
      {...props}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-foreground/10 to-transparent transition-opacity duration-150"
        style={{ opacity: state === "hover" ? 0.8 : 0 }}
      />

      <BrandMarkIcon
        size={state === "hover" ? 24 : 22}
        className={cn(
          "shrink-0 transition-[color,width,height] duration-200",
          (isUnavailable || isProcessing) && "animate-pulse"
        )}
      />

      <div
        className="h-8 shrink-0 overflow-hidden text-current"
        style={{
          width: expanded ? 148 : 0,
          marginLeft: expanded ? 10 : 0,
          opacity: expanded ? 1 : 0,
          transition: `width ${GROW_TRANSITION}, margin-left ${GROW_TRANSITION}, opacity 200ms ease-out 80ms`,
        }}
      >
        <LiveWaveform
          getLevel={getAudioLevel}
          active={isRecording}
          className={isRecording ? "" : "opacity-60"}
        />
      </div>

      <div
        className="shrink-0 overflow-hidden"
        style={{
          width: expanded ? 32 : 0,
          marginLeft: expanded ? 6 : 0,
          opacity: expanded ? 1 : 0,
          transition: `width ${GROW_TRANSITION}, margin-left ${GROW_TRANSITION}, opacity 200ms ease-out 80ms`,
        }}
        // A near-miss on cancel must not commit via the capsule click handler.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          aria-label={cancelLabel}
          tabIndex={expanded ? 0 : -1}
          onClick={onCancel}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground/10">
            <X size={12} strokeWidth={2.5} className="text-foreground/80" />
          </span>
        </button>
      </div>

      {isUnavailable && (
        <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-foreground/30 animate-pulse" />
      )}
    </div>
  );
});
