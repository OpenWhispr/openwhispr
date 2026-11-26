import { Platform } from 'react-native';

// The current voiceprint extractor and enrollment audio analysis are iOS-only.
// Speech transcription and cloud speaker labels do not imply enrollment support.
export const supportsVoiceEnrollment = (): boolean => Platform.OS === 'ios';

export const VOICE_ENROLLMENT_UNAVAILABLE =
  'Voice training is not available in this Android build. You can still name speakers in meeting transcripts and manage existing profiles.';
