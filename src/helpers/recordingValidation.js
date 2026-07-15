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
