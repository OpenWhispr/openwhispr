const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/recordingGuard.js");

test("flags an empty WebM container (issue #864 double-trigger, ~110 bytes)", async () => {
  const { isEmptyRecording } = await load();
  assert.equal(isEmptyRecording(110), true);
});

test("flags a zero-byte blob", async () => {
  const { isEmptyRecording } = await load();
  assert.equal(isEmptyRecording(0), true);
});

test("flags 255 bytes (just under the threshold)", async () => {
  const { isEmptyRecording } = await load();
  assert.equal(isEmptyRecording(255), true);
});

test("allows exactly 256 bytes (boundary)", async () => {
  const { isEmptyRecording } = await load();
  assert.equal(isEmptyRecording(256), false);
});

test("allows a short real utterance with real audio bytes (no silent data loss)", async () => {
  const { isEmptyRecording } = await load();
  assert.equal(isEmptyRecording(3000), false);
});

test("allows a normal full-length recording", async () => {
  const { isEmptyRecording } = await load();
  assert.equal(isEmptyRecording(1674472), false);
});

test("treats missing / null / NaN size as empty (defensive)", async () => {
  const { isEmptyRecording } = await load();
  assert.equal(isEmptyRecording(undefined), true);
  assert.equal(isEmptyRecording(null), true);
  assert.equal(isEmptyRecording(NaN), true);
});

test("MIN_AUDIO_BYTES is 256", async () => {
  const { MIN_AUDIO_BYTES } = await load();
  assert.equal(MIN_AUDIO_BYTES, 256);
});
