const test = require("node:test");
const assert = require("node:assert/strict");
const { trimSilence, KEEP_LEAD_MS, KEEP_TRAIL_MS } = require("../../src/workers/trimSilence");

// 1 kHz keeps the arithmetic readable: one sample per millisecond.
const RATE = 1000;
const silence = (ms) => new Array(ms).fill(0);
const tone = (ms, amplitude) =>
  Array.from({ length: ms }, (_, index) => amplitude * Math.sin((2 * Math.PI * 100 * index) / RATE));
const clip = (...parts) => new Float32Array(parts.flat());

test("silence at both ends is cut to a short lead-in and a sentence pause", () => {
  const trimmed = trimSilence(clip(silence(500), tone(300, 0.5), silence(600)), RATE);

  assert.equal(trimmed.length, KEEP_LEAD_MS + 300 + KEEP_TRAIL_MS);
  assert.ok(trimmed.slice(0, KEEP_LEAD_MS).every((sample) => sample === 0));
  assert.notEqual(trimmed[KEEP_LEAD_MS + 1], 0, "the speech starts right after the lead-in");
  // A copy, so posting it to the renderer doesn't carry the whole untrimmed buffer.
  assert.equal(trimmed.buffer.byteLength, trimmed.byteLength);
});

test("a quiet start to the speech is kept", () => {
  const trimmed = trimSilence(
    clip(silence(200), tone(100, 0.05), tone(200, 0.5), silence(300)),
    RATE
  );

  assert.equal(trimmed.length, KEEP_LEAD_MS + 100 + 200 + KEEP_TRAIL_MS);
});

test("speech with no silence to trim comes back whole", () => {
  const speech = clip(tone(300, 0.5));
  const trimmed = trimSilence(speech, RATE);

  assert.deepEqual(trimmed, speech);
  assert.notEqual(trimmed, speech);
});

test("an all-silent clip comes back unchanged", () => {
  assert.deepEqual(trimSilence(clip(silence(100)), RATE), clip(silence(100)));
});
