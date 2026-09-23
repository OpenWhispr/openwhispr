// Utility process for the local voice-conversation spike: sherpa-onnx TTS and
// Silero VAD. Native aborts (e.g. an unsupported ORT provider) stay confined here.
const fs = require("fs");
const path = require("path");
const { createTurnEndpointer, createSampleRing } = require("../helpers/voiceTurnEndpointer");
const { createSmartTurnSession } = require("./smartTurnSession");

const VAD_SAMPLE_RATE = 16000;
const FALLBACK_SILENCE_SECONDS = 0.5;

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
let endpointer = null;
let smartTurn = null;
// 8 s classifier context plus pre-roll and headroom.
let micRing = createSampleRing(VAD_SAMPLE_RATE * 10);
let classifyQueue = Promise.resolve();
let latestClassifyId = 0;
let lastClassify = null;
let ttsQueue = Promise.resolve();
const cancelledUtterances = new Set();

function loadSherpa() {
  if (!sherpa) sherpa = require("sherpa-onnx-node");
  return sherpa;
}

function emit(event, payload) {
  port?.postMessage({ event, ...payload });
}

async function loadSmartTurn(smartTurnConfig, vadConfig) {
  smartTurn = null;
  if (!smartTurnConfig) return vadConfig;
  const started = Date.now();
  try {
    smartTurn = await createSmartTurnSession(smartTurnConfig);
    log("info", "smart turn loaded", { loadMs: Date.now() - started });
    return vadConfig;
  } catch (error) {
    // Without the classifier a 200 ms Silero pause would cut turns mid-sentence.
    log("error", "smart turn failed to load; using silence-only turns", { error: error?.message });
    return {
      ...vadConfig,
      sileroVad: { ...vadConfig.sileroVad, minSilenceDuration: FALLBACK_SILENCE_SECONDS },
    };
  }
}

function resetTurnState() {
  vad?.reset();
  vadSpeaking = false;
  endpointer?.reset();
  micRing = createSampleRing(VAD_SAMPLE_RATE * 10);
  latestClassifyId = 0;
}

async function configure({
  tts: ttsConfig,
  pocketVoiceWav,
  vad: requestedVadConfig,
  smartTurn: smartTurnConfig,
}) {
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
  const vadConfig = await loadSmartTurn(smartTurnConfig, requestedVadConfig);
  vad = new lib.Vad(vadConfig, 60);
  endpointer = createTurnEndpointer({
    smartTurn: Boolean(smartTurn),
    sampleRate: VAD_SAMPLE_RATE,
    maxSilenceMs: smartTurnConfig?.maxSilenceMs,
    threshold: smartTurnConfig?.threshold,
  });
  resetTurnState();
  log("info", "configured", {
    loadMs: Date.now() - started,
    sampleRate: tts.sampleRate,
    smartTurn: Boolean(smartTurn),
    minSilenceDuration: vadConfig.sileroVad.minSilenceDuration,
  });
  return {
    sampleRate: tts.sampleRate,
    loadMs: Date.now() - started,
    smartTurn: Boolean(smartTurn),
  };
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

const samplesToMs = (samples) => Math.round((samples / VAD_SAMPLE_RATE) * 1000);

function classify({ requestId, fromSample, toSample }) {
  latestClassifyId = requestId;
  const audio = micRing.slice(fromSample, toSample);
  const run = async () => {
    // A newer pause superseded this one while it waited behind a running call.
    if (requestId !== latestClassifyId || !smartTurn) return;
    let probability = null;
    const samplesBefore = micRing.totalSamples;
    const started = performance.now();
    try {
      const result = await smartTurn.predict(audio);
      probability = result.probability;
      lastClassify = { ...result, audioMs: samplesToMs(audio.length) };
    } catch (error) {
      log("error", "smart turn prediction failed", { error: error?.message });
    }
    // Multithreaded WASM run() blocks this thread, so no mic frames arrive while it
    // runs; stamp the decision with the wall time it took, not the stalled mic clock.
    const elapsedSamples = Math.round(((performance.now() - started) * VAD_SAMPLE_RATE) / 1000);
    const nowSample = Math.max(micRing.totalSamples, samplesBefore + elapsedSamples);
    applyTurnActions(endpointer.onPrediction({ requestId, probability, nowSample }));
  };
  classifyQueue = classifyQueue.then(run, run);
}

function applyTurnActions(actions) {
  for (const action of actions) {
    if (action.type === "classify") {
      classify(action);
    } else if (action.type === "commit") {
      emit("speech-segment", {
        samples: action.samples,
        endpoint: {
          reason: action.reason,
          probability: action.probability,
          segments: action.segments,
          // Speech end to commit, on the mic clock: what the user waits before the pipeline starts.
          endpointMs: samplesToMs(action.commitSample - action.speechEndSample),
          featureMs: action.reason === "silence" ? null : (lastClassify?.featureMs ?? null),
          inferenceMs: action.reason === "silence" ? null : (lastClassify?.inferenceMs ?? null),
        },
      });
      lastClassify = null;
    }
  }
}

function feedVad({ samples }) {
  if (!vad) return;
  micRing.push(samples);
  vad.acceptWaveform(samples);
  const detected = vad.isDetected();
  if (detected && !vadSpeaking) {
    emit("speech-start", {});
    applyTurnActions(endpointer.onSpeechStart());
  }
  vadSpeaking = detected;
  while (!vad.isEmpty()) {
    const segment = vad.front(false);
    vad.pop();
    applyTurnActions(
      endpointer.onSegment({
        samples: new Float32Array(segment.samples),
        startSample: segment.start,
        nowSample: micRing.totalSamples,
      })
    );
  }
  applyTurnActions(endpointer.advance(micRing.totalSamples));
}

const handlers = {
  configure,
  speak,
  cancel: ({ utteranceId }) => {
    cancelledUtterances.add(utteranceId);
    return { cancelled: true };
  },
  "vad-feed": feedVad,
  "vad-reset": resetTurnState,
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
