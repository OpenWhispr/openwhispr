const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/speakerRangeMatch.js");

const NAMES = { speaker_0: "Ana", speaker_1: null };

// One VAD speech segment, as the live identifier reports it: every identification
// shares the segment's padded start and only its end grows. `steps` are
// [speakerId, endTime] in arrival order.
const speechSegment = (startTime, steps) =>
  steps.map(([speakerId, endTime]) => ({
    speakerId,
    displayName: NAMES[speakerId],
    startTime,
    endTime,
  }));

const A = (startTime, endTime) => speechSegment(startTime, [["speaker_0", endTime]])[0];
const B = (startTime, endTime) => speechSegment(startTime, [["speaker_1", endTime]])[0];

// Speech starts at 750 (padded start 0). The embedding hears A for the first 4 s,
// then B until the segment closes at 10 500.
const handover = speechSegment(0, [
  ["speaker_0", 1750],
  ["speaker_0", 2750],
  ["speaker_0", 3750],
  ["speaker_0", 4750],
  ["speaker_1", 5750],
  ["speaker_1", 6750],
  ["speaker_1", 7750],
  ["speaker_1", 8750],
  ["speaker_1", 9750],
  ["speaker_1", 10500],
]);

test("a row in the later speaker's part of one speech segment goes to them", async () => {
  const { pickSpeakerForRange } = await load();
  assert.deepEqual(pickSpeakerForRange(handover, 5000, 9500), {
    speakerId: "speaker_1",
    displayName: null,
    overlapMs: 4500,
  });
});

test("a row in the earlier speaker's part keeps them after the next speaker is heard", async () => {
  const { pickSpeakerForRange } = await load();
  assert.deepEqual(pickSpeakerForRange(handover, 750, 4500), {
    speakerId: "speaker_0",
    displayName: "Ana",
    overlapMs: 3750,
  });
});

test("growing windows for one speaker don't add up", async () => {
  const { pickSpeakerForRange } = await load();
  // Summing A's whole windows would credit 6 s; only 3 s of audio was heard as A.
  const ids = [
    ...speechSegment(0, [
      ["speaker_0", 1000],
      ["speaker_0", 2000],
      ["speaker_0", 3000],
    ]),
    B(3000, 7000),
  ];
  const picked = pickSpeakerForRange(ids, 0, 8000);
  assert.equal(picked.speakerId, "speaker_1");
  assert.equal(picked.overlapMs, 4000);
});

test("one speaker's slices across speech segments add up", async () => {
  const { pickSpeakerForRange } = await load();
  const ids = [A(0, 2000), B(2000, 5000), A(5000, 7000)];
  assert.deepEqual(pickSpeakerForRange(ids, 0, 7000), {
    speakerId: "speaker_0",
    displayName: "Ana",
    overlapMs: 4000,
  });
});

test("a tie goes to the speaker heard more recently", async () => {
  const { pickSpeakerForRange } = await load();
  assert.equal(pickSpeakerForRange([A(0, 2000), B(2000, 4000)], 0, 4000).speakerId, "speaker_1");
  // Arrival order doesn't decide it: B's slice is still the later one.
  assert.equal(pickSpeakerForRange([B(2000, 4000), A(0, 2000)], 0, 4000).speakerId, "speaker_1");
  const shared = speechSegment(0, [
    ["speaker_0", 2000],
    ["speaker_1", 4000],
  ]);
  assert.equal(pickSpeakerForRange(shared, 0, 4000).speakerId, "speaker_1");
});

test("slices within a speech segment are cut in end order", async () => {
  const { pickSpeakerForRange } = await load();
  const [early, late] = speechSegment(0, [
    ["speaker_0", 2000],
    ["speaker_1", 6000],
  ]);
  assert.equal(pickSpeakerForRange([late, early], 0, 6000).speakerId, "speaker_1");
});

test("the speaker's latest known name is kept", async () => {
  const { pickSpeakerForRange } = await load();
  const ids = [A(0, 2000), { ...A(2000, 4000), displayName: null }];
  assert.equal(pickSpeakerForRange(ids, 0, 4000).displayName, "Ana");
});

test("no overlap is no speaker", async () => {
  const { pickSpeakerForRange } = await load();
  assert.equal(pickSpeakerForRange([A(0, 1000)], 5000, 6000), null);
  assert.equal(pickSpeakerForRange([], 0, 1000), null);
});

test("a pick changes a row only when it moves, confirms or names it", async () => {
  const { rangedLabelChanges } = await load();
  const row = { speaker: "speaker_0", speakerName: "Ana", speakerStatus: "confirmed" };
  const heard = (speakerId, displayName) => ({ speakerId, displayName, overlapMs: 1000 });
  assert.equal(rangedLabelChanges(row, heard("speaker_0", "Ana")), false);
  assert.equal(rangedLabelChanges(row, heard("speaker_0", null)), false);
  assert.equal(rangedLabelChanges(row, heard("speaker_0", "Anna")), true);
  assert.equal(rangedLabelChanges(row, heard("speaker_1", null)), true);
  assert.equal(
    rangedLabelChanges({ ...row, speakerStatus: "provisional" }, heard("speaker_0", null)),
    true
  );
  assert.equal(
    rangedLabelChanges({ ...row, speakerIsPlaceholder: true }, heard("speaker_0", null)),
    true
  );
});

test("identifications are kept for 120 s behind the newest", async () => {
  const { pruneIdentifications, IDENTIFICATION_RETENTION_MS } = await load();
  const kept = pruneIdentifications([A(0, 1000), A(100_000, 101_000)], 121_500);
  assert.deepEqual(
    kept.map((id) => id.endTime),
    [101_000]
  );
  assert.equal(IDENTIFICATION_RETENTION_MS, 120_000);
});
