const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldSaveMeetingAudioRetention,
  MIN_MEETING_AUDIO_RETENTION_SECONDS,
} = require("../../src/helpers/meetingAudioRetention");

const base = {
  dataRetentionEnabled: true,
  audioRetentionDays: 30,
};

test("saves when data retention and audio retention are enabled", () => {
  assert.equal(shouldSaveMeetingAudioRetention(base, 3), true);
  assert.equal(
    shouldSaveMeetingAudioRetention(base, MIN_MEETING_AUDIO_RETENTION_SECONDS),
    true
  );
});

test("does not save below the minimum duration", () => {
  assert.equal(shouldSaveMeetingAudioRetention(base, 0.5), false);
  assert.equal(shouldSaveMeetingAudioRetention(base, 0), false);
  assert.equal(shouldSaveMeetingAudioRetention(base, null), false);
  assert.equal(shouldSaveMeetingAudioRetention(base, NaN), false);
});

test("respects each gate", () => {
  assert.equal(
    shouldSaveMeetingAudioRetention({ ...base, dataRetentionEnabled: false }, 3),
    false
  );
  assert.equal(shouldSaveMeetingAudioRetention({ ...base, audioRetentionDays: 0 }, 3), false);
});

test("handles missing settings", () => {
  assert.equal(shouldSaveMeetingAudioRetention(null, 3), false);
  assert.equal(shouldSaveMeetingAudioRetention(undefined, 3), false);
});
