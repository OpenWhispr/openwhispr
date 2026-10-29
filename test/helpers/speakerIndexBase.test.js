const test = require("node:test");
const assert = require("node:assert/strict");
const {
  speakerIndexOf,
  resolveSpeakerIndexBase,
  buildSpeakerRenumber,
} = require("../../src/helpers/speakerIndexBase");

test("speakerIndexOf reads only exact speaker_N ids", () => {
  assert.equal(speakerIndexOf("speaker_0"), 0);
  assert.equal(speakerIndexOf("speaker_12"), 12);
  assert.equal(speakerIndexOf("you"), null);
  assert.equal(speakerIndexOf("speaker_1a"), null);
  assert.equal(speakerIndexOf(undefined), null);
});

test("a fresh meeting starts at 0", () => {
  assert.equal(resolveSpeakerIndexBase(undefined, []), 0);
  assert.equal(resolveSpeakerIndexBase(0, []), 0);
});

test("the base clears every stored id, not just the requested one", () => {
  assert.equal(resolveSpeakerIndexBase(2, ["speaker_0", "speaker_1"]), 2);
  // A mapping left on a merged-away cluster still names whoever reuses its id.
  assert.equal(resolveSpeakerIndexBase(2, ["speaker_0", "speaker_4", "you"]), 5);
});

test("an invalid requested base degrades to the stored ids", () => {
  for (const requested of [-3, 1.5, Number.NaN, null]) {
    assert.equal(resolveSpeakerIndexBase(requested, ["speaker_1"]), 2, String(requested));
  }
});

test("clusters are renumbered in first-seen order from the base", () => {
  const renumber = buildSpeakerRenumber(["speaker_01", "speaker_00"], 3);
  assert.deepEqual(
    [...renumber.entries()],
    [
      ["speaker_01", "speaker_3"],
      ["speaker_00", "speaker_4"],
    ]
  );
  assert.equal(buildSpeakerRenumber(["a"], 0).get("a"), "speaker_0");
});
