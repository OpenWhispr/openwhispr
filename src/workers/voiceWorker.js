// Utility process for the local voice-conversation spike: sherpa-onnx TTS and
// Silero VAD. Native aborts (e.g. an unsupported ORT provider) stay confined here.
const fs = require("fs");
const path = require("path");

let logStream = null;
try {
  const logPath = process.env.OPENWHISPR_VOICE_WORKER_LOG;
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  }
} catch {
  logStream = null;
}

function log(level, message, extra) {
  if (!logStream) return;
  try {
    logStream.write(
      JSON.stringify({ ts: new Date().toISOString(), level, message, ...(extra || {}) }) + "\n"
    );
  } catch {
    // Logging is best effort.
  }
}

let sherpa = null;
let port = null;
let tts = null;
let ttsRequestExtras = {};
let vad = null;
let vadSpeaking = false;
let ttsQueue = Promise.resolve();
const cancelledUtterances = new Set();

function loadSherpa() {
  if (!sherpa) sherpa = require("sherpa-onnx-node");
  return sherpa;
}

function emit(event, payload) {
  port?.postMessage({ event, ...payload });
}

async function configure({ tts: ttsConfig, pocketVoiceWav, vad: vadConfig }) {
  const lib = loadSherpa();
  const started = Date.now();
  tts = await lib.OfflineTts.createAsync(ttsConfig);
  ttsRequestExtras = {};
  if (pocketVoiceWav) {
    // Electron's V8 sandbox rejects external buffers, so every buffer is copied.
    const wave = lib.readWave(pocketVoiceWav, false);
    ttsRequestExtras.generationConfig = new lib.GenerationConfig({
      referenceAudio: wave.samples,
      referenceSampleRate: wave.sampleRate,
    });
  }
  vad = new lib.Vad(vadConfig, 60);
  vadSpeaking = false;
  log("info", "configured", { loadMs: Date.now() - started, sampleRate: tts.sampleRate });
  return { sampleRate: tts.sampleRate, loadMs: Date.now() - started };
}

function speak({ utteranceId, chunkIndex, text }) {
  const receivedAt = Date.now();
  const run = async () => {
    if (!tts) throw new Error("voice worker not configured");
    if (cancelledUtterances.has(utteranceId)) return { cancelled: true };
    const started = Date.now();
    // Time spent behind earlier chunks (e.g. a cancelled answer's in-flight chunk).
    const queueWaitMs = started - receivedAt;
    let streamedSamples = 0;
    let firstAudioMs = null;
    const audio = await tts.generateAsync({
      text,
      sid: 0,
      speed: 1.0,
      enableExternalBuffer: false,
      ...ttsRequestExtras,
      onProgress: (info) => {
        if (cancelledUtterances.has(utteranceId)) return 0;
        if (info.samples?.length) {
          if (firstAudioMs === null) firstAudioMs = Date.now() - started;
          const samples = new Float32Array(info.samples);
          streamedSamples += samples.length;
          emit("tts-audio", { utteranceId, chunkIndex, samples });
        }
        return 1;
      },
    });
    if (cancelledUtterances.has(utteranceId)) return { cancelled: true };
    // Non-streaming models may report the audio only in the result.
    if (streamedSamples === 0 && audio.samples?.length) {
      firstAudioMs = Date.now() - started;
      const samples = new Float32Array(audio.samples);
      emit("tts-audio", { utteranceId, chunkIndex, samples });
    }
    return { queueWaitMs, firstAudioMs, totalMs: Date.now() - started, sampleRate: audio.sampleRate };
  };
  const result = ttsQueue.then(run, run);
  ttsQueue = result.catch(() => {});
  return result;
}

function feedVad({ samples }) {
  if (!vad) return;
  vad.acceptWaveform(samples);
  const detected = vad.isDetected();
  if (detected && !vadSpeaking) emit("speech-start", {});
  vadSpeaking = detected;
  while (!vad.isEmpty()) {
    const segment = vad.front(false);
    vad.pop();
    const copy = new Float32Array(segment.samples);
    emit("speech-segment", { samples: copy, startSample: segment.start });
  }
}

const handlers = {
  configure,
  speak,
  cancel: ({ utteranceId }) => {
    cancelledUtterances.add(utteranceId);
    return { cancelled: true };
  },
  "vad-feed": feedVad,
  "vad-reset": () => {
    vad?.reset();
    vadSpeaking = false;
  },
};

async function onMessage({ id, method, payload }) {
  if (method === "shutdown") {
    process.exit(0);
  }
  const handler = handlers[method];
  try {
    if (!handler) throw new Error(`unknown method ${method}`);
    const result = await handler(payload || {});
    if (id) port.postMessage({ id, result });
  } catch (error) {
    log("error", "request failed", { method, error: error?.message });
    if (id) port.postMessage({ id, error: { message: error?.message || String(error) } });
  }
}

if (!process.parentPort) {
  process.stderr.write("voice worker: process.parentPort is undefined\n");
  process.exit(1);
}

process.parentPort.once("message", ({ ports }) => {
  port = ports[0];
  port.on("message", (event) => {
    void onMessage(event.data);
  });
  port.on("close", () => process.exit(0));
  port.start();
});
