const test = require("node:test");
const assert = require("node:assert/strict");

const { formatSrt } = require("../../src/helpers/transcriptFormatter");

test("merged same-speaker SRT cues keep the first segment's start time", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0.25, text: "Opening sentence." },
      { speaker: "speaker_0", timestamp: 1.75, text: "Continuation." },
      { speaker: "speaker_1", timestamp: 4, text: "Reply." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,250 --> 00:00:04,000\n/);
});

test("same-speaker merging still uses the latest segment for the rolling gap", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0, text: "One." },
      { speaker: "speaker_0", timestamp: 1.5, text: "Two." },
      { speaker: "speaker_0", timestamp: 3, text: "Three." },
      { speaker: "speaker_1", timestamp: 6, text: "Reply." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:06,000\nSpeaker 1: One\. Two\. Three\./);
});

test("same-speaker segments at the merge threshold remain separate cues", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0, text: "First." },
      { speaker: "speaker_0", timestamp: 2, text: "Second." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:02,000\nSpeaker 1: First\./);
  assert.match(output, /\n2\n00:00:02,000 --> 00:00:05,000\nSpeaker 1: Second\./);
});
