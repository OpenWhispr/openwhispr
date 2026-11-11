const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/speakerRangeMatch.js");

const A = (startTime, endTime) => ({
  speakerId: "speaker_0",
  displayName: "Ana",
  startTime,
  endTime,
});
const B = (startTime, endTime) => ({
  speakerId: "speaker_1",
  displayName: null,
  startTime,
  endTime,
});

test("the speaker covering more of the row wins", async () => {
  const { pickSpeakerForRange } = await load();
  assert.deepEqual(pickSpeakerForRange([A(0, 3000), B(2500, 6000)], 0, 5000), {
    speakerId: "speaker_0",
    displayName: "Ana",
    overlapMs: 3000,
  });
});

test("growing windows for one speaker don't add up", async () => {
  const { pickSpeakerForRange } = await load();
  const ids = [A(0, 1000), A(0, 2000), A(0, 3000), B(3000, 8000)];
  assert.equal(pickSpeakerForRange(ids, 0, 8000).speakerId, "speaker_1");
});

test("a tie goes to the later identification", async () => {
  const { pickSpeakerForRange } = await load();
  assert.equal(pickSpeakerForRange([A(0, 2000), B(2000, 4000)], 0, 4000).speakerId, "speaker_1");
});

test("no overlap is no speaker", async () => {
  const { pickSpeakerForRange } = await load();
  assert.equal(pickSpeakerForRange([A(0, 1000)], 5000, 6000), null);
  assert.equal(pickSpeakerForRange([], 0, 1000), null);
});

test("a later identification relabels only when it covers more of the row", async () => {
  const { relabelForIdentification } = await load();
  assert.equal(
    relabelForIdentification({ start: 0, end: 5000, overlapMs: 3000 }, B(2500, 5000)),
    null
  );
  assert.deepEqual(
    relabelForIdentification({ start: 0, end: 5000, overlapMs: 1000 }, B(2500, 5000)),
    { speakerId: "speaker_1", displayName: null, overlapMs: 2500 }
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
