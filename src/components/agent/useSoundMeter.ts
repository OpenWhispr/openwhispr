import { useEffect, useRef, type RefObject } from "react";
import {
  SOUND_BAR_COUNT,
  SOUND_HISTORY_FRAMES,
  followLevel,
  soundBarLevels,
  soundLevel,
} from "./voiceBars";

/**
 * Paints the Sound bars' lifts (`--voice-bar-<index>`) and the sound's level
 * (`--voice-level`) on `target`, following `readLevel` while `active` and
 * otherwise sinking back to rest as after a silence, from wherever the bars
 * were. They hold still under reduced motion, and an animation ending never
 * changes the caller's state.
 */
export function useSoundMeter(
  target: RefObject<HTMLElement | null>,
  active: boolean,
  readLevel: () => number
) {
  // What the bars last showed, kept across states so they sink back from there.
  const meterRef = useRef({
    level: 0,
    barLevel: 0,
    history: new Array<number>(SOUND_HISTORY_FRAMES).fill(0),
  });

  useEffect(() => {
    const element = target.current;
    if (!element) return undefined;
    const meter = meterRef.current;
    const paintBars = (lifts: number[]) =>
      lifts.forEach((lift, index) =>
        element.style.setProperty(`--voice-bar-${index}`, lift.toFixed(3))
      );
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      element.style.setProperty("--voice-level", "0");
      paintBars(new Array(SOUND_BAR_COUNT).fill(0));
      return undefined;
    }
    let frame = 0;
    const paint = () => {
      const rms = active ? readLevel() : 0;
      meter.level = meter.level * 0.8 + Math.min(1, rms * 6) * 0.2;
      element.style.setProperty("--voice-level", meter.level.toFixed(3));
      meter.barLevel = followLevel(meter.barLevel, soundLevel(rms));
      meter.history.pop();
      meter.history.unshift(meter.barLevel);
      const lifts = soundBarLevels(meter.history);
      paintBars(lifts);
      // Back at rest with nothing to follow, it waits for the next state.
      if (active || meter.level > 0.001 || lifts.some((lift) => lift > 0.001)) {
        frame = requestAnimationFrame(paint);
      }
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [active, readLevel, target]);
}
