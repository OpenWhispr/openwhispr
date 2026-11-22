const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeTranscriptSegments } = require("../../src/utils/transcriptSpeakerState.ts");
const { formatTxt, formatSrt, formatJson } = require("../../src/helpers/transcriptFormatter");

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

test("an untimed upload stays put and does not end the previous caption early", () => {
  const segments = [
    { text: "The whole lecture." },
    line("a", "We should ship on Friday", start),
    line("b", "The budget is approved", start + 10000),
  ];
  const lectureNote = { ...note, audio_duration_seconds: 125.4 };
  const txt = formatTxt(lectureNote, segments, {});
  const srt = formatSrt(segments, {}, lectureNote);
  const json = JSON.parse(formatJson(lectureNote, segments, {}));

  assert.match(txt, /The whole lecture\.\n\n\[00:00:00\] Alex:\nWe should ship on Friday/);
  assert.doesNotMatch(txt, /Unknown Speaker/);
  assert.match(srt, /00:00:10,000 --> 00:00:13,000\nAlex: The budget is approved/);
  assert.doesNotMatch(srt, /00:00:10,000 --> 00:00:00,000/);
  assert.equal(json.metadata.duration_seconds, 10);
});

test("a held line is ordered when the saved note has no rows yet", () => {
  const merged = mergeTranscriptSegments([], [
    line("b", "The budget is approved", start + 10000),
    line("held", "Hold on", start + 4000),
  ]);

  assert.deepEqual(
    merged.map((segment) => segment.text),
    ["Hold on", "The budget is approved"]
  );
});
