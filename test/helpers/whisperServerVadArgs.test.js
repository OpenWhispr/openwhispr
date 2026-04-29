const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer");

test("buildWhisperServerArgs includes VAD flags when enabled", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
    vadEnabled: true,
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

test("getVadSignature changes when VAD settings change", () => {
  const a = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadConfig: { threshold: 0.5 },
  });
  const b = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadConfig: { threshold: 0.6 },
  });
  const c = WhisperServerManager.getVadSignature({
    vadEnabled: false,
    vadConfig: { threshold: 0.6 },
  });

  assert.notEqual(a, b);
  assert.notEqual(b, c);
});
