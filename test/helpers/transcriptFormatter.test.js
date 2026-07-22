const test = require("node:test");
const assert = require("node:assert/strict");

const { formatSrt, formatJson } = require("../../src/helpers/transcriptFormatter");

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

test("the final merged SRT cue ends relative to its last segment, not its first", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0, text: "One." },
      { speaker: "speaker_0", timestamp: 1.5, text: "Two." },
      { speaker: "speaker_0", timestamp: 3, text: "Three." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:06,000\nSpeaker 1: One\. Two\. Three\./);
});

test("SRT timestamps roll sub-second rounding into the next second", () => {
  const output = formatSrt([{ speaker: "speaker_0", timestamp: 0.9995, text: "Near boundary." }], {});

  assert.doesNotMatch(output, /,\d{4}/);
  assert.match(output, /^1\n00:00:01,000 --> 00:00:04,000\nSpeaker 1: Near boundary\./);
});

test("SRT timestamps stay valid for merged cues near second boundaries", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0.9995, text: "Opening." },
      { speaker: "speaker_0", timestamp: 1.9995, text: "Continuation." },
      { speaker: "speaker_1", timestamp: 4, text: "Reply." },
    ],
    {}
  );

  assert.doesNotMatch(output, /,\d{4}/);
  assert.match(output, /^1\n00:00:01,000 --> 00:00:04,000\nSpeaker 1: Opening\. Continuation\./);
});

test("JSON duration reflects the last merged segment's timestamp", () => {
  const output = formatJson(
    { title: "Note", created_at: "2026-01-01T00:00:00Z" },
    [
      { speaker: "speaker_0", timestamp: 0, text: "One." },
      { speaker: "speaker_0", timestamp: 1.5, text: "Two." },
      { speaker: "speaker_0", timestamp: 3, text: "Three." },
    ],
    {}
  );

  assert.equal(JSON.parse(output).metadata.duration_seconds, 3);
});
