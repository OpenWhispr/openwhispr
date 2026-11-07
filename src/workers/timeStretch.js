// Speeds speech up without raising its pitch (WSOLA): overlapping frames are taken from
// the input `rate` times faster than they are laid down, each shifted to the nearby
// position that best continues the previous one, so the waveform stays in phase.
const FRAME_MS = 30;
const SEEK_MS = 10;

const msToSamples = (ms, sampleRate) => Math.round((ms * sampleRate) / 1000);

/** `samples` played `rate` times as fast at the same pitch; a copy, except at rate 1. */
function timeStretch(samples, rate, sampleRate) {
  const frame = msToSamples(FRAME_MS, sampleRate);
  const seek = msToSamples(SEEK_MS, sampleRate);
  if (rate === 1 || samples.length < frame + seek) return samples;
  const hop = frame >> 1;
  // A Hann window at half overlap sums to one, so the frames need no normalizing.
  const window = Float32Array.from(
    { length: frame },
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / frame)
  );
  const out = new Float32Array(Math.ceil(samples.length / rate) + frame);
  let previous = 0;
  let written = 0;
  for (let outStart = 0; ; outStart += hop) {
    const nominal = Math.round(outStart * rate);
    if (nominal + frame + seek > samples.length) break;
    let best = nominal;
    if (outStart > 0) {
      const natural = previous + hop;
      let bestScore = -Infinity;
      for (
        let candidate = Math.max(0, nominal - seek);
        candidate <= nominal + seek;
        candidate += 1
      ) {
        let score = 0;
        for (let index = 0; index < hop; index += 2) {
          score += samples[candidate + index] * samples[natural + index];
        }
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    for (let index = 0; index < frame; index += 1) {
      out[outStart + index] += samples[best + index] * window[index];
    }
    previous = best;
    written = outStart + frame;
  }
  return out.slice(0, written);
}

module.exports = { timeStretch };
