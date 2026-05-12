const test = require("node:test");
const assert = require("node:assert/strict");

test("sanitizeWhisperVadConfig applies defaults and clamps invalid values", async () => {
  const { DEFAULT_WHISPER_VAD_CONFIG, sanitizeWhisperVadConfig } = await import(
    "../../src/helpers/whisperVadConfig.js"
  );

  const cfg = sanitizeWhisperVadConfig({
    threshold: 99,
    minSpeechDurationMs: -20,
    minSilenceDurationMs: "bad",
    maxSpeechDurationS: 0,
    speechPadMs: null,
    samplesOverlap: -1,
  });

  assert.deepEqual(cfg, {
    threshold: 0.95,
    minSpeechDurationMs: 50,
    minSilenceDurationMs: DEFAULT_WHISPER_VAD_CONFIG.minSilenceDurationMs,
    maxSpeechDurationS: 5,
    speechPadMs: DEFAULT_WHISPER_VAD_CONFIG.speechPadMs,
    samplesOverlap: 0,
  });
});

test("resolveContextSileroEnabled prefers context value then falls back to true", async () => {
  const { resolveContextSileroEnabled } = await import("../../src/helpers/whisperVadConfig.js");

  assert.equal(resolveContextSileroEnabled({ dictationSileroEnabled: false }, "dictation"), false);
  assert.equal(
    resolveContextSileroEnabled({ noteRecordingSileroEnabled: true }, "noteRecording"),
    true
  );
  assert.equal(resolveContextSileroEnabled({}, "meeting"), true);
});
