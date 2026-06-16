const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldSaveDiscardedRecording,
  MIN_DISCARDED_DURATION_SECONDS,
} = require("../../src/helpers/discardedRecording");

const base = {
  saveDiscardedTranscriptions: true,
  dataRetentionEnabled: true,
  audioRetentionDays: 30,
};

test("saves when all gates pass and duration >= threshold", () => {
  assert.equal(shouldSaveDiscardedRecording(base, 3), true);
  assert.equal(shouldSaveDiscardedRecording(base, MIN_DISCARDED_DURATION_SECONDS), true);
});

test("does not save below the minimum duration", () => {
  assert.equal(shouldSaveDiscardedRecording(base, 0.5), false);
  assert.equal(shouldSaveDiscardedRecording(base, 0), false);
  assert.equal(shouldSaveDiscardedRecording(base, null), false);
  assert.equal(shouldSaveDiscardedRecording(base, NaN), false);
});

test("respects each gate", () => {
  assert.equal(
    shouldSaveDiscardedRecording({ ...base, saveDiscardedTranscriptions: false }, 3),
    false
  );
  assert.equal(shouldSaveDiscardedRecording({ ...base, dataRetentionEnabled: false }, 3), false);
  assert.equal(shouldSaveDiscardedRecording({ ...base, audioRetentionDays: 0 }, 3), false);
});

test("handles missing settings", () => {
  assert.equal(shouldSaveDiscardedRecording(null, 3), false);
  assert.equal(shouldSaveDiscardedRecording(undefined, 3), false);
});
