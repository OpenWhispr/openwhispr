const test = require("node:test");
const assert = require("node:assert/strict");

test("computes segment diff between old and new transcripts", async () => {
  const { computeTranscriptDiff } = await import("../../src/helpers/transcriptDiff.js");

  const oldSegments = [
    { id: "s0", text: "Hello world", speaker: "speaker_0" },
    { id: "s1", text: "How are you", speaker: "speaker_1" },
    { id: "s2", text: "I am fine", speaker: "speaker_0" },
  ];
  const newSegments = [
    { id: "s0", text: "Hello world", speaker: "speaker_0" },
    { id: "s1", text: "How are you doing", speaker: "speaker_1" },
    { id: "s2", text: "I am fine", speaker: "speaker_2" },
  ];

  const diff = computeTranscriptDiff(oldSegments, newSegments);
  assert.equal(diff.totalSegments, 3);
  assert.equal(diff.changedSegments, 2);
  assert.equal(diff.newSpeakerSplits, 1);
});

test("handles JSON string transcripts", async () => {
  const { computeTranscriptDiff } = await import("../../src/helpers/transcriptDiff.js");

  const old = JSON.stringify([{ text: "a", speaker: "s0" }]);
  const newT = JSON.stringify([{ text: "b", speaker: "s0" }]);
  const diff = computeTranscriptDiff(old, newT);
  assert.equal(diff.changedSegments, 1);
});

test("handles non-array inputs gracefully", async () => {
  const { computeTranscriptDiff } = await import("../../src/helpers/transcriptDiff.js");
  const diff = computeTranscriptDiff("raw text", "new raw text");
  assert.equal(diff.totalSegments, 0);
  assert.equal(diff.changedSegments, 0);
});
