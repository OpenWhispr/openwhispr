const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatTxt,
  formatSrt,
  formatJson,
  formatMd,
} = require("../../src/helpers/transcriptFormatter");

test("TXT and Markdown exports include participant display names", () => {
  const note = {
    title: "Planning",
    created_at: "2026-01-01T00:00:00Z",
    participants: JSON.stringify([
      { displayName: "Ada Lovelace", email: "ada@example.com" },
      { displayName: "Grace Hopper", email: "grace@example.com" },
    ]),
  };

  assert.match(formatTxt(note, [], {}), /Participants: Ada Lovelace, Grace Hopper/);
  assert.match(formatMd(note, [], {}), /\*\*Participants:\*\* Ada Lovelace, Grace Hopper/);
});

test("participant exports fall back to email and legacy names", () => {
  const note = {
    title: "Planning",
    created_at: "2026-01-01T00:00:00Z",
    participants: JSON.stringify([
      { displayName: null, email: "guest@example.com" },
      { name: "Legacy Guest" },
    ]),
  };

  assert.match(formatTxt(note, [], {}), /Participants: guest@example.com, Legacy Guest/);
});

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
