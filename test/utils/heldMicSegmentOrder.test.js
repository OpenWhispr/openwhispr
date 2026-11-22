const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeTranscriptSegments } = require("../../src/utils/transcriptSpeakerState.ts");
const { formatTxt, formatSrt } = require("../../src/helpers/transcriptFormatter");

const start = 1700000000000;

function line(id, text, timestamp) {
  return {
    id,
    source: "mic",
    speaker: "you",
    speakerName: "Alex",
    text,
    timestamp,
  };
}

const note = {
  title: "Standup",
  created_at: "2023-11-14T22:13:00Z",
  participants: "[]",
};

test("a mic line released after later speech is saved in spoken order", () => {
  const saved = [
    line("a", "We should ship on Friday", start),
    line("b", "The budget is approved", start + 10000),
  ];
  const incoming = [
    line("a", "We should ship on Friday", start),
    line("b", "The budget is approved", start + 10000),
    line("held", "Hold on", start + 4000),
  ];

  const merged = mergeTranscriptSegments(saved, incoming);

  assert.deepEqual(
    merged.map((segment) => segment.text),
    ["We should ship on Friday", "Hold on", "The budget is approved"]
  );
});

test("export keeps a late-released mic line in its own cue", () => {
  const segments = [
    line("a", "We should ship on Friday", start),
    line("b", "The budget is approved", start + 10000),
    line("held", "Hold on", start + 4000),
  ];

  const txt = formatTxt(note, segments, {});
  const srt = formatSrt(segments, {}, note);

  assert.match(txt, /\[00:00:04\] Alex:\nHold on/);
  assert.doesNotMatch(txt, /The budget is approved Hold on/);
  assert.match(srt, /00:00:04,000 --> 00:00:10,000\nAlex: Hold on/);
  assert.doesNotMatch(srt, /00:00:10,000 --> 00:00:07,000/);
});
