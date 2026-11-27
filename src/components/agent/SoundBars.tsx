import type { Ref } from "react";
import { cn } from "../lib/utils";
import { SOUND_BAR_COUNT, soundBarHeight } from "./voiceBars";

// How far behind the bar before it each bar turns blue, so the shimmer travels across them.
const BAR_SHIMMER_STAGGER_MS = 200;

interface SoundBarsProps {
  /** The element useSoundMeter paints, when it is these bars themselves. */
  ref?: Ref<HTMLDivElement>;
  /** Work in progress: a blue wave runs across the bars, as the shimmer does across "Thinking…". */
  shimmer?: boolean;
  /** Dimmed while the call isn't running, or its microphone is off and nothing plays. */
  dimmed?: boolean;
}

/** The four Sound bars, lifted by the `--voice-bar-<index>` that useSoundMeter paints on them or an ancestor. */
export function SoundBars({ ref, shimmer = false, dimmed = false }: SoundBarsProps) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex h-7 shrink-0 items-center gap-[3.5px] text-foreground",
        dimmed && "opacity-50"
      )}
      aria-hidden="true"
    >
      {Array.from({ length: SOUND_BAR_COUNT }, (_, index) => (
        <span
          key={index}
          className={cn("w-0.5 rounded-full bg-current", shimmer && "voice-bar-shimmer")}
          style={{
            height: soundBarHeight(index),
            ...(shimmer ? { animationDelay: `${index * BAR_SHIMMER_STAGGER_MS}ms` } : {}),
          }}
        />
      ))}
    </div>
  );
}
