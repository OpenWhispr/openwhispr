// Bars express loudness through scaleY + layer opacity, never height or
// background-color: a per-sample layout or paint write every 150ms is the CPU
// regression this replaces (an animated background-color also retriggers the
// global `*` background-color transition in index.css). Each bar stacks a
// uniform quiet layer under a gradient-hued active layer, and a sample
// cross-fades between them to reproduce the old visuals exactly.
export const WAVE_MAX_PX = 20;
const WAVE_MIN_PX = 2;
const WAVE_QUIET_NORM = 0.14;
const WAVE_QUIET_OPACITY = 0.35;

// The gradient's periwinkle end, shown uniformly by every quiet bar.
export const WAVE_QUIET_COLOR = "rgb(143,170,255)";

// Periwinkle (#8FAAFF) → orange (#FFA23E) across the strip, fixed per bar.
export function waveBarColor(index: number, count: number): string {
  const t = count > 1 ? index / (count - 1) : 0;
  const r = Math.round(143 + 112 * t);
  const g = Math.round(170 - 8 * t);
  const b = Math.round(255 - 193 * t);
  return `rgb(${r},${g},${b})`;
}

// Bars are vertically centered, so scaleY's default center origin reproduces
// the symmetric growth the old animated height had.
export function waveBarVisual(norm: number): {
  scaleY: number;
  quietOpacity: number;
  activeOpacity: number;
} {
  if (norm < WAVE_QUIET_NORM) {
    return {
      scaleY: WAVE_MIN_PX / WAVE_MAX_PX,
      quietOpacity: WAVE_QUIET_OPACITY,
      activeOpacity: 0,
    };
  }
  const height = Math.max(WAVE_MIN_PX, Math.round(Math.sqrt(norm) * WAVE_MAX_PX));
  return {
    scaleY: height / WAVE_MAX_PX,
    quietOpacity: 0,
    activeOpacity: 0.55 + 0.45 * Math.min(1, norm),
  };
}

export const WAVE_REST_VISUAL = waveBarVisual(0);
