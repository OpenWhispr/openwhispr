const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");

const EMBEDDING_DIM = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = 16000 * MIN_SEGMENT_SECONDS;
const MODEL_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";

const FBANK_SAMPLE_RATE = 16000;
const FBANK_FRAME_LENGTH_MS = 25;
const FBANK_FRAME_SHIFT_MS = 10;
const FBANK_NUM_MELS = 80;
const FBANK_FRAME_LENGTH = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_LENGTH_MS) / 1000);
const FBANK_FRAME_SHIFT = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_SHIFT_MS) / 1000);
const FBANK_FFT_SIZE = 512;

let _melFilterbank = null;

function getMelFilterbank() {
  if (_melFilterbank) return _melFilterbank;

  const numBins = FBANK_FFT_SIZE / 2 + 1;
  const lowFreq = 20;
  const highFreq = FBANK_SAMPLE_RATE / 2;

  const melLow = 1127 * Math.log(1 + lowFreq / 700);
  const melHigh = 1127 * Math.log(1 + highFreq / 700);

  const melPoints = new Float64Array(FBANK_NUM_MELS + 2);
  for (let i = 0; i < melPoints.length; i++) {
    const mel = melLow + ((melHigh - melLow) * i) / (FBANK_NUM_MELS + 1);
    melPoints[i] = 700 * (Math.exp(mel / 1127) - 1);
  }

  const binPoints = new Float64Array(melPoints.length);
  for (let i = 0; i < melPoints.length; i++) {
    binPoints[i] = Math.floor(((FBANK_FFT_SIZE + 1) * melPoints[i]) / FBANK_SAMPLE_RATE);
  }

  _melFilterbank = new Array(FBANK_NUM_MELS);
  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    const filter = new Float32Array(numBins);
    const left = binPoints[m];
    const center = binPoints[m + 1];
    const right = binPoints[m + 2];

    for (let k = 0; k < numBins; k++) {
      if (k >= left && k <= center && center > left) {
        filter[k] = (k - left) / (center - left);
      } else if (k > center && k <= right && right > center) {
        filter[k] = (right - k) / (right - center);
      }
    }
    _melFilterbank[m] = filter;
  }

  return _melFilterbank;
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
      let curRe = 1,
        curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j],
          uIm = im[i + j];
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

  const hamming = new Float32Array(FBANK_FRAME_LENGTH);
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
    hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FBANK_FRAME_LENGTH - 1));
  }

  const melBank = getMelFilterbank();
  const features = new Float32Array(numFrames * FBANK_NUM_MELS);

  for (let f = 0; f < numFrames; f++) {
    const start = f * FBANK_FRAME_SHIFT;
    const frame = new Float32Array(FBANK_FRAME_LENGTH);
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
      frame[i] = (samples[start + i] || 0) * hamming[i];
    }

    const power = realFFT(frame);

    for (let m = 0; m < FBANK_NUM_MELS; m++) {
      let energy = 0;
      const filter = melBank[m];
      for (let k = 0; k < power.length; k++) {
        energy += filter[k] * power[k];
      }
      features[f * FBANK_NUM_MELS + m] = Math.log(Math.max(energy, 1e-10));
    }
  }

  return { features, numFrames };
}

class SpeakerEmbeddings {
  constructor() {
    this.session = null;
  }

  getModelPath() {
    if (process.resourcesPath) {
      const bundledPath = path.join(process.resourcesPath, "bin", "diarization-models", MODEL_FILE);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(getModelsDirForService("diarization"), MODEL_FILE);
  }

  isAvailable() {
    return fs.existsSync(this.getModelPath());
  }

  async _ensureLoaded() {
    if (this.session) return;

    if (!this.isAvailable()) {
      throw new Error(`Speaker embedding model not found at ${this.getModelPath()}`);
    }

    const modelPath = this.getModelPath();
    debugLogger.debug("speaker-embeddings loading model", { modelPath });

    const ort = require("onnxruntime-node");
    this.session = await ort.InferenceSession.create(modelPath);

    debugLogger.debug("speaker-embeddings model loaded");
  }

  async _extractEmbeddingFromSamples(samples) {
    await this._ensureLoaded();

    const fbank = computeFbank(samples);
    if (!fbank) return null;

    const ort = require("onnxruntime-node");
    const inputName = this.session.inputNames[0];
    const feeds = {
      [inputName]: new ort.Tensor("float32", fbank.features, [1, fbank.numFrames, FBANK_NUM_MELS]),
    };

    const results = await this.session.run(feeds);
    const output = results[Object.keys(results)[0]];

    return new Float32Array(output.data);
  }

  async extractEmbeddingFromSamples(samples) {
    if (samples.length < MIN_SEGMENT_SAMPLES) return null;
    return this._extractEmbeddingFromSamples(samples);
  }

  async extractEmbedding(wavPath, startSec, endSec) {
    if (endSec - startSec < MIN_SEGMENT_SECONDS) return null;

    const buf = fs.readFileSync(wavPath);
    const { sampleRate, dataOffset } = this._parseWavHeader(buf);

    const startSample = Math.floor(startSec * sampleRate);
    const endSample = Math.floor(endSec * sampleRate);
    const numSamples = endSample - startSample;

    const samples = new Float32Array(numSamples);
    const bytesPerSample = 2;
    const offset = dataOffset + startSample * bytesPerSample;

    for (let i = 0; i < numSamples; i++) {
      const bytePos = offset + i * bytesPerSample;
      if (bytePos + 1 >= buf.length) break;
      const int16 = buf.readInt16LE(bytePos);
      samples[i] = int16 / 32768;
    }

    return this._extractEmbeddingFromSamples(samples);
  }

  _parseWavHeader(buf) {
    let offset = 12;
    let sampleRate = 16000;
    let dataOffset = 44;

    while (offset < buf.length - 8) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);

      if (chunkId === "fmt ") {
        sampleRate = buf.readUInt32LE(offset + 12);
      } else if (chunkId === "data") {
        dataOffset = offset + 8;
        break;
      }

      offset += 8 + chunkSize;
    }

    return { sampleRate, dataOffset };
  }

  computeCentroid(embeddings) {
    if (embeddings.length === 0) return new Float32Array(EMBEDDING_DIM);

    const centroid = new Float32Array(EMBEDDING_DIM);
    for (const emb of embeddings) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        centroid[i] += emb[i];
      }
    }
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      centroid[i] /= embeddings.length;
    }
    return centroid;
  }

  cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

const instance = new SpeakerEmbeddings();
module.exports = instance;
module.exports.SpeakerEmbeddings = SpeakerEmbeddings;
