const fs = require("fs");
const os = require("os");
const path = require("path");

let logStream = null;

function openLog() {
  const logPath = process.env.OPENWHISPR_ONNX_WORKER_LOG;
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  } catch {
    logStream = null;
  }
}

openLog();

const FBANK_SAMPLE_RATE = 16000;
const FBANK_FRAME_LENGTH_MS = 25;
const FBANK_FRAME_SHIFT_MS = 10;
const FBANK_NUM_MELS = 80;
const FBANK_FRAME_LENGTH = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_LENGTH_MS) / 1000);
const FBANK_FRAME_SHIFT = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_SHIFT_MS) / 1000);
const FBANK_FFT_SIZE = 512;

const SPEAKER_MAX_SAMPLES = FBANK_SAMPLE_RATE * 8;

const TEXT_EMBED_MAX_TOKENS = 256;
const TEXT_EMBED_DIM = 384;

const intraOpNumThreads = Math.min(4, Math.max(2, Math.floor((os.cpus()?.length || 4) / 2)));

let port = null;
let ort = null;
let speakerSession = null;
let speakerInputName = null;
let textSession = null;
let textTokenizer = null;
let diarizeSegSession = null;
let diarizeEmbSession = null;

function log(level, message, extra) {
  if (!logStream) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(extra || {}),
  });
  try {
    logStream.write(line + "\n");
  } catch {
    // Best-effort logging; never throw from log path.
  }
}

function loadOrt() {
  if (ort) return;
  ort = require("onnxruntime-node");
  log("info", "ort loaded");
}

const SESSION_OPTIONS = { intraOpNumThreads, executionMode: "sequential" };

function buildGpuSessionOptions() {
  const providers = [];
  if (process.platform === "darwin") {
    providers.push({ name: "CoreMLExecutionProvider" });
  } else if (process.platform === "win32") {
    providers.push({ name: "DmlExecutionProvider" });
  } else {
    providers.push({ name: "CUDAExecutionProvider" });
  }
  providers.push({ name: "CPUExecutionProvider" });
  return { executionProviders: providers, intraOpNumThreads };
}

const DIARIZE_WINDOW_SAMPLES = 160000;
const DIARIZE_WINDOW_SHIFT = 80000;

async function diarizeLoad({ segModelPath, embModelPath }) {
  loadOrt();
  const opts = buildGpuSessionOptions();

  if (!diarizeSegSession && segModelPath) {
    diarizeSegSession = await ort.InferenceSession.create(segModelPath, opts);
    log("info", "diarize segmentation session loaded", { segModelPath });
  }

  if (!diarizeEmbSession && embModelPath) {
    diarizeEmbSession = await ort.InferenceSession.create(embModelPath, opts);
    log("info", "diarize embedding session loaded", { embModelPath });
  }

  return { ok: true };
}

async function diarizeSegment({ samplesBuffer, sampleRate: _sampleRate }) {
  if (!diarizeSegSession) throw new Error("segmentation session not loaded");

  const samples = new Float32Array(samplesBuffer);
  const totalSamples = samples.length;
  const windows = [];

  for (let offset = 0; offset < totalSamples; offset += DIARIZE_WINDOW_SHIFT) {
    const end = Math.min(offset + DIARIZE_WINDOW_SAMPLES, totalSamples);
    const windowSamples = new Float32Array(DIARIZE_WINDOW_SAMPLES);
    windowSamples.set(samples.subarray(offset, end));

    const inputTensor = new ort.Tensor("float32", windowSamples, [1, 1, DIARIZE_WINDOW_SAMPLES]);
    const feeds = { [diarizeSegSession.inputNames[0]]: inputTensor };
    const results = await diarizeSegSession.run(feeds);
    const output = results[diarizeSegSession.outputNames[0]];

    windows.push({
      offset,
      data: Array.from(output.data),
      dims: Array.from(output.dims),
    });
  }

  return { windows };
}

