const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/uploadNotes.ts");
const { MAX_SPEAKER_COUNT } = require("../../src/constants/speakerDetection.json");

test("maps the diarization settings onto the note columns", async () => {
  const { buildUploadNoteMetadata } = await load();

  const { audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: 2 },
    4359.87
  );

  assert.equal(audioDurationSeconds, 4359.87);
  assert.deepEqual(noteUpdates, { diarization_enabled: 1 });
});

// The upload caps detected speakers at the entered count, but recording into
// the note later forces expected_speaker_count as the exact count.
test("the speaker count entered for an upload is never stored on the note", async () => {
  const { buildUploadNoteMetadata } = await load();

  for (const numSpeakers of [null, 2, MAX_SPEAKER_COUNT]) {
    const { noteUpdates } = buildUploadNoteMetadata(
      { enabled: true, localModelsReady: true, numSpeakers },
      60
    );
    assert.equal(Object.hasOwn(noteUpdates, "expected_speaker_count"), false);
    assert.equal(noteUpdates.diarization_enabled, 1);
  }
});

test("disabled diarization writes no columns at all", async () => {
  const { buildUploadNoteMetadata } = await load();

  // A null diarization_enabled defers to the global speaker setting when the
  // user records into the note later (a 0 would force it off).
  const { audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    { enabled: false, localModelsReady: false, numSpeakers: 3 },
    120
  );

  assert.equal(noteUpdates, null);
  assert.equal(audioDurationSeconds, 120);
});

test("unusable durations degrade to null", async () => {
  const { buildUploadNoteMetadata } = await load();
  const diarization = { enabled: true, localModelsReady: true, numSpeakers: 2 };

  for (const value of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.equal(
      buildUploadNoteMetadata(diarization, value).audioDurationSeconds,
      null,
      `expected ${value} to degrade to null`
    );
  }
});

test("provider segments serialize into the meeting-path transcript shape", async () => {
  const { buildUploadTranscript } = await load();

  const anchorMs = 1_700_000_000_000;
  const transcript = buildUploadTranscript(
    [
      { text: " Hello world. ", start: 0, end: 4.2 },
      { text: "Named part.", start: 4.2, end: 7.5, speaker: "Speaker 1" },
    ],
    anchorMs
  );

  // Timestamps are epoch-anchored ms, the meeting path's base: exports rebase
  // off the minimum (guarded by min > 1e9), and live segments appended by a
  // later meeting recording on the same note share the base instead of mixing
  // relative seconds with Date.now() values.
  assert.deepEqual(JSON.parse(transcript), [
    { text: "Hello world.", timestamp: anchorMs },
    { text: "Named part.", timestamp: anchorMs + 4200, speaker: "speaker_0" },
  ]);
});

test("the default anchor is the current epoch so later meeting appends share one base", async () => {
  const { buildUploadTranscript } = await load();

  const before = Date.now();
  const stored = JSON.parse(buildUploadTranscript([{ text: "Hi.", start: 1.5 }]));
  const after = Date.now();

  assert.ok(
    stored[0].timestamp >= before + 1500 && stored[0].timestamp <= after + 1500,
    `expected ${stored[0].timestamp} to sit 1.5s after an epoch-ms anchor in [${before}, ${after}]`
  );
});

// The record button on any editable note seeds a meeting recording from
// note.transcript and appends Date.now()-stamped live segments. Pin that an
// upload transcript mixed with those appends exports sane cue times — a
// relative-seconds base would keep resolveRecordingStartMs at ~0, skip the
// epoch rebase, and render the appended segments as ~481,000,000-hour cues.
test("upload transcripts mixed with later live meeting segments export sane SRT times", async () => {
  const { buildUploadTranscript } = await load();
  const { formatSrt } = require("../../src/helpers/transcriptFormatter");

  const anchorMs = 1_700_000_000_000;
  const seeded = JSON.parse(
    buildUploadTranscript(
      [
        { text: "Uploaded intro.", start: 0, end: 3 },
        { text: "Uploaded detail.", start: 30, end: 33 },
      ],
      anchorMs
    )
  );
  const appended = [{ text: "Live follow-up.", source: "mic", timestamp: anchorMs + 60_000 }];

  const output = formatSrt([...seeded, ...appended], {});
  assert.match(output, /^1\n00:00:00,000 --> 00:00:30,000\nUnknown Speaker: Uploaded intro\./);
  assert.match(output, /\n2\n00:00:30,000 --> 00:01:00,000\nUnknown Speaker: Uploaded detail\./);
  assert.match(output, /\n3\n00:01:00,000 --> 00:01:03,000\nYou: Live follow-up\./);
});

