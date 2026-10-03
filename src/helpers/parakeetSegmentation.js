// Splits float32 PCM for offline models that cap the clip length. A cut at a
// fixed offset lands mid-word, and each segment decodes independently: the
// word at the cut comes back garbled, and a short tail can decode to nothing
// (#2476). So each cut moves to the quietest stretch shortly before the limit.

const BYTES_PER_SAMPLE = 4; // float32
const FRAME_SECONDS = 0.01;
// Long enough that a stop-consonant closure inside a word doesn't pass for a pause.
const PAUSE_FRAMES = 10;
const SEARCH_SECONDS = 4;
// Without a stretch clearly quieter than the audio at the limit there is no
// pause to find, so the cut stays at the limit.
const PAUSE_ENERGY_RATIO = 0.5;

function frameEnergy(samples, offset, frameBytes) {
  let sum = 0;
  for (let i = offset; i < offset + frameBytes; i += BYTES_PER_SAMPLE) {
    const value = samples.readFloatLE(i);
    sum += value * value;
  }
  return sum;
}

// Returns the byte offset to cut at within [from, to]; `to` is the hard limit.
function findPauseCut(samples, from, to, frameBytes) {
  const energies = [];
  for (let offset = from; offset + frameBytes <= to; offset += frameBytes) {
    energies.push(frameEnergy(samples, offset, frameBytes));
  }
  if (energies.length < PAUSE_FRAMES) return to;

  let windowEnergy = 0;
  for (let i = 0; i < PAUSE_FRAMES; i++) windowEnergy += energies[i];
  let quietestEnergy = windowEnergy;
  let quietestStart = 0;
  for (let i = PAUSE_FRAMES; i < energies.length; i++) {
    windowEnergy += energies[i] - energies[i - PAUSE_FRAMES];
    if (windowEnergy < quietestEnergy) {
      quietestEnergy = windowEnergy;
      quietestStart = i - PAUSE_FRAMES + 1;
    }
  }
  // windowEnergy now covers the stretch that ends at the limit.
  if (quietestEnergy >= windowEnergy * PAUSE_ENERGY_RATIO) return to;
  return from + (quietestStart + PAUSE_FRAMES / 2) * frameBytes;
}

// samples: Buffer of float32 PCM. Returns subarrays of at most
// maxSegmentSeconds that together cover the input in order.
function splitAtPauses(samples, { sampleRate, maxSegmentSeconds }) {
  const maxSegmentBytes = maxSegmentSeconds * sampleRate * BYTES_PER_SAMPLE;
  const searchBytes =
    Math.min(SEARCH_SECONDS, maxSegmentSeconds / 2) * sampleRate * BYTES_PER_SAMPLE;
  const frameBytes = Math.round(FRAME_SECONDS * sampleRate) * BYTES_PER_SAMPLE;

  const segments = [];
  let start = 0;
  while (samples.length - start > maxSegmentBytes) {
    const limit = start + maxSegmentBytes;
    const cut = findPauseCut(samples, limit - searchBytes, limit, frameBytes);
    segments.push(samples.subarray(start, cut));
    start = cut;
  }
  segments.push(samples.subarray(start));
  return segments;
}

module.exports = { splitAtPauses };