async function diarizeEmbedBatch({ segments }) {
  if (!diarizeEmbSession) throw new Error("embedding session not loaded");

  const embeddings = [];
  const inputName = diarizeEmbSession.inputNames[0];

  for (const seg of segments) {
    const samples = new Float32Array(seg.samplesBuffer);
    const trimmed = samples.length > SPEAKER_MAX_SAMPLES
      ? samples.subarray(samples.length - SPEAKER_MAX_SAMPLES)
      : samples;

    const fbank = computeFbank(trimmed);
    if (!fbank) {
      embeddings.push(null);
      continue;
    }

    const inputTensor = new ort.Tensor("float32", fbank.features, [1, fbank.numFrames, FBANK_NUM_MELS]);
    const results = await diarizeEmbSession.run({ [inputName]: inputTensor });
    const output = results[diarizeEmbSession.outputNames[0]];
    embeddings.push(Array.from(output.data));
  }

  return { embeddings };
}

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

async function speakerLoad({ modelPath }) {
  if (speakerSession) return { ok: true };
  loadOrt();
  speakerSession = await ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  speakerInputName = speakerSession.inputNames[0];
  log("info", "speaker session loaded", { modelPath });
  return { ok: true };
}

async function speakerExtract({ samplesBuffer }) {
  if (!speakerSession) throw new Error("speaker session not loaded");

  const allSamples = new Float32Array(samplesBuffer);
  const samples =
    allSamples.length > SPEAKER_MAX_SAMPLES
      ? allSamples.subarray(allSamples.length - SPEAKER_MAX_SAMPLES)
      : allSamples;

  const fbank = computeFbank(samples);
  if (!fbank) return { embeddingBuffer: null };

  const feeds = {
    [speakerInputName]: new ort.Tensor("float32", fbank.features, [
      1,
      fbank.numFrames,
      FBANK_NUM_MELS,
    ]),
  };
  const results = await speakerSession.run(feeds);
  const output = results[Object.keys(results)[0]];
  const data = new Float32Array(output.data);
  return { embeddingBuffer: data.buffer };
}

function buildTextTokenizer(tokenizerData) {
  const tokenToId = new Map();
  for (const [token, id] of Object.entries(tokenizerData.model.vocab)) {
    tokenToId.set(token, id);
  }
  return {
    tokenToId,
    clsId: tokenToId.get("[CLS]") ?? 101,
    sepId: tokenToId.get("[SEP]") ?? 102,
    unkId: tokenToId.get("[UNK]") ?? 100,
  };
}

function tokenizeText(text) {
  const { tokenToId, clsId, sepId, unkId } = textTokenizer;
  const words = text.toLowerCase().match(/[a-z0-9]+|[^\s\w]/g) || [];
  const tokenIds = [clsId];

  for (const word of words) {
    if (tokenIds.length >= TEXT_EMBED_MAX_TOKENS - 1) break;

    if (tokenToId.has(word)) {
      tokenIds.push(tokenToId.get(word));
      continue;
    }

    let start = 0;
    while (start < word.length) {
      if (tokenIds.length >= TEXT_EMBED_MAX_TOKENS - 1) break;
      let end = word.length;
      let matched = false;
      while (end > start) {
        const subword = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
        if (tokenToId.has(subword)) {
          tokenIds.push(tokenToId.get(subword));
          start = end;
          matched = true;
          break;
        }
        end--;
      }
      if (!matched) {
        tokenIds.push(unkId);
        start++;
      }
    }
  }

  tokenIds.push(sepId);

  const length = tokenIds.length;
  const inputIds = new BigInt64Array(length);
  const attentionMask = new BigInt64Array(length);
  const tokenTypeIds = new BigInt64Array(length);
  for (let i = 0; i < length; i++) {
    inputIds[i] = BigInt(tokenIds[i]);
    attentionMask[i] = 1n;
    tokenTypeIds[i] = 0n;
  }
  return { inputIds, attentionMask, tokenTypeIds, length };
}

