import { meetingAudioDirectory } from './meetingAudioStorage';
import { createTranscriptAudio } from './transcriptAudioCore';
export {
  extensionForAudio,
  isManagedTranscriptAudioUri,
  isWavAudioFile,
  RETAINED_AUDIO_MAX_AGE_MS,
} from './transcriptAudioCore';

// Protect copied audio until history owns it, including during account reloads.
export const {
  isManagedMeetingAudioUri,
  retainTranscriptAudio,
  transcriptAudioExists,
  deleteManagedTranscriptAudio,
  garbageCollectTranscriptAudio,
  releaseTranscriptAudio,
} = createTranscriptAudio({
  meetingDirectory: meetingAudioDirectory,
  activeCopies: new Set<string>(),
});
