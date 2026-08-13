// Kaldi-compatible log-mel filterbank features for the 3D-Speaker CAMPPlus
// speaker-embedding model. The model was trained on kaldi fbank + per-utterance
// mean normalization (3D-Speaker FBank mean_nor=True), so the preprocessing here
// mirrors that exactly: per-frame DC-offset removal, 0.97 pre-emphasis, a Povey
// window, triangular mel filters evaluated in mel-frequency space, and CMN.
//
// Any change that alters the produced feature/embedding space MUST bump
// EMBEDDING_VERSION in src/constants/speakerDetection.json so stored embeddings
// are re-enrolled instead of matched cross-space.

const FBANK_SAMPLE_RATE = 16000;
const FBANK_FRAME_LENGTH_MS = 25;
const FBANK_FRAME_SHIFT_MS = 10;
const FBANK_NUM_MELS = 80;
const FBANK_FRAME_LENGTH = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_LENGTH_MS) / 1000);
const FBANK_FRAME_SHIFT = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_SHIFT_MS) / 1000);
const FBANK_FFT_SIZE = 512;
const FBANK_LOW_FREQ = 20;
const FBANK_PREEMPH_COEFF = 0.97;
// Kaldi floors mel energies at float epsilon before taking the log.
const FBANK_ENERGY_FLOOR = 1.1920929e-7;

function hzToMel(freq) {
  return 1127 * Math.log(1 + freq / 700);
}

let _melFilterbank = null;
function getMelFilterbank() {
  if (_melFilterbank) return _melFilterbank;

  const numBins = FBANK_FFT_SIZE / 2 + 1;
  const highFreq = FBANK_SAMPLE_RATE / 2;
  const melLow = hzToMel(FBANK_LOW_FREQ);
  const melHigh = hzToMel(highFreq);
  const melDelta = (melHigh - melLow) / (FBANK_NUM_MELS + 1);

  // Mel frequency of each FFT bin center. Kaldi evaluates the triangular filters
  // in mel space at each bin's true frequency rather than snapping to bin indices.
  const binMel = new Float64Array(numBins);
  for (let k = 0; k < numBins; k++) {
    binMel[k] = hzToMel((k * FBANK_SAMPLE_RATE) / FBANK_FFT_SIZE);
  }

  _melFilterbank = new Array(FBANK_NUM_MELS);
  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    const leftMel = melLow + m * melDelta;
    const centerMel = melLow + (m + 1) * melDelta;
    const rightMel = melLow + (m + 2) * melDelta;
    const filter = new Float32Array(numBins);
    for (let k = 0; k < numBins; k++) {
      const mel = binMel[k];
      if (mel <= leftMel || mel >= rightMel) continue;
      filter[k] =
        mel <= centerMel
          ? (mel - leftMel) / (centerMel - leftMel)
          : (rightMel - mel) / (rightMel - centerMel);
    }
    _melFilterbank[m] = filter;
  }

  return _melFilterbank;
}

let _poveyWindow = null;
function getPoveyWindow() {
  if (_poveyWindow) return _poveyWindow;
  const window = new Float32Array(FBANK_FRAME_LENGTH);
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
    window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FBANK_FRAME_LENGTH - 1)), 0.85);
  }
  _poveyWindow = window;
  return _poveyWindow;
}

function realFFT(frame) {
  const n = FBANK_FFT_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < frame.length && i < n; i++) re[i] = frame[i];

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const tmpRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmpRe;
      }
    }
  }

  const numBins = n / 2 + 1;
  const powerSpectrum = new Float32Array(numBins);
  for (let i = 0; i < numBins; i++) {
    powerSpectrum[i] = re[i] * re[i] + im[i] * im[i];
  }
  return powerSpectrum;
}

function computeFbank(samples) {
  const numFrames = Math.max(
    0,
    Math.floor((samples.length - FBANK_FRAME_LENGTH) / FBANK_FRAME_SHIFT) + 1
  );
  if (numFrames === 0) return null;

  const window = getPoveyWindow();
  const melBank = getMelFilterbank();
  const features = new Float32Array(numFrames * FBANK_NUM_MELS);
  const frame = new Float32Array(FBANK_FRAME_LENGTH);

  for (let f = 0; f < numFrames; f++) {
    const start = f * FBANK_FRAME_SHIFT;
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
      frame[i] = samples[start + i] || 0;
    }

    // Kaldi window processing order: remove DC offset, pre-emphasize, then window.
    let mean = 0;
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) mean += frame[i];
    mean /= FBANK_FRAME_LENGTH;
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) frame[i] -= mean;

    for (let i = FBANK_FRAME_LENGTH - 1; i > 0; i--) {
      frame[i] -= FBANK_PREEMPH_COEFF * frame[i - 1];
    }
    frame[0] -= FBANK_PREEMPH_COEFF * frame[0];

    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) frame[i] *= window[i];

    const power = realFFT(frame);
    for (let m = 0; m < FBANK_NUM_MELS; m++) {
      let energy = 0;
      const filter = melBank[m];
      for (let k = 0; k < power.length; k++) {
        energy += filter[k] * power[k];
      }
      features[f * FBANK_NUM_MELS + m] = Math.log(Math.max(energy, FBANK_ENERGY_FLOOR));
    }
  }

  // Per-utterance cepstral mean normalization (3D-Speaker FBank mean_nor=True):
  // subtract each mel band's mean over time. This is what makes the embedding
  // invariant to overall loudness/channel and keeps CAMPPlus on its training
  // distribution — without it embeddings collapse into a narrow, non-discriminative cone.
  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    let mean = 0;
    for (let f = 0; f < numFrames; f++) mean += features[f * FBANK_NUM_MELS + m];
    mean /= numFrames;
    for (let f = 0; f < numFrames; f++) features[f * FBANK_NUM_MELS + m] -= mean;
  }

  return { features, numFrames };
}

module.exports = {
  computeFbank,
  FBANK_SAMPLE_RATE,
  FBANK_FRAME_LENGTH,
  FBANK_FRAME_SHIFT,
  FBANK_NUM_MELS,
  FBANK_FFT_SIZE,
};
