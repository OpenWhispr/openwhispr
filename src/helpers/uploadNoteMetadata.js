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
// diarizer invocation, matching the meeting path's write semantics: the columns
// are written only when diarization ran. A null diarization_enabled means "user
// never chose" and consumers fall back to the global speaker setting — writing
// 0 would force diarization off when recording into the note later. The
// expected_speaker_count is only ever a count the diarizer was actually invoked
// with (numSpeakers lingers in localStorage while its input is hidden); auto
// detection stays null so isExplicitSpeakerCount never mistakes it for an
// explicit choice.
export function buildUploadNoteMetadata(diarization, durationSeconds) {
  return {
    audioDurationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    noteUpdates: diarization?.enabled
      ? {
          diarization_enabled: 1,
          expected_speaker_count: normalizeSpeakerCount(diarization.numSpeakers),
        }
      : null,
  };
}
