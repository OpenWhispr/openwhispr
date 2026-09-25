const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildVoiceWorkerConfig,
  float32ToPcm16Buffer,
  resolveVoiceParakeetModel,
} = require("../../src/helpers/voiceConversationConfig");
const { getVoiceModelPaths } = require("../../src/helpers/voiceModels");

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
  assert.equal(resolveVoiceParakeetModel("parakeet-tdt-0.6b-v3", () => false), "parakeet-tdt-0.6b-v3");
});

test("config uses Pocket and Smart Turn from the voice models directory", () => {
  const modelPaths = getVoiceModelPaths("/m");
  const config = buildVoiceWorkerConfig({ modelPaths });

  assert.equal(config.vad.sileroVad.model, path.join("/m", "silero_vad.onnx"));
  // Smart Turn decides after a 200 ms pause and commits by 1.2 s regardless.
  assert.equal(config.vad.sileroVad.minSilenceDuration, 0.2);
  assert.deepEqual(config.smartTurn, {
    model: path.join("/m", "smart-turn-v3.2-cpu.onnx"),
    maxSilenceMs: 1200,
    threshold: 0.8,
    numThreads: 4,
  });
  assert.equal(config.tts.model.pocket.lmMain, modelPaths.pocket.lmMain);
  assert.equal(config.tts.model.kokoro, undefined);
  assert.equal(config.pocketVoiceWav, modelPaths.pocket.referenceVoiceWav);
  assert.equal(config.ttsKind, undefined);
});

test("float32ToPcm16Buffer clamps and scales samples little-endian", () => {
  const buffer = float32ToPcm16Buffer(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.equal(buffer.length, 12);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((index) => buffer.readInt16LE(index * 2)),
    [0, 32767, -32768, 32767, -32768, 16384]
  );
});
