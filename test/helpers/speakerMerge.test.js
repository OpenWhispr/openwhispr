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
  assert.ok(result[0].text.includes("first part"));
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 10);
  assert.equal(result[1].speaker, "speaker_1");
  assert.ok(result[1].text.includes("second part"));
  assert.equal(result[1].start, 10);
  assert.equal(result[1].end, 20);
});

test("mergeSpeakersWithText handles single speaker", () => {
  const segments = [{ start: 0, end: 30, speaker: "speaker_0" }];
  const text = "All of this text belongs to one speaker.";
  const duration = 30;

  const result = mergeSpeakersWithText(segments, text, duration);
  assert.equal(result.length, 1);
  assert.equal(result[0].speaker, "speaker_0");
  assert.ok(result[0].text.includes("All of this text"));
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 30);
});

test("mergeSpeakersWithText returns text as-is when no segments", () => {
  const result = mergeSpeakersWithText([], "Some text here.", 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].speaker, "speaker_0");
  assert.equal(result[0].text, "Some text here.");
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 10);
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
  assert.equal(result.length, 2);
  assert.equal(result[0].speaker, "speaker_0");
  assert.ok(result[0].text.includes("First sentence"));
  assert.ok(result[0].text.includes("Second sentence"));
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 10);
  assert.equal(result[1].speaker, "speaker_1");
  assert.ok(result[1].text.includes("Third sentence here"));
  assert.equal(result[1].start, 10);
  assert.equal(result[1].end, 20);
});

test("formatSpeakerTranscript formats with labels and timestamps", () => {
  const merged = [
    { speaker: "speaker_0", text: "Hello there.", start: 0, end: 10 },
    { speaker: "speaker_1", text: "Hi back.", start: 10, end: 20 },
  ];

  const output = formatSpeakerTranscript(merged);
  assert.equal(output, "[Speaker 1] 0:00 - 0:10\nHello there.\n\n[Speaker 2] 0:10 - 0:20\nHi back.");
});

test("mergeSpeakersWithText handles duration=0 with segments", () => {
  const segments = [{ start: 0, end: 5, speaker: "speaker_0" }];
  const text = "Short clip text.";
  const result = mergeSpeakersWithText(segments, text, 0);
  assert.equal(result.length, 1);
  assert.ok(result[0].text.includes("Short clip text"));
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 5);
});

test("mergeSpeakersWithText handles zero-duration segment", () => {
  const segments = [{ start: 0, end: 0, speaker: "speaker_0" }];
  const text = "Some text.";
  const result = mergeSpeakersWithText(segments, text, 10);
  assert.equal(result.length, 1);
  assert.ok(result[0].text.includes("Some text"));
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 0);
});

test("formatSpeakerTranscript returns empty string for empty input", () => {
  assert.equal(formatSpeakerTranscript([]), "");
});

test("formatSpeakerTranscript formats minutes and seconds correctly", () => {
  const merged = [{ speaker: "speaker_0", text: "Long segment.", start: 0, end: 125 }];

  const output = formatSpeakerTranscript(merged);
  assert.equal(output, "[Speaker 1] 0:00 - 2:05\nLong segment.");
});

// Regression: the totalDuration fallback used to take segments[segments.length - 1].end,
// which assumes sorted input. Unsorted segments produced a wrong duration and collapsed
// every sentence onto one speaker.
test("mergeSpeakersWithText assigns correct speakers with unsorted segments and no duration", () => {
  const segments = [
    { start: 10, end: 20, speaker: "speaker_1" },
    { start: 0, end: 10, speaker: "speaker_0" },
  ];
  const text = "Alpha comes first. Beta comes second.";

  const result = mergeSpeakersWithText(segments, text);
  assert.equal(result.length, 2);
  assert.equal(result[0].speaker, "speaker_0");
  assert.ok(result[0].text.includes("Alpha comes first"));
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 10);
  assert.equal(result[1].speaker, "speaker_1");
  assert.ok(result[1].text.includes("Beta comes second"));
  assert.equal(result[1].start, 10);
  assert.equal(result[1].end, 20);
});

test("mergeSpeakersWithText fallback duration matches sorted-input behavior when segments are already ordered", () => {
  const segments = [
    { start: 0, end: 10, speaker: "speaker_0" },
    { start: 10, end: 20, speaker: "speaker_1" },
  ];
  const text = "Alpha comes first. Beta comes second.";

  const result = mergeSpeakersWithText(segments, text);
  assert.equal(result.length, 2);
  assert.equal(result[0].speaker, "speaker_0");
  assert.ok(result[0].text.includes("Alpha comes first"));
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 10);
  assert.equal(result[1].speaker, "speaker_1");
  assert.ok(result[1].text.includes("Beta comes second"));
  assert.equal(result[1].start, 10);
  assert.equal(result[1].end, 20);
});

test("empty-sentence fallback uses the max segment end, not the last segment's", () => {
  const segments = [
    { speaker: "spk_0", start: 0, end: 30 },
    { speaker: "spk_1", start: 10, end: 15 },
  ];
  const merged = mergeSpeakersWithText(segments, "   ", 0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end, 30);
});

test("zero duration with unsorted segments still maps proportionally against the max end", () => {
  // Overlap segment emitted last with an earlier end; a last-segment duration
  // would compress the timeline to 15s and misassign the tail sentences.
  const segments = [
    { speaker: "spk_0", start: 0, end: 30 },
    { speaker: "spk_1", start: 25, end: 40 },
    { speaker: "spk_0", start: 10, end: 15 },
  ];
  const text = "First sentence here. Second sentence here. Third sentence here. Fourth sentence here.";
  const merged = mergeSpeakersWithText(segments, text, 0);
  const last = merged[merged.length - 1];
  assert.equal(last.speaker, "spk_1", "tail sentences must map to the late segment");
});
