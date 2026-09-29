const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildVoiceWorkerConfig,
  float32ToPcm16Buffer,
  resolveVoiceParakeetModel,
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

test("keeps the requested Parakeet model when it is downloaded", () => {
  const downloaded = new Set(["parakeet-tdt-0.6b-v3", "parakeet-unified-en-0.6b"]);
  assert.equal(
    resolveVoiceParakeetModel("parakeet-tdt-0.6b-v3", (name) => downloaded.has(name)),
    "parakeet-tdt-0.6b-v3"
  );
});

test("falls back to the first downloaded candidate when the requested model is missing", () => {
  const downloaded = new Set(["parakeet-unified-en-0.6b"]);
  assert.equal(
    resolveVoiceParakeetModel("parakeet-tdt-0.6b-v3", (name) => downloaded.has(name)),
    "parakeet-unified-en-0.6b"
  );
  assert.equal(
    resolveVoiceParakeetModel(undefined, (name) => downloaded.has(name)),
    "parakeet-unified-en-0.6b"
  );
});

test("returns the requested model when nothing is downloaded, so the error names it", () => {
  assert.equal(
    resolveVoiceParakeetModel("parakeet-tdt-0.6b-v3", () => false),
    "parakeet-tdt-0.6b-v3"
  );
});

test("config uses Supertonic voice F2 and Smart Turn from the voice models directory", () => {
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
  // F2 at 5 steps: fewer steps sounded distorted.
  assert.deepEqual(config.ttsGeneration, { sid: 1, numSteps: 5, extra: { lang: "en" } });
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
