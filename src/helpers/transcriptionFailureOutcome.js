import { DICTIONARY_ECHO_CODE } from "../utils/dictionaryEchoFilter.js";

// How a transcription failure ends, for batch recordings and re-uploaded
// streaming ones alike. Silence is not reported. A transcript discarded as an
// echo of the dictionary prompt, or audio Cloud found no speech in, reads as
// silence, but its recording is kept for a manual retry like any real
// failure's, or the utterance vanishes (#1547).
export const transcriptionFailureOutcome = (error) => {
  if (error.code === DICTIONARY_ECHO_CODE || error.code === "NO_SPEECH_DETECTED") {
    return { noAudio: true, keepAudio: true, report: null };
  }
  if (error.message === "No audio detected") {
    return { noAudio: true, keepAudio: false, report: null };
  }
  return {
    noAudio: false,
    keepAudio: true,
    report: {
      title: error.selectionEditFatal ? "Selection Edit Failed" : "Transcription Error",
      description: error.selectionEditFatal
        ? error.message
        : `Transcription failed: ${error.message}`,
      code: error.code,
      messageKey: error.messageKey,
    },
  };
};
