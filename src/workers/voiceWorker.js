// Utility process for local voice conversation: sherpa-onnx TTS and
// Silero VAD. Native aborts (e.g. an unsupported ORT provider) stay confined here.
const fs = require("fs");
const path = require("path");
const {
  createTurnEndpointer,
  createSampleRing,
  withPreRoll,
} = require("../helpers/voiceTurnEndpointer");
const { createSmartTurnSession } = require("./smartTurnSession");
const { createPreparedSpeech } = require("./preparedSpeech");
const { trimSilence } = require("./trimSilence");
const { timeStretch } = require("./timeStretch");
const { speechProfileKey } = require("../helpers/voiceConversationConfig");

const VAD_SAMPLE_RATE = 16000;
const FALLBACK_SILENCE_SECONDS = 0.5;
const PRE_ROLL_SAMPLES = Math.round(VAD_SAMPLE_RATE * 0.3);
// Holds a whole multi-segment turn so its pre-roll survives; also the classifier's 8 s.
const MIC_RING_SAMPLES = VAD_SAMPLE_RATE * 30;

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
let numSteps = 5;
let vad = null;
let vadSpeaking = false;
// The renderer paused a reply for the user's speech: a short turn ends at its first pause.
let replyHeld = false;
let endpointer = null;
let smartTurn = null;
let micRing = createSampleRing(MIC_RING_SAMPLES);
let classifyQueue = Promise.resolve();
let latestClassifyId = 0;
let lastClassify = null;
let ttsQueue = Promise.resolve();
const cancelledUtterances = new Set();

// One TTS instance, so every synthesis (answers and prepared lines) runs in order.
function enqueueTts(run) {
  const result = ttsQueue.then(run, run);
  ttsQueue = result.catch(() => {});
  return result;
}

// Supertonic speeds up less than asked above 1x and drops words from 1.5x (most of
// them at 2x), so a faster rate synthesizes at 1x and is time-stretched to the rate.
const MAX_MODEL_SPEED = 1;

// Speaker, rate and language ride on every request, so one worker speaks any profile.
const generationRequest = ({ sid, speed, lang }) => {
  const modelSpeed = Math.min(speed, MAX_MODEL_SPEED);
  return {
    sid,
    speed: modelSpeed,
    generationConfig: new sherpa.GenerationConfig({
      sid,
      speed: modelSpeed,
      numSteps,
      extra: { lang },
    }),
  };
};

// What plays: the synthesized clip without its padding, at the profile's full rate.
const playable = (samples, sampleRate, { speed }) =>
  timeStretch(
    trimSilence(samples, sampleRate),
    speed / Math.min(speed, MAX_MODEL_SPEED),
    sampleRate
  );

const preparedSpeech = createPreparedSpeech({
  synthesize: (text, profile) =>
    enqueueTts(async () => {
      const audio = await tts.generateAsync({
        text,
        enableExternalBuffer: false,
        ...generationRequest(profile),
      });
      return playable(audio.samples, audio.sampleRate, profile);
    }),
  onError: (error) => log("warn", "speech preparation failed", { error: error?.message }),
});

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
  replyHeld = false;
  endpointer?.reset();
  micRing = createSampleRing(MIC_RING_SAMPLES);
  latestClassifyId = 0;
  lastClassify = null;
}

async function configure({
  tts: ttsConfig,
  numSteps: steps,
  vad: requestedVadConfig,
  smartTurn: smartTurnConfig,
}) {
  const lib = loadSherpa();
  const started = Date.now();
  tts = await lib.OfflineTts.createAsync(ttsConfig);
  preparedSpeech.clear();
  numSteps = steps;
  const vadConfig = await loadSmartTurn(smartTurnConfig, requestedVadConfig);
  vad = new lib.Vad(vadConfig, 60);
  const { maxSilenceMs, maxTurnMs, threshold } = smartTurnConfig || {};
  endpointer = createTurnEndpointer({
    smartTurn: Boolean(smartTurn),
    maxSilenceMs,
    maxTurnMs,
    threshold,
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

function speak({ utteranceId, chunkIndex, text, profile }) {
  const receivedAt = Date.now();
  const run = async () => {
    if (!tts) throw new Error("voice worker not configured");
    if (cancelledUtterances.has(utteranceId)) return { cancelled: true };
    const started = Date.now();
    // Time spent behind earlier chunks (e.g. a cancelled answer's in-flight chunk).
    const queueWaitMs = started - receivedAt;
    const prepared = preparedSpeech.get(text, speechProfileKey(profile));
    if (prepared) {
      emit("tts-audio", { utteranceId, chunkIndex, samples: prepared });
      return { queueWaitMs, firstAudioMs: 0, totalMs: 0, sampleRate: tts.sampleRate };
    }
    let streamedSamples = 0;
    let firstAudioMs = null;
    const audio = await tts.generateAsync({
      text,
      // Electron's V8 sandbox rejects external buffers, so the audio is copied.
      enableExternalBuffer: false,
      ...generationRequest(profile),
      onProgress: (info) => {
        if (cancelledUtterances.has(utteranceId)) return 0;
        if (info.samples?.length) {
          if (firstAudioMs === null) firstAudioMs = Date.now() - started;
          const samples = playable(info.samples, tts.sampleRate, profile);
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
      const samples = playable(audio.samples, audio.sampleRate, profile);
      emit("tts-audio", { utteranceId, chunkIndex, samples });
    }
    return {
      queueWaitMs,
      firstAudioMs,
      totalMs: Date.now() - started,
      sampleRate: audio.sampleRate,
    };
  };
  preparedSpeech.speakStarted();
  return enqueueTts(run).finally(() => preparedSpeech.speakEnded());
}

const samplesToMs = (samples) => Math.round((samples / VAD_SAMPLE_RATE) * 1000);

function classify({ requestId, fromSample, toSample }) {
  latestClassifyId = requestId;
  const audio = micRing.slice(fromSample, toSample);
  const run = async () => {
    // A newer pause superseded this one while it waited behind a running call.
    if (requestId !== latestClassifyId || !smartTurn) return;
    let probability = null;
    // A failed prediction must not report the timings of an earlier one.
    lastClassify = null;
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
        samples: withPreRoll({
          ring: micRing,
          turnStartSample: action.turnStartSample,
          samples: action.samples,
          preRollSamples: PRE_ROLL_SAMPLES,
        }),
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
        quick: replyHeld,
      })
    );
  }
  applyTurnActions(endpointer.advance(micRing.totalSamples));
}

const handlers = {
  configure,
  speak,
  "prepare-speech": ({ texts, profile }) => {
    if (tts) preparedSpeech.prepare(texts, profile, speechProfileKey(profile));
    return { queued: tts ? texts.length : 0 };
  },
  cancel: ({ utteranceId }) => {
    cancelledUtterances.add(utteranceId);
    // Every chunk of the utterance is queued ahead of this cancel; once they drain, the id is dead.
    void ttsQueue.then(() => cancelledUtterances.delete(utteranceId));
    return { cancelled: true };
  },
  "vad-feed": feedVad,
  "vad-reset": resetTurnState,
  "reply-held": ({ held }) => {
    replyHeld = held === true;
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
