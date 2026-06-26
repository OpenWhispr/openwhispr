const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer");

test("buildWhisperServerArgs includes VAD flags when enabled and model path provided", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
    vadEnabled: true,
    vadModelPath: "/tmp/ggml-silero-v5.1.2.bin",
    vadConfig: {
      threshold: 0.3,
      minSpeechDurationMs: 180,
      minSilenceDurationMs: 250,
      maxSpeechDurationS: 24,
      speechPadMs: 120,
      samplesOverlap: 0.42,
    },
  });

  assert.deepEqual(args, [
    "--model",
    "/tmp/model.bin",
    "--host",
    "127.0.0.1",
    "--port",
    "8180",
    "--language",
    "auto",
    "--vad",
    "--vad-model",
    "/tmp/ggml-silero-v5.1.2.bin",
    "--vad-threshold",
    "0.3",
    "--vad-min-speech-duration-ms",
    "180",
    "--vad-min-silence-duration-ms",
    "250",
    "--vad-max-speech-duration-s",
    "24",
    "--vad-speech-pad-ms",
    "120",
    "--vad-samples-overlap",
    "0.42",
  ]);
});

test("buildWhisperServerArgs omits VAD flags when vadModelPath is missing", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
    vadEnabled: true,
    vadModelPath: null,
  });

  assert.equal(args.includes("--vad"), false);
  assert.equal(args.includes("--vad-model"), false);
});

test("buildWhisperServerArgs includes thread count when provided", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
    threads: 10,
  });

  assert.deepEqual(args.slice(0, 8), [
    "--model",
    "/tmp/model.bin",
    "--host",
    "127.0.0.1",
    "--port",
    "8180",
    "--threads",
    "10",
  ]);
});

test("resolveWhisperThreads keeps whisper.cpp default on small machines", () => {
  const result = WhisperServerManager.resolveWhisperThreads(
    {},
    { availableParallelism: 4, env: {} }
  );

  assert.equal(result.threads, null);
  assert.equal(result.source, "default");
  assert.equal(result.availableParallelism, 4);
});

test("resolveWhisperThreads auto-selects a conservative count", () => {
  const result = WhisperServerManager.resolveWhisperThreads(
    {},
    { availableParallelism: 14, env: {} }
  );

  assert.equal(result.threads, 10);
  assert.equal(result.source, "auto");
  assert.equal(result.availableParallelism, 14);
});

test("resolveWhisperThreads caps automatic and manual thread counts", () => {
  const auto = WhisperServerManager.resolveWhisperThreads(
    {},
    { availableParallelism: 64, env: {} }
  );
  const manual = WhisperServerManager.resolveWhisperThreads(
    {},
    { availableParallelism: 64, env: { WHISPER_THREADS: "128" } }
  );

  assert.equal(auto.threads, 12);
  assert.equal(manual.threads, 64);
});

test("resolveWhisperThreads lets explicit options override env and auto", () => {
  const result = WhisperServerManager.resolveWhisperThreads(
    { threads: "8" },
    { availableParallelism: 14, env: { WHISPER_THREADS: "6" } }
  );

  assert.equal(result.threads, 8);
  assert.equal(result.source, "options");
});

test("resolveWhisperThreads falls back safely when env override is invalid", () => {
  const result = WhisperServerManager.resolveWhisperThreads(
    {},
    { availableParallelism: 14, env: { WHISPER_THREADS: "fast" } }
  );

  assert.equal(result.threads, 10);
  assert.equal(result.source, "invalid-env-auto");
});

test("getVadSignature changes when VAD settings or model path change", () => {
  const a = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadModelPath: "/m.bin",
    vadConfig: { threshold: 0.5 },
  });
  const b = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadModelPath: "/m.bin",
    vadConfig: { threshold: 0.6 },
  });
  const c = WhisperServerManager.getVadSignature({
    vadEnabled: false,
    vadModelPath: "/m.bin",
    vadConfig: { threshold: 0.6 },
  });
  const d = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadModelPath: null,
    vadConfig: { threshold: 0.5 },
  });

  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.equal(c, d);
});
