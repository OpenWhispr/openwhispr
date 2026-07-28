const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRANSCRIPTION_TIMEOUT_FLOOR_MS,
  TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS,
  UNKNOWN_DURATION_TIMEOUT_MS,
  TRANSCRIPTION_TIMEOUT_CEILING_MS,
  PCM16_MONO_16K_BYTES_PER_SECOND,
  computeTranscriptionTimeoutMs,
} = require("../../src/helpers/transcriptionTimeout");

test("long audio scales past the old 5-minute limit", () => {
  const timeoutMs = computeTranscriptionTimeoutMs(3600);
  assert.ok(timeoutMs > TRANSCRIPTION_TIMEOUT_FLOOR_MS);
  assert.equal(timeoutMs, Math.ceil(3600 * TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS));
});

test("short audio keeps the exact 5-minute floor", () => {
  assert.equal(computeTranscriptionTimeoutMs(30), TRANSCRIPTION_TIMEOUT_FLOOR_MS);
  assert.equal(computeTranscriptionTimeoutMs(0.5), TRANSCRIPTION_TIMEOUT_FLOOR_MS);
  assert.equal(TRANSCRIPTION_TIMEOUT_FLOOR_MS, 300000);
});

test("audio just past the floor breakpoint scales by the formula", () => {
  assert.equal(
    computeTranscriptionTimeoutMs(30.1),
    Math.ceil(30.1 * TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS)
  );
});

test("WAV byte length converts to the right duration", () => {
  const tenMinutesOf16kMonoS16le = 600 * 32000;
  assert.equal(
    computeTranscriptionTimeoutMs(tenMinutesOf16kMonoS16le / PCM16_MONO_16K_BYTES_PER_SECOND),
    600 * TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS
  );
});

test("absurd durations are clamped under the 32-bit setTimeout limit", () => {
  assert.equal(computeTranscriptionTimeoutMs(1e9), TRANSCRIPTION_TIMEOUT_CEILING_MS);
  assert.ok(TRANSCRIPTION_TIMEOUT_CEILING_MS <= 2147483647);
});

test("unknown or invalid durations fall back to the flat cap", () => {
  assert.equal(computeTranscriptionTimeoutMs(undefined), UNKNOWN_DURATION_TIMEOUT_MS);
  assert.equal(computeTranscriptionTimeoutMs(NaN), UNKNOWN_DURATION_TIMEOUT_MS);
  assert.equal(computeTranscriptionTimeoutMs(0), UNKNOWN_DURATION_TIMEOUT_MS);
  assert.equal(computeTranscriptionTimeoutMs(-5), UNKNOWN_DURATION_TIMEOUT_MS);
  assert.equal(computeTranscriptionTimeoutMs(Infinity), UNKNOWN_DURATION_TIMEOUT_MS);
});

test("result is always a finite number", () => {
  for (const input of [undefined, NaN, 0, -1, 0.5, 30, 3600, 1e9, Infinity]) {
    const timeoutMs = computeTranscriptionTimeoutMs(input);
    assert.equal(typeof timeoutMs, "number");
    assert.ok(Number.isFinite(timeoutMs));
  }
});
