const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildVoiceWorkerConfig,
  resolveTtsKind,
  float32ToPcm16Buffer,
  resolveSpikeParakeetModel,
} = require("../../src/helpers/voiceSpikeConfig");

test("keeps the requested Parakeet model when it is downloaded", () => {
  const downloaded = new Set(["parakeet-tdt-0.6b-v3", "parakeet-unified-en-0.6b"]);
  assert.equal(
    resolveSpikeParakeetModel("parakeet-tdt-0.6b-v3", (name) => downloaded.has(name)),
    "parakeet-tdt-0.6b-v3"
  );
});

test("falls back to the first downloaded candidate when the requested model is missing", () => {
  const downloaded = new Set(["parakeet-unified-en-0.6b"]);
  assert.equal(
    resolveSpikeParakeetModel("parakeet-tdt-0.6b-v3", (name) => downloaded.has(name)),
    "parakeet-unified-en-0.6b"
  );
  assert.equal(
    resolveSpikeParakeetModel(undefined, (name) => downloaded.has(name)),
    "parakeet-unified-en-0.6b"
  );
});

test("returns the requested model when nothing is downloaded, so the error names it", () => {
  assert.equal(resolveSpikeParakeetModel("parakeet-tdt-0.6b-v3", () => false), "parakeet-tdt-0.6b-v3");
});

const CACHE = "/cache/openwhispr";

test("defaults to Kokoro fp32 with espeak data and a 500 ms end-of-turn silence", () => {
  const config = buildVoiceWorkerConfig({ cacheDir: CACHE });
  const kokoro = config.tts.model.kokoro;
  const dir = path.join(CACHE, "tts-models", "kokoro-en-v0_19");
  assert.equal(kokoro.model, path.join(dir, "model.onnx"));
  assert.equal(kokoro.dataDir, path.join(dir, "espeak-ng-data"));
  assert.equal(config.tts.model.provider, "cpu");
  assert.equal(config.pocketVoiceWav, undefined);
  assert.equal(config.vad.sileroVad.model, path.join(CACHE, "vad-models", "silero_vad.onnx"));
  assert.equal(config.vad.sileroVad.minSilenceDuration, 0.5);
  assert.equal(config.vad.sampleRate, 16000);
});

test("pocket uses its six ONNX parts and a reference voice clip", () => {
  const config = buildVoiceWorkerConfig({ cacheDir: CACHE, ttsKind: "pocket" });
  const dir = path.join(CACHE, "tts-models", "sherpa-onnx-pocket-tts-int8-2026-01-26");
  assert.equal(config.tts.model.pocket.lmMain, path.join(dir, "lm_main.int8.onnx"));
  assert.equal(config.tts.model.pocket.tokenScoresJson, path.join(dir, "token_scores.json"));
  assert.equal(config.pocketVoiceWav, path.join(dir, "test_wavs", "bria.wav"));
  assert.equal(config.tts.model.kokoro, undefined);
});

test("kitten uses the int8 nano model", () => {
  const config = buildVoiceWorkerConfig({ cacheDir: CACHE, ttsKind: "kitten" });
  assert.equal(
    config.tts.model.kitten.model,
    path.join(CACHE, "tts-models", "kitten-nano-en-v0_8-int8", "model.int8.onnx")
  );
});

test("silence override is clamped to a sane range", () => {
  assert.equal(buildVoiceWorkerConfig({ cacheDir: CACHE, silenceMs: 250 }).vad.sileroVad.minSilenceDuration, 0.25);
  assert.equal(buildVoiceWorkerConfig({ cacheDir: CACHE, silenceMs: 10 }).vad.sileroVad.minSilenceDuration, 0.15);
  assert.equal(buildVoiceWorkerConfig({ cacheDir: CACHE, silenceMs: 9000 }).vad.sileroVad.minSilenceDuration, 2);
});

test("resolveTtsKind accepts known kinds and falls back to kokoro", () => {
  assert.equal(resolveTtsKind("pocket"), "pocket");
  assert.equal(resolveTtsKind(" Kitten "), "kitten");
  assert.equal(resolveTtsKind("bogus"), "kokoro");
  assert.equal(resolveTtsKind(undefined), "kokoro");
});

test("float32ToPcm16Buffer clamps and scales samples little-endian", () => {
  const buffer = float32ToPcm16Buffer(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.equal(buffer.length, 12);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((index) => buffer.readInt16LE(index * 2)),
    [0, 32767, -32768, 32767, -32768, 16384]
  );
});

test("smart turn is off by default", () => {
  assert.equal(buildVoiceWorkerConfig({ cacheDir: CACHE }).smartTurn, null);
});

test("smart turn shortens Silero's silence to 200 ms and adds the classifier config", () => {
  const config = buildVoiceWorkerConfig({ cacheDir: CACHE, smartTurn: true });
  assert.equal(config.vad.sileroVad.minSilenceDuration, 0.2);
  assert.deepEqual(config.smartTurn, {
    model: path.join(CACHE, "turn-models", "smart-turn-v3.2-cpu.onnx"),
    maxSilenceMs: 1200,
    threshold: 0.8,
    numThreads: 4,
  });
});

test("smart turn honours explicit silence and max-silence overrides", () => {
  const config = buildVoiceWorkerConfig({
    cacheDir: CACHE,
    smartTurn: true,
    silenceMs: "300",
    smartTurnMaxSilenceMs: "900",
  });
  assert.equal(config.vad.sileroVad.minSilenceDuration, 0.3);
  assert.equal(config.smartTurn.maxSilenceMs, 900);
});

test("smart turn max silence never drops below Silero's pause", () => {
  const config = buildVoiceWorkerConfig({
    cacheDir: CACHE,
    smartTurn: true,
    smartTurnMaxSilenceMs: 50,
  });
  assert.equal(config.smartTurn.maxSilenceMs, 200);
});
