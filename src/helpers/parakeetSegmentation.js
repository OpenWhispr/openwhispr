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
// A remainder this short decodes to nothing and flags the transcript as
// partial. None of the limits is the model's own maximum, so the last segment
// absorbs it instead.
const TAIL_ALLOWANCE_SECONDS = 0.5;

function frameEnergy(samples, offset, frameBytes) {
  let sum = 0;
  for (let i = offset; i < offset + frameBytes; i += BYTES_PER_SAMPLE) {
    const value = samples.readFloatLE(i);
    sum += value * value;
  }
  return sum;
}

function windowEnergy(energies, start) {
  let sum = 0;
  for (let i = start; i < start + PAUSE_FRAMES; i++) sum += energies[i];
  return sum;
}

// Returns the byte offset to cut at within [from, to]; `to` is the hard limit.
function findPauseCut(samples, from, to, frameBytes) {
  const frameCount = Math.floor((to - from) / frameBytes);
  if (frameCount < PAUSE_FRAMES) return to;
  const energies = [];
  for (let frame = 0; frame < frameCount; frame++) {
    energies.push(frameEnergy(samples, from + frame * frameBytes, frameBytes));
  }

  // Windows are summed afresh rather than slid, so equal stretches of digital
  // silence compare equal. A run of them is cut in its middle, away from the
  // words on either side.
  let quietestEnergy = Infinity;
  let runStart = 0;
  let runEnd = 0;
  for (let start = 0; start + PAUSE_FRAMES <= frameCount; start++) {
    const energy = windowEnergy(energies, start);
    if (energy < quietestEnergy) {
      quietestEnergy = energy;
      runStart = start;
      runEnd = start;
    } else if (energy === quietestEnergy && runEnd === start - 1) {
      runEnd = start;
    }
  }
  const limitEnergy = windowEnergy(energies, frameCount - PAUSE_FRAMES);
  if (quietestEnergy >= limitEnergy * PAUSE_ENERGY_RATIO) return to;
  return from + Math.floor((runStart + runEnd + PAUSE_FRAMES) / 2) * frameBytes;
}

// samples: Buffer of float32 PCM. Returns subarrays that together cover the
// input in order; each is at most maxSegmentSeconds, the last up to
// TAIL_ALLOWANCE_SECONDS longer.
function splitAtPauses(samples, { sampleRate, maxSegmentSeconds }) {
  const maxSegmentBytes = maxSegmentSeconds * sampleRate * BYTES_PER_SAMPLE;
  const searchBytes = SEARCH_SECONDS * sampleRate * BYTES_PER_SAMPLE;
  const frameBytes = Math.round(FRAME_SECONDS * sampleRate) * BYTES_PER_SAMPLE;
  const tailAllowanceBytes = TAIL_ALLOWANCE_SECONDS * sampleRate * BYTES_PER_SAMPLE;
  // An earlier cut must not cost an extra segment: that would leave a short
  // tail, which is what decodes to nothing.
  const segmentCount = Math.ceil((samples.length - tailAllowanceBytes) / maxSegmentBytes);

  const segments = [];
  let start = 0;
  while (samples.length - start > maxSegmentBytes + tailAllowanceBytes) {
    const limit = start + maxSegmentBytes;
    const segmentsAfterCut = segmentCount - segments.length - 1;
    const earliest = Math.max(
      limit - searchBytes,
      samples.length - segmentsAfterCut * maxSegmentBytes - tailAllowanceBytes
    );
    const cut = findPauseCut(samples, earliest, limit, frameBytes);
    segments.push(samples.subarray(start, cut));
    start = cut;
  }
  segments.push(samples.subarray(start));
  return segments;
}

module.exports = { splitAtPauses };
