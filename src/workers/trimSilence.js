// Supertonic pads every clip with about half a second of silence at each end. Left in,
// the listener waits that long for the first word and hears a second of dead air between
// sentences. The trim keeps a short lead-in and a sentence-sized pause.
const WINDOW_MS = 10;
// Relative to the loudest window, so it holds for any voice or level; soft onsets
// ("h", "f", "th") sit well above it.
const SILENCE_RATIO = 0.02;
const KEEP_LEAD_MS = 50;
const KEEP_TRAIL_MS = 250;

const msToSamples = (ms, sampleRate) => Math.round((ms * sampleRate) / 1000);

/** A copy of `samples` without the silence at either end beyond the kept lead-in and pause. */
function trimSilence(samples, sampleRate) {
  const windowSize = Math.max(1, msToSamples(WINDOW_MS, sampleRate));
  const levels = [];
  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(start + windowSize, samples.length);
    let energy = 0;
    for (let index = start; index < end; index += 1) energy += samples[index] * samples[index];
    levels.push(Math.sqrt(energy / (end - start)));
  }
  const threshold = Math.max(0, ...levels) * SILENCE_RATIO;
  const first = levels.findIndex((level) => level > threshold);
  if (first < 0) return samples.slice();
  const last = levels.findLastIndex((level) => level > threshold);
  // slice, not subarray: a view would carry the whole buffer across postMessage.
  return samples.slice(
    Math.max(0, first * windowSize - msToSamples(KEEP_LEAD_MS, sampleRate)),
    (last + 1) * windowSize + msToSamples(KEEP_TRAIL_MS, sampleRate)
  );
}

module.exports = { trimSilence, KEEP_LEAD_MS, KEEP_TRAIL_MS };
