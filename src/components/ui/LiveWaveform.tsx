import { useState, useRef, useEffect } from "react";
import { cn } from "../lib/utils";

const DEFAULT_BAR_COUNT = 40;
const WAVE_SAMPLE_MS = 150;
const WAVE_MAX_PX = 20;
const WAVE_MIN_PX = 2;
// Bar width 2px + gap 2px — used to derive the count in "auto" mode.
const WAVE_BAR_PITCH = 4;
const WAVE_MIN_AUTO_BARS = 16;
// Bars scale against a decaying session peak, so any mic gain fills the range.
const WAVE_PEAK_FLOOR = 0.01;
const WAVE_PEAK_DECAY = 0.99;
const WAVE_QUIET_NORM = 0.14;

function waveBarStyle(norm: number, index: number, count: number): React.CSSProperties {
  if (norm < WAVE_QUIET_NORM) {
    return { height: WAVE_MIN_PX, backgroundColor: "rgba(143,170,255,0.35)" };
  }
  // Periwinkle (#8FAAFF) → orange (#FFA23E) across the strip, louder = more opaque
  const t = index / (count - 1);
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
  /** Fixed bar count, or "auto" to fill the container's width. */
  bars?: number | "auto";
  className?: string;
}

export function LiveWaveform({
  readLevel,
  bars = DEFAULT_BAR_COUNT,
  className,
}: LiveWaveformProps) {
  const [samples, setSamples] = useState<number[]>([]);
  const peakRef = useRef(WAVE_PEAK_FLOOR);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoCount, setAutoCount] = useState(DEFAULT_BAR_COUNT);

  const count = bars === "auto" ? autoCount : bars;
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

  useEffect(() => {
    const id = setInterval(() => {
      const level = readLevel();
      peakRef.current = Math.max(level, peakRef.current * WAVE_PEAK_DECAY, WAVE_PEAK_FLOOR);
      const norm = Math.min(1, level / peakRef.current);
      setSamples((prev) => [...prev.slice(-(countRef.current - 1)), norm]);
    }, WAVE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [readLevel]);

  const recent = samples.slice(-count);
  const padded =
    recent.length < count ? [...Array<number>(count - recent.length).fill(0), ...recent] : recent;

  return (
    <div ref={containerRef} className={cn("flex items-center gap-0.5 h-5", className)}>
      {padded.map((norm, i) => (
        <div
          key={i}
          className="w-0.5 rounded-full shrink-0 transition-[height,background-color] duration-150 ease-out"
          style={waveBarStyle(norm, i, count)}
        />
      ))}
    </div>
  );
}
