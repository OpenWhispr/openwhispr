const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/recordingValidation.js");

test("allows a recording with audio frames and a real-sized blob", async () => {
  const { evaluateFinishedRecording } = await load();
  assert.deepEqual(evaluateFinishedRecording({ blobSize: 50000, receivedAudioData: true }), {
    usable: true,
    reason: null,
  });
});

test("rejects when no audio chunk was ever delivered (issue #871 cold start)", async () => {
  const { evaluateFinishedRecording } = await load();
  assert.deepEqual(evaluateFinishedRecording({ blobSize: 0, receivedAudioData: false }), {
    usable: false,
    reason: "no-audio-data",
  });
});

test("rejects a header-only ~110 byte blob even when a chunk arrived", async () => {
  const { evaluateFinishedRecording } = await load();
  assert.deepEqual(evaluateFinishedRecording({ blobSize: 110, receivedAudioData: true }), {
    usable: false,
    reason: "empty-container",
  });
});

test("allows exactly 256 bytes (boundary, mirrors MIN_AUDIO_BYTES)", async () => {
  const { evaluateFinishedRecording } = await load();
  assert.deepEqual(evaluateFinishedRecording({ blobSize: 256, receivedAudioData: true }), {
    usable: true,
    reason: null,
  });
});

test("rejects 255 bytes (just under the threshold)", async () => {
  const { evaluateFinishedRecording } = await load();
  assert.deepEqual(evaluateFinishedRecording({ blobSize: 255, receivedAudioData: true }), {
    usable: false,
    reason: "empty-container",
  });
});

test("treats missing / undefined args as unusable (defensive, does not throw)", async () => {
  const { evaluateFinishedRecording } = await load();
  assert.deepEqual(evaluateFinishedRecording(), { usable: false, reason: "no-audio-data" });
  assert.deepEqual(evaluateFinishedRecording({}), { usable: false, reason: "no-audio-data" });
  assert.deepEqual(evaluateFinishedRecording({ receivedAudioData: true }), {
    usable: false,
    reason: "empty-container",
  });
});

test("withSalvageWarning attaches a warning to a successful salvaged transcription", async () => {
  const { withSalvageWarning } = await load();
  assert.deepEqual(withSalvageWarning({ success: true, text: "hi" }, true), {
    success: true,
    text: "hi",
    warning: "salvaged-recording",
  });
});

test("withSalvageWarning leaves non-salvaged results untouched", async () => {
  const { withSalvageWarning } = await load();
  const result = { success: true, text: "hi" };
  assert.equal(withSalvageWarning(result, false), result);
});

test("withSalvageWarning keeps an existing warning", async () => {
  const { withSalvageWarning } = await load();
  const result = { success: true, text: "hi", warning: "truncated" };
  assert.equal(withSalvageWarning(result, true), result);
});

test("withSalvageWarning ignores failed or missing results", async () => {
  const { withSalvageWarning } = await load();
  const failed = { success: false, message: "no audio" };
  assert.equal(withSalvageWarning(failed, true), failed);
  assert.equal(withSalvageWarning(null, true), null);
});
