// Deterministic PCM generators for meeting-audio tests. 24 kHz mono float in [-1, 1].
const SAMPLE_RATE = 24000;

const samplesFor = (durationMs, sampleRate) => Math.round((durationMs / 1000) * sampleRate);

function makeSine({
  frequencyHz = 440,
  durationMs,
  amplitude = 0.5,
  sampleRate = SAMPLE_RATE,
  phase = 0,
}) {
  const out = new Float32Array(samplesFor(durationMs, sampleRate));
  const step = (2 * Math.PI * frequencyHz) / sampleRate;
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin(phase + i * step);
  return out;
}

// Numerical Recipes LCG — same seed ⇒ same samples on every platform.
function makeSeededNoise({ durationMs, amplitude = 0.5, seed = 1, sampleRate = SAMPLE_RATE }) {
  const out = new Float32Array(samplesFor(durationMs, sampleRate));
  let state = seed >>> 0;
  for (let i = 0; i < out.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = amplitude * ((state / 4294967296) * 2 - 1);
  }
  return out;
}

function mix(...tracks) {
  const length = Math.max(0, ...tracks.map((t) => t.length));
  const out = new Float32Array(length);
  for (const track of tracks) {
    for (let i = 0; i < track.length; i += 1) out[i] += track[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i]));
  return out;
}

function scale(track, gain) {
  const out = new Float32Array(track.length);
  for (let i = 0; i < track.length; i += 1) out[i] = track[i] * gain;
  return out;
}

function delayBy(track, delayMs, sampleRate = SAMPLE_RATE) {
  const lead = samplesFor(delayMs, sampleRate);
  const out = new Float32Array(track.length + lead);
  out.set(track, lead);
  return out;
}

function toInt16Buffer(track) {
  const buf = Buffer.alloc(track.length * 2);
  for (let i = 0; i < track.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, track[i]));
    const value = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buf;
}

function chunkBuffer(buffer, samplesPerChunk) {
  const bytes = samplesPerChunk * 2;
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += bytes) {
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + bytes)));
  }
  return chunks;
}

function rmsOf(track) {
  if (!track.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < track.length; i += 1) sumSq += track[i] * track[i];
  return Math.sqrt(sumSq / track.length);
}

const dbToGain = (db) => 10 ** (db / 20);

module.exports = {
  SAMPLE_RATE,
  makeSine,
  makeSeededNoise,
  mix,
  scale,
  delayBy,
  toInt16Buffer,
  chunkBuffer,
  rmsOf,
  dbToGain,
};
