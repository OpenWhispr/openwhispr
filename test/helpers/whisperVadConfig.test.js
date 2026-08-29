const test = require("node:test");
const assert = require("node:assert/strict");

test("sanitizeWhisperVadConfig applies defaults and clamps invalid values", async () => {
  const { DEFAULT_WHISPER_VAD_CONFIG, sanitizeWhisperVadConfig } =
    await import("../../src/helpers/whisperVadConfig.js");

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

test("resolveContextSileroEnabled prefers context value then falls back to per-context default", async () => {
  const { resolveContextSileroEnabled } = await import("../../src/helpers/whisperVadConfig.js");

  assert.equal(resolveContextSileroEnabled({ dictationSileroEnabled: false }, "dictation"), false);
  assert.equal(resolveContextSileroEnabled({ dictationSileroEnabled: true }, "dictation"), true);
  assert.equal(
    resolveContextSileroEnabled({ noteRecordingSileroEnabled: true }, "noteRecording"),
    true
  );
  assert.equal(resolveContextSileroEnabled({}, "meeting"), true);
});

// VAD on pause-heavy dictations can strip the speech, making Whisper decode
// near-silence seeded with the custom-dictionary prompt — the transcript is
// replaced by dictionary words (#1454). Dictation VAD is opt-in.
test("resolveContextSileroEnabled defaults dictation off, other contexts on", async () => {
  const { resolveContextSileroEnabled } = await import("../../src/helpers/whisperVadConfig.js");

  assert.equal(resolveContextSileroEnabled({}, "dictation"), false);
  assert.equal(resolveContextSileroEnabled(undefined, "dictation"), false);
  assert.equal(resolveContextSileroEnabled({}, "noteRecording"), true);
  assert.equal(resolveContextSileroEnabled({}, "meeting"), true);
});

test("clampVadField handles unknown keys safely without throwing", async () => {
  const { clampVadField } = await import("../../src/helpers/whisperVadConfig.js");
  assert.equal(clampVadField("unknownField", 42), 42);
  assert.equal(clampVadField(null, 42), 42);
});

test("resolveContextSileroEnabled normalizes casing and whitespace in context", async () => {
  const { resolveContextSileroEnabled } = await import("../../src/helpers/whisperVadConfig.js");
  assert.equal(resolveContextSileroEnabled({}, " DICTATION "), false);
  assert.equal(resolveContextSileroEnabled({}, "NoteRecording"), true);
  assert.equal(resolveContextSileroEnabled({}, " MEETING "), true);
  assert.equal(
    resolveContextSileroEnabled({ dictationSileroEnabled: true }, "Dictation"),
    true
  );
});