test("unusable segments produce no transcript at all", async () => {
  const { buildUploadTranscript } = await load();

  assert.equal(buildUploadTranscript(undefined), undefined);
  assert.equal(buildUploadTranscript(null), undefined);
  assert.equal(buildUploadTranscript([]), undefined);
  assert.equal(
    buildUploadTranscript([
      { text: "   ", start: 0 },
      { text: "no start", start: NaN },
    ]),
    undefined
  );
});

test("segments persist the transcript even when diarization is off", async () => {
  const { buildUploadNoteMetadata } = await load();

  const anchorMs = 1_700_000_000_000;
  const { transcript, noteUpdates } = buildUploadNoteMetadata(
    { enabled: false, localModelsReady: false, numSpeakers: null },
    60,
    [{ text: "Hello.", start: 0, end: 2 }],
    anchorMs
  );

  assert.equal(transcript, JSON.stringify([{ text: "Hello.", timestamp: anchorMs }]));
  // The transcript must not drag the diarization columns along: a null
  // diarization_enabled still defers to the global speaker setting.
  assert.equal(noteUpdates, null);
});

test("diarization metadata follows the insert separately from the transcript", async () => {
  const { buildUploadNoteMetadata } = await load();

  const anchorMs = 1_700_000_000_000;
  const { transcript, noteUpdates } = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: 2 },
    60,
    [{ text: "Hi.", start: 1, speaker: "Speaker 1" }],
    anchorMs
  );

  assert.equal(
    transcript,
    JSON.stringify([{ text: "Hi.", timestamp: anchorMs + 1000, speaker: "speaker_0" }])
  );
  assert.deepEqual(noteUpdates, { diarization_enabled: 1 });
});

// The transcript is the note's only copy of the text, so a timed one missing a
// segment's words would lose them; the caller then stores the whole text untimed.
// Speakers become the meeting path's ids, in order of first appearance, so the
// UI translates their labels, renaming and mobile key on them, and a recording
// made into the note later numbers its own speakers after them.
test("provider speaker labels become meeting speaker ids", async () => {
  const { buildUploadTranscript } = await load();

  const stored = JSON.parse(
    buildUploadTranscript(
      [
        { text: "One.", start: 0, speaker: "B" },
        { text: "Two.", start: 1, speaker: "A" },
        { text: "Three.", start: 2, speaker: "B" },
        { text: "Four.", start: 3 },
      ],
      1_700_000_000_000
    )
  );
  assert.deepEqual(
    stored.map((segment) => segment.speaker),
    ["speaker_0", "speaker_1", "speaker_0", undefined]
  );
  assert.ok(stored.every((segment) => !("speakerName" in segment)));
});

test("a spoken segment without a start gives no timed transcript", async () => {
  const { buildUploadTranscript } = await load();

  assert.equal(
    buildUploadTranscript([
      { text: "First sentence.", start: 0 },
      { text: "Second sentence.", start: NaN },
    ]),
    undefined
  );
  assert.equal(
    JSON.parse(
      buildUploadTranscript(
        [
          { text: "  ", start: NaN },
          { text: "Kept.", start: 2 },
        ],
        1_700_000_000_000
      )
    ).length,
    1,
    "a blank segment carries no words, so its missing start loses nothing"
  );
});

test("upload titles fall back to the transcript, then the file name", async () => {
  const { uploadTitleFallback } = await load();

  assert.equal(uploadTitleFallback("one two three", "board.m4a"), "one two three");
  assert.equal(
    uploadTitleFallback("one two three four five six seven", "board.m4a"),
    "one two three four five six..."
  );
  assert.equal(uploadTitleFallback("   ", "board-meeting.m4a"), "board-meeting");
});
