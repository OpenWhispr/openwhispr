const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildVoiceWorkerConfig,
  float32ToPcm16Buffer,
  resolveCallRecognizer,
  toSpeechProfile,
} = require("../../src/helpers/voiceConversationConfig");
const { getVoiceModelPaths } = require("../../src/helpers/voiceModels");
const { createConfiguredTurnEndpointer } = require("../../src/helpers/voiceTurnEndpointer");

const ms = (value) => (value * 16000) / 1000;
const segment = (startMs, lengthMs) => ({
  startSample: ms(startMs),
  samples: new Float32Array(ms(lengthMs)),
});
const workerEndpointer = (classifierLoaded) =>
  createConfiguredTurnEndpointer({
    smartTurnConfig: buildVoiceWorkerConfig({ modelPaths: getVoiceModelPaths("/m") }).smartTurn,
    classifierLoaded,
  });

const PARAKEET_MODELS = [
  { id: "parakeet-tdt-0.6b-v3", supportedLanguages: ["en", "es", "fr", "de"] },
  { id: "parakeet-unified-en-0.6b", supportedLanguages: ["en"] },
  { id: "nemotron-3.5-asr-streaming-0.6b", supportedLanguages: ["en", "es", "hi"] },
  {
    id: "cohere-transcribe-03-2026",
    supportedLanguages: ["en", "es", "fr", "de"],
    modelType: "cohere-transcribe",
  },
];
const recognize = (language, { parakeet = [], whisper = [], preferredParakeet } = {}) =>
  resolveCallRecognizer(language, {
    parakeetModels: PARAKEET_MODELS,
    preferredParakeet,
    isParakeetDownloaded: (name) => parakeet.includes(name),
    whisperModels: ["turbo", "base"],
    isWhisperDownloaded: (name) => whisper.includes(name),
  });

test("a call hears its language with the model dictation runs when that model knows it", () => {
  const downloaded = { parakeet: ["parakeet-tdt-0.6b-v3", "parakeet-unified-en-0.6b"] };
  assert.equal(
    recognize("en", { ...downloaded, preferredParakeet: "parakeet-unified-en-0.6b" }).model,
    "parakeet-unified-en-0.6b"
  );
  assert.equal(
    recognize("es", { ...downloaded, preferredParakeet: "parakeet-unified-en-0.6b" }).model,
    "parakeet-tdt-0.6b-v3",
    "an English-only model can't hear Spanish"
  );
});

test("Hindi uses a Parakeet model that knows it, else the first downloaded Whisper model", () => {
  assert.deepEqual(recognize("hi", { parakeet: ["nemotron-3.5-asr-streaming-0.6b"] }), {
    engine: "parakeet",
    model: "nemotron-3.5-asr-streaming-0.6b",
    language: undefined,
  });
  assert.deepEqual(recognize("hi", { whisper: ["base", "turbo"] }), {
    engine: "whisper",
    model: "turbo",
    language: "hi",
  });
  assert.equal(recognize("hi", { parakeet: ["parakeet-tdt-0.6b-v3"] }), null);
});

test("Cohere hears a fixed language, started for it, but never Auto", () => {
  const cohere = { parakeet: ["cohere-transcribe-03-2026"] };
  assert.deepEqual(recognize("fr", cohere), {
    engine: "parakeet",
    model: "cohere-transcribe-03-2026",
    language: "fr",
  });
  assert.equal(recognize("auto", cohere), null);
  assert.equal(recognize("auto", { whisper: ["base"] }), null, "Auto never falls to Whisper");
});

test("config uses Smart Turn from the voice models directory and 5 flow steps", () => {
  const modelPaths = getVoiceModelPaths("/m");
  const config = buildVoiceWorkerConfig({ modelPaths });

  assert.equal(config.vad.sileroVad.model, path.join("/m", "silero_vad.onnx"));
  // Smart Turn decides after a 200 ms pause and commits by 1.2 s regardless.
  assert.equal(config.vad.sileroVad.minSilenceDuration, 0.2);
  assert.deepEqual(config.smartTurn, {
    model: path.join("/m", "smart-turn-v3.2-cpu.onnx"),
    maxSilenceMs: 1200,
    maxTurnMs: 30000,
    threshold: 0.8,
    numThreads: 4,
  });
  assert.deepEqual(config.tts.model.supertonic, modelPaths.supertonic);
  assert.equal(config.tts.model.numThreads, 2);
  assert.equal(config.numSteps, 5);
});

test("a speech profile maps the voice to its speaker and keeps rate and language in range", () => {
  assert.deepEqual(toSpeechProfile({ voice: "helios", speed: 1, language: "en" }), {
    sid: 5,
    speed: 1,
    lang: "en",
  });
  assert.deepEqual(toSpeechProfile({ voice: "aurora", speed: 0.6, language: "hi" }), {
    sid: 1,
    speed: 0.5,
    lang: "hi",
  });
  // Anything else falls back to the default voice, a 2× cap, and English.
  assert.deepEqual(toSpeechProfile({ voice: "zeus", speed: 9, language: "auto" }), {
    sid: 5,
    speed: 2,
    lang: "en",
  });
  assert.deepEqual(toSpeechProfile({ speed: "fast" }), { sid: 5, speed: 1, lang: "en" });
});

test("the worker's endpointer commits a Smart Turn endpoint only above 0.8", () => {
  const endpointer = workerEndpointer(true);
  const [first] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  assert.deepEqual(
    endpointer.onPrediction({ requestId: first.requestId, probability: 0.79, nowSample: ms(2050) }),
    []
  );
  endpointer.onSpeechStart();
  const [second] = endpointer.onSegment({ ...segment(2400, 600), nowSample: ms(3200) });
  const [commit] = endpointer.onPrediction({
    requestId: second.requestId,
    probability: 0.81,
    nowSample: ms(3250),
  });
  assert.equal(commit.reason, "smart-turn");
});

test("the worker's endpointer commits by 1.2 s of silence", () => {
  const endpointer = workerEndpointer(true);
  endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  assert.deepEqual(endpointer.advance(ms(2999)), []);
  assert.equal(endpointer.advance(ms(3000))[0].reason, "max-silence");
});

test("the worker's endpointer caps a turn at 30 s of speech", () => {
  const endpointer = workerEndpointer(true);
  assert.equal(
    endpointer.onSegment({ ...segment(0, 20000), nowSample: ms(20200) })[0].type,
    "classify"
  );
  endpointer.onSpeechStart();
  const [commit] = endpointer.onSegment({ ...segment(21000, 10000), nowSample: ms(31200) });
  assert.equal(commit.reason, "max-turn");
});

test("without the classifier the worker's endpointer commits every pause", () => {
  const endpointer = workerEndpointer(false);
  const [commit] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  assert.equal(commit.reason, "silence");
});

test("float32ToPcm16Buffer clamps and scales samples little-endian", () => {
  const buffer = float32ToPcm16Buffer(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.equal(buffer.length, 12);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((index) => buffer.readInt16LE(index * 2)),
    [0, 32767, -32768, 32767, -32768, 16384]
  );
});
