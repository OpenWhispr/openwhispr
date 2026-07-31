const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveSpeakerExpectation,
  otherVoicesFromTotal,
} = require("../../src/helpers/speakerExpectation");
const { MAX_SPEAKER_COUNT } = require("../../src/constants/speakerDetection.json");

test("expected counts always exclude the local user", () => {
  assert.equal(otherVoicesFromTotal(3), 2);
  assert.equal(otherVoicesFromTotal(1), 1);
  assert.equal(otherVoicesFromTotal(MAX_SPEAKER_COUNT + 5), MAX_SPEAKER_COUNT - 1);
});

test("a count the user set forces the cluster count", () => {
  assert.deepEqual(resolveSpeakerExpectation({ storedTotal: 4 }), { numSpeakers: 3, cap: 3 });
});

test("a session count is only a cap, not a forced cluster count", () => {
  assert.deepEqual(resolveSpeakerExpectation({ sessionTotal: 4 }), { numSpeakers: -1, cap: 3 });
});

test("attendee lists and session counts agree on the off-by-one", () => {
  assert.deepEqual(
    resolveSpeakerExpectation({ attendeeTotal: 4 }),
    resolveSpeakerExpectation({ sessionTotal: 4 })
  );
});

test("a stored count wins over weaker signals", () => {
  assert.deepEqual(
    resolveSpeakerExpectation({ storedTotal: 2, sessionTotal: 6, attendeeTotal: 8 }),
    { numSpeakers: 1, cap: 1 }
  );
});

test("live-observed speakers already exclude you", () => {
  assert.deepEqual(resolveSpeakerExpectation({ observedOtherSpeakers: 3 }), {
    numSpeakers: -1,
    cap: 3,
  });
});

test("with no signal at all nothing is forced or capped", () => {
  assert.deepEqual(resolveSpeakerExpectation(), { numSpeakers: -1, cap: null });
  assert.deepEqual(resolveSpeakerExpectation({ attendeeTotal: 1, observedOtherSpeakers: 1 }), {
    numSpeakers: -1,
    cap: null,
  });
});
