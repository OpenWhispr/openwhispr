import * as FileSystem from 'expo-file-system/legacy';
import { createTranscriptAudio } from './transcriptAudioCore';
export {
  extensionForAudio,
  isManagedTranscriptAudioUri,
  isWavAudioFile,
  RETAINED_AUDIO_MAX_AGE_MS,
} from './transcriptAudioCore';

const audio = createTranscriptAudio({ meetingDirectory: () => FileSystem.documentDirectory });
export const {
  isManagedMeetingAudioUri,
  retainTranscriptAudio,
  transcriptAudioExists,
  deleteManagedTranscriptAudio,
} = audio;
export const garbageCollectTranscriptAudio: (keepUris: Iterable<string>) => Promise<void> =
  audio.garbageCollectTranscriptAudio;