function meanPoolAndNormalize(data, tokenCount, dim) {
  const embedding = new Float32Array(dim);
  for (let t = 0; t < tokenCount; t++) {
    const offset = t * dim;
    for (let d = 0; d < dim; d++) {
      embedding[d] += data[offset + d];
    }
  }
  for (let d = 0; d < dim; d++) {
    embedding[d] /= tokenCount;
  }

  let norm = 0;
  for (let d = 0; d < dim; d++) {
    norm += embedding[d] * embedding[d];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < dim; d++) {
      embedding[d] /= norm;
    }
  }
  return embedding;
}

async function textLoad({ modelDir }) {
  if (textSession && textTokenizer) return { ok: true };
  loadOrt();

  const tokenizerData = JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer.json"), "utf-8"));
  textTokenizer = buildTextTokenizer(tokenizerData);

  textSession = await ort.InferenceSession.create(
    path.join(modelDir, "model.onnx"),
    SESSION_OPTIONS
  );
  log("info", "text session loaded", { modelDir });
  return { ok: true };
}

async function textEmbed({ text }) {
  if (!textSession) throw new Error("text session not loaded");

  const { inputIds, attentionMask, tokenTypeIds, length } = tokenizeText(text);
  const feeds = {
    input_ids: new ort.Tensor("int64", inputIds, [1, length]),
    attention_mask: new ort.Tensor("int64", attentionMask, [1, length]),
    token_type_ids: new ort.Tensor("int64", tokenTypeIds, [1, length]),
  };
  const results = await textSession.run(feeds);
  const output = results.last_hidden_state ?? results.output_0;
  const embedding = meanPoolAndNormalize(output.data, length, TEXT_EMBED_DIM);
  return { embeddingBuffer: embedding.buffer };
}

const handlers = {
  ping: () => ({ ok: true, sessions: { speaker: !!speakerSession, text: !!textSession } }),
  "speaker.load": speakerLoad,
  "speaker.extract": speakerExtract,
  "text.load": textLoad,
  "text.embed": textEmbed,
  "diarize.load": diarizeLoad,
  "diarize.segment": diarizeSegment,
  "diarize.embedBatch": diarizeEmbedBatch,
  shutdown: () => {
    log("info", "shutdown requested");
    setImmediate(() => process.exit(0));
    return { ok: true };
  },
};

async function dispatch({ id, method, payload }) {
  const handler = handlers[method];
  if (!handler) {
    return { reply: { id, error: { message: `unknown method: ${method}` } }, transferList: [] };
  }
  try {
    const result = await handler(payload || {});
    const transferList = [];
    if (result?.embeddingBuffer) transferList.push(result.embeddingBuffer);
    return { reply: { id, result }, transferList };
  } catch (err) {
    log("error", "handler threw", { method, error: err?.message, stack: err?.stack });
    return { reply: { id, error: { message: err?.message || String(err) } }, transferList: [] };
  }
}

process.on("uncaughtException", (err) => {
  log("fatal", "uncaughtException", { error: err?.message, stack: err?.stack });
  process.stderr.write(`onnx worker uncaughtException: ${err?.stack || err?.message}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log("fatal", "unhandledRejection", { error: err?.message, stack: err?.stack });
  process.stderr.write(`onnx worker unhandledRejection: ${err?.stack || err?.message}\n`);
  process.exit(1);
});

if (!process.parentPort) {
  process.stderr.write("onnx worker: process.parentPort is undefined\n");
  process.exit(1);
}

process.parentPort.once("message", ({ data, ports }) => {
  if (data === "init" && ports?.length) {
    port = ports[0];
    port.on("message", async (event) => {
      const message = event.data;
      const { reply, transferList } = await dispatch(message);
      port.postMessage(reply, transferList);
    });
    port.on("close", () => {
      log("info", "port closed");
      process.exit(0);
    });
    port.start();
    log("info", "worker initialized", { intraOpNumThreads });
  }
});

log("info", "worker boot", { intraOpNumThreads, pid: process.pid });
