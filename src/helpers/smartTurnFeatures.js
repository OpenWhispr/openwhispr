// Whisper-style log-mel features for Pipecat Smart Turn v3, ported from pipecat's
// numpy implementation (src/pipecat/audio/turn/smart_turn/_whisper_features.py,
// BSD-2), which itself mirrors transformers' WhisperFeatureExtractor(chunk_length=8).

const SAMPLE_RATE = 16000;
const SMART_TURN_SECONDS = 8;
const SMART_TURN_SAMPLES = SAMPLE_RATE * SMART_TURN_SECONDS;
const N_FFT = 400;
const HOP_LENGTH = 160;
const SMART_TURN_MELS = 80;
const NUM_BINS = N_FFT / 2 + 1;
// 801 centered frames; the reference drops the trailing one.
const SMART_TURN_FRAMES = SMART_TURN_SAMPLES / HOP_LENGTH;
const MEL_FLOOR = 1e-10;
const NORM_VARIANCE_EPS = 1e-7;

/** The model reads the last 8 s; shorter turns are zero-padded at the start. */
function prepareSmartTurnAudio(samples) {
  if (samples.length >= SMART_TURN_SAMPLES) {
    return Float32Array.from(samples.subarray(samples.length - SMART_TURN_SAMPLES));
  }
  const prepared = new Float32Array(SMART_TURN_SAMPLES);
  prepared.set(samples, SMART_TURN_SAMPLES - samples.length);
  return prepared;
}

function hertzToMelSlaney(freq) {
  if (freq < 1000) return (3 * freq) / 200;
  return 15 + Math.log(freq / 1000) * (27 / Math.log(6.4));
}

function melToHertzSlaney(mel) {
  if (mel < 15) return (200 * mel) / 3;
  return 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15));
}

/** Slaney-normalized triangular filters, laid out [mel][bin]. */
function buildMelFilters() {
  const melMax = hertzToMelSlaney(SAMPLE_RATE / 2);
  const filterFreqs = new Float64Array(SMART_TURN_MELS + 2);
  for (let index = 0; index < filterFreqs.length; index += 1) {
    filterFreqs[index] = melToHertzSlaney((melMax * index) / (SMART_TURN_MELS + 1));
  }
  const filters = new Float64Array(SMART_TURN_MELS * NUM_BINS);
  for (let mel = 0; mel < SMART_TURN_MELS; mel += 1) {
    const lower = filterFreqs[mel];
    const center = filterFreqs[mel + 1];
    const upper = filterFreqs[mel + 2];
    const enorm = 2 / (upper - lower);
    for (let bin = 0; bin < NUM_BINS; bin += 1) {
      const fftFreq = (bin * (SAMPLE_RATE / 2)) / (NUM_BINS - 1);
      const down = (fftFreq - lower) / (center - lower);
      const up = (upper - fftFreq) / (upper - center);
      filters[mel * NUM_BINS + bin] = Math.max(0, Math.min(down, up)) * enorm;
    }
  }
  return filters;
}

// 400 = 2^4 * 5^2, so a mixed-radix FFT replaces an O(n^2) DFT per frame.
const FFT_FACTORS = [2, 2, 2, 2, 5, 5];
const TWIDDLE_RE = new Float64Array(N_FFT);
const TWIDDLE_IM = new Float64Array(N_FFT);
for (let index = 0; index < N_FFT; index += 1) {
  TWIDDLE_RE[index] = Math.cos((-2 * Math.PI * index) / N_FFT);
  TWIDDLE_IM[index] = Math.sin((-2 * Math.PI * index) / N_FFT);
}
const HANN = new Float64Array(N_FFT);
for (let index = 0; index < N_FFT; index += 1) {
  HANN[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / N_FFT);
}
const MEL_FILTERS = buildMelFilters();
// Each triangle spans a few bins; iterating only those cuts the mel projection ~40x.
const MEL_BIN_RANGES = Array.from({ length: SMART_TURN_MELS }, (_, mel) => {
  const row = MEL_FILTERS.subarray(mel * NUM_BINS, (mel + 1) * NUM_BINS);
  const first = row.findIndex((weight) => weight > 0);
  if (first === -1) return [0, 0];
  let last = NUM_BINS - 1;
  while (row[last] === 0) last -= 1;
  return [first, last + 1];
});

