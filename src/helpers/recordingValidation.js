import { isEmptyRecording } from "./recordingGuard.js";

// Decide whether a finished MediaRecorder session carries real audio before we
// hand it to the transcription backend. A fast tap can flush only the container
// header, or deliver no chunks at all, which crashes FFmpeg. See issue #871.
export function evaluateFinishedRecording({ blobSize, receivedAudioData } = {}) {
  if (!receivedAudioData) {
    return { usable: false, reason: "no-audio-data" };
  }
  if (isEmptyRecording(blobSize)) {
    return { usable: false, reason: "empty-container" };
  }
  return { usable: true, reason: null };
}

// A salvaged recording (segment merge failed, only the largest segment was
// kept) yields a transcript missing the dropped segments' audio. Mark the
// result so the renderer shows its partial-transcription warning; an existing
// warning (e.g. a truncated decode) already does.
export function withSalvageWarning(result, salvaged) {
  if (!salvaged || !result?.success || result.warning) return result;
  return { ...result, warning: "salvaged-recording" };
}
