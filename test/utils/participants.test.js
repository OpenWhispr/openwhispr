const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/participants.ts");

test("returns positive integer expected_speaker_count verbatim", async () => {
  const { resolveExpectedSpeakerCount } = await load();
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: 3 }), 3);
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: 1 }), 1);
});

test("ignores non-positive expected_speaker_count and falls back to participants", async () => {
  const { resolveExpectedSpeakerCount } = await load();
  const note = {
    expected_speaker_count: 0,
    participants: JSON.stringify([{ name: "Alice" }, { name: "Bob", self: true }]),
  };
  assert.equal(resolveExpectedSpeakerCount(note), 2);

  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: 0 }), null);
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: -1 }), null);
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: -10 }), null);
});

test("ignores non-integer and non-finite expected_speaker_count", async () => {
  const { resolveExpectedSpeakerCount } = await load();
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: 1.5 }), null);
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: NaN }), null);
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: Infinity }), null);
  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: -Infinity }), null);
});

test("derives speaker count from calendar participants when expected_speaker_count is nullish", async () => {
  const { resolveExpectedSpeakerCount } = await load();
  const participants = JSON.stringify([
    { name: "Alice" },
    { name: "Charlie" },
    { name: "Bob", self: true },
  ]);

  assert.equal(resolveExpectedSpeakerCount({ expected_speaker_count: null, participants }), 3);
  assert.equal(resolveExpectedSpeakerCount({ participants }), 3);
});

test("returns null when participants has no non-self attendees or is malformed", async () => {
  const { resolveExpectedSpeakerCount } = await load();
  assert.equal(
    resolveExpectedSpeakerCount({ participants: JSON.stringify([{ name: "Bob", self: true }]) }),
    null
  );
  assert.equal(resolveExpectedSpeakerCount({ participants: "invalid json" }), null);
  assert.equal(resolveExpectedSpeakerCount({ participants: "" }), null);
  assert.equal(resolveExpectedSpeakerCount({}), null);
  assert.equal(resolveExpectedSpeakerCount(), null);
});
