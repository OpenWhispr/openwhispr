import React, { useEffect, useRef } from "react";

interface LiveWaveformProps {
  /** Returns the current input level (0..~1) or null when no signal source exists. */
  getLevel: () => number | null;
  /** While true the bars scroll with live levels; false freezes the captured wave. */
  active: boolean;
  barCount?: number;
  className?: string;
}

const BAR_MIN_PX = 3;
const BAR_MAX_PX = 26;
const SAMPLE_INTERVAL_MS = 60;
// Speech RMS rarely exceeds ~0.35; scale so normal speech fills the range.
const LEVEL_GAIN = 3;

/**
 * Level-driven waveform: bars scroll right-to-left with the live input signal.
 * Heights are written directly to the DOM from a rAF loop so recording never
 * pays React re-render cost. With no signal (getLevel → null) the bars rest at
 * minimum height; when `active` goes false the last captured wave stays frozen.
 */
export function LiveWaveform({ getLevel, active, barCount = 14, className }: LiveWaveformProps) {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const levelsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!active) return;

    // A new recording starts from silence — never replay the previous
    // session's frozen wave.
    levelsRef.current = new Array(barCount).fill(0);
    for (const bar of barRefs.current) {
      if (bar) bar.style.height = `${BAR_MIN_PX}px`;
    }

    let frame = 0;
    let lastSample = 0;
    const paint = (now: number) => {
      if (now - lastSample >= SAMPLE_INTERVAL_MS) {
        lastSample = now;
        const level = getLevel();
        const levels = levelsRef.current;
        levels.shift();
        levels.push(level === null ? 0 : Math.min(1, level * LEVEL_GAIN));
        for (let i = 0; i < levels.length; i++) {
          const bar = barRefs.current[i];
          if (bar) {
            bar.style.height = `${BAR_MIN_PX + levels[i] * (BAR_MAX_PX - BAR_MIN_PX)}px`;
          }
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [active, barCount, getLevel]);

  return (
    <div
      className={`flex h-full items-center justify-center gap-[3px] ${className ?? ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: barCount }, (_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="w-[3px] rounded-full bg-current"
          style={{ height: BAR_MIN_PX }}
        />
      ))}
    </div>
  );
}
