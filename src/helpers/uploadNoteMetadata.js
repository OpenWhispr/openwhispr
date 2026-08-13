import { MAX_SPEAKER_COUNT } from "../constants/speakerDetection.json";

// Renderer twin of normalizeStoredSpeakerCount in ./speakerCount.js. That file
// is CommonJS for the main process (database.js, ipcHandlers.js), and renderer
// source cannot load CJS modules under Vite — test/helpers/uploadNoteMetadata
// .test.js holds the two implementations to identical outputs.
function normalizeSpeakerCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) return null;
  return Math.min(count, MAX_SPEAKER_COUNT);
}

// What the upload and URL-ingest flows persist onto the note row about the
// diarizer invocation. The meeting path writes the same columns with the same
// semantics: diarization_enabled is 1|0 (null means unknown), and
// expected_speaker_count is only ever a user-chosen total — auto detection
// stays null so isExplicitSpeakerCount never mistakes it for an explicit
// choice.
export function buildUploadNoteMetadata(diarization, durationSeconds) {
  return {
    audioDurationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    noteUpdates: {
      diarization_enabled: diarization?.enabled ? 1 : 0,
      expected_speaker_count: normalizeSpeakerCount(diarization?.numSpeakers),
    },
  };
}
