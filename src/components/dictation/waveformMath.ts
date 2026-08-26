export const WAVEFORM_BAR_COUNT = 11;
export const WAVEFORM_BAR_MIN_PX = 4;
export const WAVEFORM_BAR_MAX_PX = 22;

// A pronounced eleven-bar rhythm keeps rounded short bars readable while tall
// peaks use nearly the full lane. The same silhouette is the resting wave's
// shape and the live wave's per-slot ceiling, so both share one rhythm.
export const RESTING_WAVE_SILHOUETTE = [6, 12, 5, 9, 7, 22, 18, 5, 20, 12, 17];

// Live bars scale the measured level by their slot's silhouette weight:
// adjacent bars keep the designed tall/short alternation instead of blurring
// into a fluid ridge when the voice holds a steady level.
export const WAVEFORM_SLOT_WEIGHTS = Array.from(
  { length: WAVEFORM_BAR_COUNT },
  (_, index) =>
    RESTING_WAVE_SILHOUETTE[index % RESTING_WAVE_SILHOUETTE.length] / WAVEFORM_BAR_MAX_PX
);

// Conversational speech RMS sits around 0.02–0.15; a square-root curve lifts
// quiet speech into the visible range while loud peaks still cap out. The
// gain is tuned so ordinary voicing regularly reaches the top of the lane —
// the wave should read as a pronounced rhythm, not a murmur.
const LEVEL_GAIN = 9;
const toBarLevel = (rms: number) => Math.min(1, Math.sqrt(Math.max(0, rms) * LEVEL_GAIN));

export const resolveWaveformBarHeight = (rms: number, slotWeight = 1) =>
  WAVEFORM_BAR_MIN_PX + toBarLevel(rms) * slotWeight * (WAVEFORM_BAR_MAX_PX - WAVEFORM_BAR_MIN_PX);
