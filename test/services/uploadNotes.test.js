const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/uploadNotes.ts");
const { MAX_SPEAKER_COUNT } = require("../../src/constants/speakerDetection.json");

test("maps the diarizer invocation onto the note columns", async () => {
  const { buildUploadNoteMetadata } = await load();

  const { audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: 2 },
    4359.87
  );

  assert.equal(audioDurationSeconds, 4359.87);
  assert.deepEqual(noteUpdates, { diarization_enabled: 1, expected_speaker_count: 2 });
});

test("auto speaker detection stores no explicit count", async () => {
  const { buildUploadNoteMetadata } = await load();

  const { noteUpdates } = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: null },
    60
  );

  // isExplicitSpeakerCount treats any positive integer as the user's own
  // choice, so auto detection must land as null, never a default.
  assert.equal(noteUpdates.expected_speaker_count, null);
  assert.equal(noteUpdates.diarization_enabled, 1);
});

test("disabled diarization writes no columns at all", async () => {
  const { buildUploadNoteMetadata } = await load();

  // A null diarization_enabled defers to the global speaker setting when the
  // user records into the note later (a 0 would force it off), and writing no
  // count keeps the numSpeakers value lingering in localStorage while its
  // input is hidden from being stamped onto the note as an explicit choice.
  const { audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    { enabled: false, localModelsReady: false, numSpeakers: 3 },
    120
  );

  assert.equal(noteUpdates, null);
  assert.equal(audioDurationSeconds, 120);
});

test("speaker counts reuse the stored-count clamp", async () => {
  const { buildUploadNoteMetadata } = await load();

  const above = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: MAX_SPEAKER_COUNT + 5 },
    null
  );
  assert.equal(above.noteUpdates.expected_speaker_count, MAX_SPEAKER_COUNT);

  const unusable = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: 0 },
    null
  );
  assert.equal(unusable.noteUpdates.expected_speaker_count, null);
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

test("upload titles fall back to the transcript, then the file name", async () => {
  const { uploadTitleFallback } = await load();

  assert.equal(uploadTitleFallback("one two three", "board.m4a"), "one two three");
  assert.equal(
    uploadTitleFallback("one two three four five six seven", "board.m4a"),
    "one two three four five six..."
  );
  assert.equal(uploadTitleFallback("   ", "board-meeting.m4a"), "board-meeting");
});

// uploadNotes.ts carries a renderer twin of the main-process
// normalizeStoredSpeakerCount (CJS, unloadable from renderer source). Hold the
// two implementations to identical outputs so they cannot drift apart.
test("speaker-count normalization matches the main-process implementation", async () => {
  const { buildUploadNoteMetadata } = await load();
  const { normalizeStoredSpeakerCount } = require("../../src/helpers/speakerCount");

  const inputs = [1, 2, 3, MAX_SPEAKER_COUNT, MAX_SPEAKER_COUNT + 1, MAX_SPEAKER_COUNT + 5];
  for (const value of [...inputs, 0, -1, 1.5, NaN, Infinity, -Infinity, null, undefined, "", {}]) {
    assert.equal(
      buildUploadNoteMetadata({ enabled: true, numSpeakers: value }).noteUpdates
        .expected_speaker_count,
      normalizeStoredSpeakerCount(value),
      `diverged from normalizeStoredSpeakerCount for ${JSON.stringify(value)}`
    );
  }
});
