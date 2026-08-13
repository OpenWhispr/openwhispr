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

const { computeFbank, FBANK_SAMPLE_RATE, FBANK_NUM_MELS } = require("./speakerFbank");

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
    // MessagePortMain transfers only ports, not ArrayBuffers — clone the result buffers instead.
    return { reply: { id, result }, transferList: [] };
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
