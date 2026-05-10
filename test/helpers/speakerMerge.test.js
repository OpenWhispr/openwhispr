const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeSpeakersWithText, formatSpeakerTranscript } = require("../../src/helpers/speakerMerge");

test("mergeSpeakersWithText assigns sentences to speakers by time proportion", () => {
  const segments = [
    { start: 0, end: 10, speaker: "speaker_0" },
    { start: 10, end: 20, speaker: "speaker_1" },
  ];
  const text = "Hello this is the first part. And this is the second part.";
  const duration = 20;

  const result = mergeSpeakersWithText(segments, text, duration);
  assert.equal(result.length, 2);
  assert.equal(result[0].speaker, "speaker_0");
  assert.equal(result[1].speaker, "speaker_1");
});

test("mergeSpeakersWithText handles single speaker", () => {
  const segments = [
    { start: 0, end: 30, speaker: "speaker_0" },
  ];
  const text = "All of this text belongs to one speaker.";
  const duration = 30;

  const result = mergeSpeakersWithText(segments, text, duration);
  assert.equal(result.length, 1);
  assert.equal(result[0].speaker, "speaker_0");
  assert.ok(result[0].text.includes("All of this text"));
});

test("mergeSpeakersWithText returns text as-is when no segments", () => {
  const result = mergeSpeakersWithText([], "Some text here.", 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].speaker, "speaker_0");
  assert.equal(result[0].text, "Some text here.");
});

test("mergeSpeakersWithText consolidates adjacent same-speaker segments", () => {
  const segments = [
    { start: 0, end: 5, speaker: "speaker_0" },
    { start: 5, end: 10, speaker: "speaker_0" },
    { start: 10, end: 20, speaker: "speaker_1" },
  ];
  const text = "First sentence. Second sentence. Third sentence here.";
  const duration = 20;

  const result = mergeSpeakersWithText(segments, text, duration);
  assert.ok(result.length <= 2);
});

test("formatSpeakerTranscript formats with labels and timestamps", () => {
  const merged = [
    { speaker: "speaker_0", text: "Hello there.", start: 0, end: 10 },
    { speaker: "speaker_1", text: "Hi back.", start: 10, end: 20 },
  ];

  const output = formatSpeakerTranscript(merged);
  assert.ok(output.includes("[Speaker 1]"));
  assert.ok(output.includes("[Speaker 2]"));
  assert.ok(output.includes("0:00"));
  assert.ok(output.includes("Hello there."));
});

test("formatSpeakerTranscript formats minutes and seconds correctly", () => {
  const merged = [
    { speaker: "speaker_0", text: "Long segment.", start: 0, end: 125 },
  ];

  const output = formatSpeakerTranscript(merged);
  assert.ok(output.includes("2:05"));
});
