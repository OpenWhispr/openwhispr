const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeStoredSpeakerCount } = require("../../src/helpers/speakerCount");
const { MAX_SPEAKER_COUNT } = require("../../src/constants/speakerDetection.json");

test("keeps a usable stored count", () => {
  assert.equal(normalizeStoredSpeakerCount(1), 1);
  assert.equal(normalizeStoredSpeakerCount(3), 3);
  assert.equal(normalizeStoredSpeakerCount(MAX_SPEAKER_COUNT), MAX_SPEAKER_COUNT);
});

test("clamps above the supported maximum", () => {
  assert.equal(normalizeStoredSpeakerCount(MAX_SPEAKER_COUNT + 5), MAX_SPEAKER_COUNT);
});

test("rejects values the cloud can persist but the app cannot use", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, null, undefined, "", {}]) {
    assert.equal(
      normalizeStoredSpeakerCount(value),
      null,
      `expected ${JSON.stringify(value)} to normalize to null`
    );
  }
});
