import { it, expect } from "vitest";
import { mergeSpeakersWithText, formatSpeakerTranscript } from "../../src/helpers/speakerMerge";

it("mergeSpeakersWithText assigns sentences to speakers by time proportion", () => {
  const segments = [
    { start: 0, end: 10, speaker: "speaker_0" },
    { start: 10, end: 20, speaker: "speaker_1" },
  ];
  const text = "Hello this is the first part. And this is the second part.";
  const duration = 20;

  const result = mergeSpeakersWithText(segments, text, duration);
  expect(result.length).toBe(2);
  expect(result[0].speaker).toBe("speaker_0");
  expect(result[1].speaker).toBe("speaker_1");
});

it("mergeSpeakersWithText handles single speaker", () => {
  const segments = [
    { start: 0, end: 30, speaker: "speaker_0" },
  ];
  const text = "All of this text belongs to one speaker.";
  const duration = 30;

  const result = mergeSpeakersWithText(segments, text, duration);
  expect(result.length).toBe(1);
  expect(result[0].speaker).toBe("speaker_0");
  expect(result[0].text).toContain("All of this text");
});

it("mergeSpeakersWithText returns text as-is when no segments", () => {
  const result = mergeSpeakersWithText([], "Some text here.", 10);
  expect(result.length).toBe(1);
  expect(result[0].speaker).toBe("speaker_0");
  expect(result[0].text).toBe("Some text here.");
});

it("mergeSpeakersWithText consolidates adjacent same-speaker segments", () => {
  const segments = [
    { start: 0, end: 5, speaker: "speaker_0" },
    { start: 5, end: 10, speaker: "speaker_0" },
    { start: 10, end: 20, speaker: "speaker_1" },
  ];
  const text = "First sentence. Second sentence. Third sentence here.";
  const duration = 20;

  const result = mergeSpeakersWithText(segments, text, duration);
  expect(result.length).toBeLessThanOrEqual(2);
});

it("formatSpeakerTranscript formats with labels and timestamps", () => {
  const merged = [
    { speaker: "speaker_0", text: "Hello there.", start: 0, end: 10 },
    { speaker: "speaker_1", text: "Hi back.", start: 10, end: 20 },
  ];

  const output = formatSpeakerTranscript(merged);
  expect(output).toContain("[Speaker 1]");
  expect(output).toContain("[Speaker 2]");
  expect(output).toContain("0:00");
  expect(output).toContain("Hello there.");
});

it("formatSpeakerTranscript formats minutes and seconds correctly", () => {
  const merged = [
    { speaker: "speaker_0", text: "Long segment.", start: 0, end: 125 },
  ];

  const output = formatSpeakerTranscript(merged);
  expect(output).toContain("2:05");
});