function fftRecursive(
  input,
  inOffset,
  stride,
  size,
  outRe,
  outIm,
  outOffset,
  factorIndex,
  scratchRe,
  scratchIm
) {
  if (size === 1) {
    outRe[outOffset] = input[inOffset];
    outIm[outOffset] = 0;
    return;
  }
  const radix = FFT_FACTORS[factorIndex];
  const sub = size / radix;
  for (let r = 0; r < radix; r += 1) {
    fftRecursive(
      input,
      inOffset + r * stride,
      stride * radix,
      sub,
      outRe,
      outIm,
      outOffset + r * sub,
      factorIndex + 1,
      scratchRe,
      scratchIm
    );
  }
  const twiddleStep = N_FFT / size;
  for (let k = 0; k < sub; k += 1) {
    for (let r = 0; r < radix; r += 1) {
      scratchRe[r] = outRe[outOffset + r * sub + k];
      scratchIm[r] = outIm[outOffset + r * sub + k];
    }
    for (let q = 0; q < radix; q += 1) {
      const bin = k + q * sub;
      let sumRe = 0;
      let sumIm = 0;
      for (let r = 0; r < radix; r += 1) {
        const twiddle = ((r * bin) % size) * twiddleStep;
        const wr = TWIDDLE_RE[twiddle];
        const wi = TWIDDLE_IM[twiddle];
        sumRe += scratchRe[r] * wr - scratchIm[r] * wi;
        sumIm += scratchRe[r] * wi + scratchIm[r] * wr;
      }
      outRe[outOffset + bin] = sumRe;
      outIm[outOffset + bin] = sumIm;
    }
  }
}

function normalizeWaveform(audio) {
  let sum = 0;
  for (let index = 0; index < audio.length; index += 1) sum += audio[index];
  const mean = sum / audio.length;
  let variance = 0;
  for (let index = 0; index < audio.length; index += 1) variance += (audio[index] - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / audio.length + NORM_VARIANCE_EPS);
  // float32, matching the reference's precision before the float64 spectrogram.
  const normalized = new Float32Array(audio.length);
  for (let index = 0; index < audio.length; index += 1)
    normalized[index] = (audio[index] - mean) * scale;
  return normalized;
}

function reflectPad(audio, pad) {
  const padded = new Float64Array(audio.length + 2 * pad);
  padded.set(audio, pad);
  for (let index = 0; index < pad; index += 1) {
    padded[index] = audio[pad - index];
    padded[pad + audio.length + index] = audio[audio.length - 2 - index];
  }
  return padded;
}

/**
 * Log-mel features for exactly 8 s of 16 kHz audio (use prepareSmartTurnAudio
 * first), returned row-major as [80 mels][800 frames] for input_features [1, 80, 800].
 */
function whisperLogMel(audio) {
  if (audio.length !== SMART_TURN_SAMPLES) {
    throw new Error(`expected ${SMART_TURN_SAMPLES} samples, got ${audio.length}`);
  }
  const padded = reflectPad(normalizeWaveform(audio), N_FFT / 2);
  const frame = new Float64Array(N_FFT);
  const specRe = new Float64Array(N_FFT);
  const specIm = new Float64Array(N_FFT);
  const scratchRe = new Float64Array(5);
  const scratchIm = new Float64Array(5);
  const power = new Float64Array(NUM_BINS);
  const logSpec = new Float32Array(SMART_TURN_MELS * SMART_TURN_FRAMES);
  let maxValue = -Infinity;
  // Short turns are mostly left padding, which normalizes to one constant, so
  // those frames share a spectrum: compute it once.
  let constantValue = null;
  const constantPower = new Float64Array(NUM_BINS);

  for (let frameIndex = 0; frameIndex < SMART_TURN_FRAMES; frameIndex += 1) {
    const start = frameIndex * HOP_LENGTH;
    const first = padded[start];
    let isConstant = true;
    for (let index = 1; index < N_FFT && isConstant; index += 1)
      isConstant = padded[start + index] === first;
    if (isConstant && constantValue === first) {
      power.set(constantPower);
    } else {
      for (let index = 0; index < N_FFT; index += 1)
        frame[index] = padded[start + index] * HANN[index];
      fftRecursive(frame, 0, 1, N_FFT, specRe, specIm, 0, 0, scratchRe, scratchIm);
      for (let bin = 0; bin < NUM_BINS; bin += 1) power[bin] = specRe[bin] ** 2 + specIm[bin] ** 2;
      if (isConstant) {
        constantValue = first;
        constantPower.set(power);
      }
    }
    for (let mel = 0; mel < SMART_TURN_MELS; mel += 1) {
      let energy = 0;
      const row = mel * NUM_BINS;
      const [firstBin, endBin] = MEL_BIN_RANGES[mel];
      for (let bin = firstBin; bin < endBin; bin += 1)
        energy += MEL_FILTERS[row + bin] * power[bin];
      const value = Math.log10(Math.max(MEL_FLOOR, energy));
      logSpec[mel * SMART_TURN_FRAMES + frameIndex] = value;
      if (value > maxValue) maxValue = value;
    }
  }

  const floor = maxValue - 8;
  for (let index = 0; index < logSpec.length; index += 1) {
    logSpec[index] = (Math.max(logSpec[index], floor) + 4) / 4;
  }
  return logSpec;
}

module.exports = {
  SMART_TURN_SAMPLES,
  SMART_TURN_MELS,
  SMART_TURN_FRAMES,
  prepareSmartTurnAudio,
  whisperLogMel,
};
