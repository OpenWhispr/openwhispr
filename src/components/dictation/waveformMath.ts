export const WAVEFORM_BAR_COUNT = 11;
export const WAVEFORM_BAR_MIN_PX = 4;
export const WAVEFORM_BAR_MAX_PX = 22;

// Conversational speech RMS sits around 0.02–0.15; a square-root curve lifts
// quiet speech into the visible range while loud peaks still cap out.
const LEVEL_GAIN = 6;
const toBarLevel = (rms: number) => Math.min(1, Math.sqrt(Math.max(0, rms) * LEVEL_GAIN));

export const resolveWaveformBarHeight = (rms: number) =>
  WAVEFORM_BAR_MIN_PX + toBarLevel(rms) * (WAVEFORM_BAR_MAX_PX - WAVEFORM_BAR_MIN_PX);

/**
 * Neighboring and delayed samples form a quieter Agent echo instead of an
 * exact colored duplicate of the foreground waveform.
 */
export const resolveAgentWaveformBarHeight = (levels: number[], index: number) => {
  const current = levels[index] ?? 0;
  const previous = levels[Math.max(0, index - 1)] ?? current;
  const delayed = levels[Math.max(0, index - 2)] ?? previous;
  const next = levels[Math.min(levels.length - 1, index + 1)] ?? current;
  const smoothed = previous * 0.2 + current * 0.45 + next * 0.15 + delayed * 0.2;
  const height = resolveWaveformBarHeight(smoothed);
  const contour = 0.82 + Math.sin((index / (WAVEFORM_BAR_COUNT - 1)) * Math.PI) * 0.18;

  return WAVEFORM_BAR_MIN_PX + (height - WAVEFORM_BAR_MIN_PX) * contour;
};
