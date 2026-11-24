// The call pill's four Sound bars: at rest they keep the design's shape, and speech lifts
// each one by how loud the sound was a moment ago, so the wave ripples with the real audio.
const REST_PX = [8, 8, 14, 8];
const PEAK_PX = 28;
const REACH = [0.75, 1, 0.9, 0.65];
// How many frames behind the newest level each bar reads.
const FRAME_DELAY = [6, 0, 3, 9];

// A quiet room stays still, and normal speech reaches well up the bars.
const NOISE_FLOOR_RMS = 0.008;
const FULL_SCALE_RMS = 0.16;
const LOUDNESS_CURVE = 0.6;
const ATTACK = 0.55;
const RELEASE = 0.14;

export const SOUND_BAR_COUNT = REST_PX.length;
export const SOUND_HISTORY_FRAMES = Math.max(...FRAME_DELAY) + 1;

/** How loud a sound's RMS reads, from 0 (the noise floor) to 1. */
export function soundLevel(rms: number): number {
  const above = (rms - NOISE_FLOOR_RMS) / (FULL_SCALE_RMS - NOISE_FLOOR_RMS);
  return above <= 0 ? 0 : Math.min(1, above ** LOUDNESS_CURVE);
}

/** Rises quickly with a syllable and falls back slowly. */
export function followLevel(current: number, target: number): number {
  return current + (target - current) * (target > current ? ATTACK : RELEASE);
}

/** Each bar's lift from the recent levels, newest first. */
export function soundBarLevels(history: readonly number[]): number[] {
  return FRAME_DELAY.map((delay, index) => (history[delay] ?? 0) * REACH[index]);
}

// While a turn works, a low swell runs slowly across the bars, once per
// cycle of the cap's Working dots, rising gently from rest.
const THINKING_PERIOD_MS = 3600;
const THINKING_LIFT = 0.35;
const THINKING_EASE_IN_MS = 800;

/** Each bar's lift `elapsedMs` into a turn's work. */
export function thinkingBarLevels(elapsedMs: number): number[] {
  const ease = Math.min(1, elapsedMs / THINKING_EASE_IN_MS);
  return REST_PX.map((_, index) => {
    const phase = elapsedMs / THINKING_PERIOD_MS - index / SOUND_BAR_COUNT;
    return THINKING_LIFT * ease * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
  });
}

/** A bar's height, following its `--voice-bar-<index>` lift. */
export function soundBarHeight(index: number): string {
  const rest = REST_PX[index];
  return `calc(${rest}px + ${PEAK_PX - rest}px * var(--voice-bar-${index}, 0))`;
}
