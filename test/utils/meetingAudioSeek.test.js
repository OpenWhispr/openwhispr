const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAudioSeek } = require("../../src/utils/meetingAudioSeek.ts");
const recordings = [
  {
    id: "one",
    noteId: 1,
    createdAt: 1000,
    tracks: [
      { source: "mic", startedAt: 1000, durationSeconds: 10 },
      { source: "system", startedAt: 2000, durationSeconds: 10 },
    ],
  },
];
test("seek aligns each source to its own capture start", () => {
  assert.equal(resolveAudioSeek(recordings, { source: "mic", timestamp: 3500 }).seconds, 2.5);
  assert.equal(resolveAudioSeek(recordings, { source: "system", timestamp: 3500 }).seconds, 1.5);
  assert.equal(resolveAudioSeek(recordings, { source: "mic", timestamp: 20000 }), null);
  assert.equal(resolveAudioSeek(recordings, { source: "system" }), null);
});
