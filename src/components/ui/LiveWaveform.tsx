import { useState, useRef, useEffect } from "react";
import { cn } from "../lib/utils";

const WAVE_BAR_COUNT = 40;
const WAVE_SAMPLE_MS = 150;
const WAVE_MAX_PX = 20;
const WAVE_MIN_PX = 2;
// Bars scale against a decaying session peak, so any mic gain fills the range.
const WAVE_PEAK_FLOOR = 0.01;
const WAVE_PEAK_DECAY = 0.99;
const WAVE_QUIET_NORM = 0.14;

function waveBarStyle(norm: number, index: number): React.CSSProperties {
  if (norm < WAVE_QUIET_NORM) {
    return { height: WAVE_MIN_PX, backgroundColor: "rgba(143,170,255,0.35)" };
  }
  // Periwinkle (#8FAAFF) → orange (#FFA23E) across the strip, louder = more opaque
  const t = index / (WAVE_BAR_COUNT - 1);
  const r = Math.round(143 + 112 * t);
  const g = Math.round(170 - 8 * t);
  const b = Math.round(255 - 193 * t);
  const alpha = 0.55 + 0.45 * Math.min(1, norm);
  return {
    height: Math.max(WAVE_MIN_PX, Math.round(Math.sqrt(norm) * WAVE_MAX_PX)),
    backgroundColor: `rgba(${r},${g},${b},${alpha})`,
  };
}

interface LiveWaveformProps {
  /** Returns the current level (RMS, 0..1-ish); sampled every 150ms. */
  readLevel: () => number;
  className?: string;
}

export function LiveWaveform({ readLevel, className }: LiveWaveformProps) {
  const [samples, setSamples] = useState<number[]>([]);
  const peakRef = useRef(WAVE_PEAK_FLOOR);

  useEffect(() => {
    const id = setInterval(() => {
      const level = readLevel();
      peakRef.current = Math.max(level, peakRef.current * WAVE_PEAK_DECAY, WAVE_PEAK_FLOOR);
      const norm = Math.min(1, level / peakRef.current);
      setSamples((prev) => [...prev.slice(-(WAVE_BAR_COUNT - 1)), norm]);
    }, WAVE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [readLevel]);

  const padded =
    samples.length < WAVE_BAR_COUNT
      ? [...Array<number>(WAVE_BAR_COUNT - samples.length).fill(0), ...samples]
      : samples;

  return (
    <div className={cn("flex items-center gap-0.5 h-5", className)}>
      {padded.map((norm, i) => (
        <div
          key={i}
          className="w-0.5 rounded-full shrink-0 transition-[height,background-color] duration-150 ease-out"
          style={waveBarStyle(norm, i)}
        />
      ))}
    </div>
  );
}
