const test = require("node:test");
const assert = require("node:assert/strict");

const DiarizationManager = require("../../src/helpers/diarization");

const manager = new DiarizationManager();

const line = (timestamp, text) => ({ source: "system", timestamp, text });

test("a short line does not inherit the speaker who filled the gap after it", () => {
  // Speaker A says one short thing at 0s, then B talks from 3s to 40s. The gap to
  // the next transcript line is huge, so whole-gap matching would pick B.
  const diarization = [
    { start: 0, end: 2, speaker: "speaker_00" },
    { start: 3, end: 40, speaker: "speaker_01" },
  ];
  const transcript = [line(0.1, "Sure."), line(41, "Anyway, moving on.")];

  const merged = manager.mergeWithTranscript(transcript, diarization);

  assert.equal(merged[0].speaker, "speaker_0");
  assert.equal(merged[0].speakerStatus, "confirmed");
});

test("a line split evenly between two speakers is marked provisional", () => {
  const diarization = [
    { start: 0, end: 2, speaker: "speaker_00" },
    { start: 2, end: 4, speaker: "speaker_01" },
  ];
  // ~60 characters at 15 chars/second spans roughly four seconds.
  const transcript = [line(0, "This sentence is long enough to straddle both of the turns.")];

  const merged = manager.mergeWithTranscript(transcript, diarization);

  assert.equal(merged[0].speakerStatus, "provisional");
});

test("a line dominated by one speaker stays confirmed", () => {
  const diarization = [
    { start: 0, end: 3.8, speaker: "speaker_00" },
    { start: 3.8, end: 8, speaker: "speaker_01" },
  ];
  const transcript = [line(0, "This sentence is long enough to straddle both of the turns.")];

  const merged = manager.mergeWithTranscript(transcript, diarization);

  assert.equal(merged[0].speaker, "speaker_0");
  assert.equal(merged[0].speakerStatus, "confirmed");
});

test("a line outside every diarized turn falls back to the nearest speaker", () => {
  const diarization = [{ start: 30, end: 40, speaker: "speaker_00" }];
  const transcript = [line(0, "Hello?")];

  const merged = manager.mergeWithTranscript(transcript, diarization);

  assert.equal(merged[0].speaker, "speaker_0");
});

test("mic lines are always attributed to you", () => {
  const merged = manager.mergeWithTranscript(
    [{ source: "mic", timestamp: 1, text: "My turn" }],
    [{ start: 0, end: 5, speaker: "speaker_00" }]
  );

  assert.equal(merged[0].speaker, "you");
});

test("without diarization output the transcript is returned unlabelled", () => {
  const transcript = [line(0, "Hello")];

  assert.deepEqual(manager.mergeWithTranscript(transcript, []), transcript);
});
