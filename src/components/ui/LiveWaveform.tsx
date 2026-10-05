import { useState, useRef, useEffect } from "react";
import { cn } from "../lib/utils";
import {
  WAVE_MAX_PX,
  WAVE_QUIET_COLOR,
  WAVE_REST_VISUAL,
  waveBarColor,
  waveBarVisual,
} from "./liveWaveformMath";

const DEFAULT_BAR_COUNT = 40;
const WAVE_SAMPLE_MS = 150;
// Bar width 2px + gap 2px — used to derive the count in "auto" mode.
const WAVE_BAR_PITCH = 4;
const WAVE_MIN_AUTO_BARS = 16;
// Bars scale against a decaying session peak, so any mic gain fills the range.
const WAVE_PEAK_FLOOR = 0.01;
const WAVE_PEAK_DECAY = 0.99;

// The cross-faded quiet/active pair behind every bar (see liveWaveformMath.ts).
const WAVE_LAYER_CLASS =
  "absolute inset-0 rounded-full transition-opacity duration-150 ease-out motion-reduce:transition-none";

interface LiveWaveformProps {
  /** Returns the current level (RMS, 0..1-ish); sampled every 150ms. */
  readLevel: () => number;
  /** Fixed bar count, or "auto" to fill the container's width. */
  bars?: number | "auto";
  className?: string;
}

export function LiveWaveform({
  readLevel,
  bars = DEFAULT_BAR_COUNT,
  className,
}: LiveWaveformProps) {
  const peakRef = useRef(WAVE_PEAK_FLOOR);
  const containerRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const quietRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const levelsRef = useRef<number[]>([]);
  const [autoCount, setAutoCount] = useState(DEFAULT_BAR_COUNT);

  const count = bars === "auto" ? autoCount : bars;
  // Read through a ref inside the sampler: in "auto" mode a resize drag can
  // change the count faster than WAVE_SAMPLE_MS, and a count dependency would
  // restart the interval each time so it never ticks.
  const countRef = useRef(count);
  countRef.current = count;

  useEffect(() => {
    if (bars !== "auto") return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setAutoCount(Math.max(WAVE_MIN_AUTO_BARS, Math.floor((el.clientWidth + 2) / WAVE_BAR_PITCH)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [bars]);

  // Samples are written straight to the bar elements (no setState per tick):
  // recording never pays React render, layout, or paint cost for the wave.
  useEffect(() => {
    const id = setInterval(() => {
      const level = readLevel();
      peakRef.current = Math.max(level, peakRef.current * WAVE_PEAK_DECAY, WAVE_PEAK_FLOOR);
      const norm = Math.min(1, level / peakRef.current);
      const barCount = countRef.current;
      const levels = levelsRef.current;
      levels.push(norm);
      if (levels.length > barCount) levels.splice(0, levels.length - barCount);
      for (let i = 0; i < barCount; i++) {
        const bar = barRefs.current[i];
        const quiet = quietRefs.current[i];
        const active = activeRefs.current[i];
        if (!bar || !quiet || !active) continue;
        // History is right-aligned: bars without a sample yet rest at minimum.
        const { scaleY, quietOpacity, activeOpacity } = waveBarVisual(
          levels[levels.length - barCount + i] ?? 0
        );
        bar.style.transform = `scaleY(${scaleY})`;
        quiet.style.opacity = String(quietOpacity);
        active.style.opacity = String(activeOpacity);
      }
    }, WAVE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [readLevel]);

  return (
    <div ref={containerRef} className={cn("flex items-center gap-0.5 h-5", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="relative w-0.5 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none"
          style={{
            height: WAVE_MAX_PX,
            transform: `scaleY(${WAVE_REST_VISUAL.scaleY})`,
          }}
        >
          <div
            ref={(el) => {
              quietRefs.current[i] = el;
            }}
            className={WAVE_LAYER_CLASS}
            style={{ backgroundColor: WAVE_QUIET_COLOR, opacity: WAVE_REST_VISUAL.quietOpacity }}
          />
          <div
            ref={(el) => {
              activeRefs.current[i] = el;
            }}
            className={WAVE_LAYER_CLASS}
            style={{
              backgroundColor: waveBarColor(i, count),
              opacity: WAVE_REST_VISUAL.activeOpacity,
            }}
          />
        </div>
      ))}
    </div>
  );
}
