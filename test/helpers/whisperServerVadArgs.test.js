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
    "--max-len",
    "4096",
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

test("buildWhisperServerArgs suppresses the segment wrap without disabling timestamps", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
  });

  // The server's 60-char wrap breaks words mid-token (#1348). Raising max_len past
  // anything one 30s window can hold turns it off; the longest segment measured
  // against the bundled binary is 186 characters.
  const maxLenIndex = args.indexOf("--max-len");
  assert.notEqual(maxLenIndex, -1);
  assert.equal(Number(args[maxLenIndex + 1]) >= 4096, true);

  // Suppressing the wrap with --no-timestamps instead cost the decoder its timestamp
  // tokens, so whisper.cpp advanced `seek` a full 30s window regardless of where the
  // decode stopped and silently dropped everything in between (#2150).
  assert.equal(args.includes("--no-timestamps"), false);
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

test("buildWhisperServerArgs pins the GPU device when an index is given", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
    gpuDeviceIndex: 1,
  });

  assert.deepEqual(args.slice(6, 8), ["--device", "1"]);
});

test("buildWhisperServerArgs omits --device by default and for unpinned sentinels", () => {
  for (const gpuDeviceIndex of [undefined, null, -1]) {
    const args = WhisperServerManager.buildWhisperServerArgs({
      modelPath: "/tmp/model.bin",
      port: 8180,
      language: "auto",
      gpuDeviceIndex,
    });

    assert.equal(args.includes("--device"), false);
  }
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
