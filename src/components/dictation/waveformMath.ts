export const WAVEFORM_BAR_COUNT = 11;
export const WAVEFORM_BAR_MIN_PX = 4;
export const WAVEFORM_BAR_MAX_PX = 22;

// Conversational speech RMS sits around 0.02–0.15; a square-root curve lifts
// quiet speech into the visible range while loud peaks still cap out.
const LEVEL_GAIN = 6;
const toBarLevel = (rms: number) => Math.min(1, Math.sqrt(Math.max(0, rms) * LEVEL_GAIN));

export const resolveWaveformBarHeight = (rms: number) =>
  WAVEFORM_BAR_MIN_PX + toBarLevel(rms) * (WAVEFORM_BAR_MAX_PX - WAVEFORM_BAR_MIN_PX);
