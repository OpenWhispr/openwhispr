export const WAVEFORM_BAR_COUNT = 11;
export const WAVEFORM_BAR_MIN_PX = 4;
export const WAVEFORM_BAR_MAX_PX = 22;

// A pronounced eleven-bar rhythm keeps rounded short bars readable while tall
// peaks use nearly the full lane. Only the resting wave draws this shape —
// the live wave renders the measured signal, never a decorative profile.
export const RESTING_WAVE_SILHOUETTE = [6, 12, 5, 9, 7, 22, 18, 5, 20, 12, 17];

// Conversational speech RMS sits around 0.02–0.15. The gain puts loud voicing
// at the top of the lane; the 0.75 exponent keeps quiet speech visible while
// preserving contrast between neighboring samples — a square-root curve
// compressed them into a fluid ridge with little bar-to-bar variance.
const LEVEL_GAIN = 8;
const LEVEL_EXPONENT = 0.75;
const toBarLevel = (rms: number) =>
  Math.min(1, Math.pow(Math.max(0, rms) * LEVEL_GAIN, LEVEL_EXPONENT));

export const resolveWaveformBarHeight = (rms: number) =>
  WAVEFORM_BAR_MIN_PX + toBarLevel(rms) * (WAVEFORM_BAR_MAX_PX - WAVEFORM_BAR_MIN_PX);
