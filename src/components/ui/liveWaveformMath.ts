export const WAVE_MAX_PX = 20;
export const WAVE_MIN_PX = 2;
const WAVE_QUIET_NORM = 0.14;
const WAVE_QUIET_OPACITY = 0.35;

// Below the quiet threshold every bar shows the same faint periwinkle,
// regardless of its position in the gradient.
export const WAVE_QUIET_COLOR = "rgb(143,170,255)";

// Periwinkle (#8FAAFF) → orange (#FFA23E) across the strip. The color is fixed
// per bar; loudness is expressed through scaleY + layer opacity so a sample
// never touches layout or paint (an animated background-color would retrigger
// the global * background-color transition in index.css every 150ms).
export function waveBarColor(index: number, count: number): string {
  const t = count > 1 ? index / (count - 1) : 0;
  const r = Math.round(143 + 112 * t);
  const g = Math.round(170 - 8 * t);
  const b = Math.round(255 - 193 * t);
  return `rgb(${r},${g},${b})`;
}

// Compositor-only per-sample visual: bars sit vertically centered (items-center),
// so the default center transform origin keeps the symmetric look scaleY had
// to preserve from the old animated height. Each bar stacks a uniform quiet
// layer under its gradient-hued active layer; a sample cross-fades between
// them, so quiet bars keep the old uniform rgba(143,170,255,0.35) look while
// active bars keep the old gradient hue at the 0.55 + 0.45 * norm alpha curve.
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
