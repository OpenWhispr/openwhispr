import {
  VOICE_ENROLLMENT_LOW_SNR,
  VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
  VOICE_ENROLLMENT_MULTIPLE_SPEAKERS,
  VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER,
  VOICE_ENROLLMENT_NO_SPEECH,
  VOICE_ENROLLMENT_PROFILE_NOT_FOUND,
  VOICE_ENROLLMENT_SHORT_SPEECH,
  VoiceEnrollmentError,
} from '@/services/diarization/VoiceprintService';

/** Shown for failures we can't explain; callers report these so they can be diagnosed. */
export const VOICE_ENROLLMENT_UNEXPLAINED_FAILURE =
  'Something went wrong checking your voice. Try again.';

/** Alert title and message for teaching your voice when you already have a profile. */
export const VOICE_ALREADY_TAUGHT_ALERT = [
  "You've already taught OpenWhispr your voice",
  'Open it in Voice Profiles and choose Retrain Voice.',
] as const;

// The speech detector never sets its bar above -30 dB, so a voice whose loudest moment
// stays below this reads as pauses or too little speech. Measured: failed reads peaked
// at -22 to -24 dB, a normal read at -9 dB.
const QUIET_PEAK_DB = -18;

const LEVEL_FAILURES = new Set<string>([
  VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
  VOICE_ENROLLMENT_SHORT_SPEECH,
  VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER,
]);

const wasTooQuiet = (error: VoiceEnrollmentError): boolean => {
  const quality = error.quality;
  const peakDb = quality && !quality.ok ? quality.speechActivity?.peakDb : undefined;
  return peakDb !== undefined && peakDb < QUIET_PEAK_DB;
};

/** What to tell someone whose voice sample failed, in words they can act on. */
export function voiceEnrollmentFailureMessage(error: unknown): string {
  if (!(error instanceof VoiceEnrollmentError)) return VOICE_ENROLLMENT_UNEXPLAINED_FAILURE;
  const { code } = error;
  if (LEVEL_FAILURES.has(code) && wasTooQuiet(error)) {
    return 'We could barely hear you. Speak up or hold your phone closer.';
  }
  switch (code) {
    case VOICE_ENROLLMENT_NO_SPEECH:
      return "We couldn't hear you. Check that nothing is covering the microphone, then try again.";
    case VOICE_ENROLLMENT_SHORT_SPEECH:
      return "We didn't hear enough. Read the whole script.";
    case VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER:
      return "We couldn't pick out your voice. Read the whole script with your phone close by.";
    case VOICE_ENROLLMENT_LOW_SNR:
      return 'Too much background noise. Try somewhere quieter.';
    case VOICE_ENROLLMENT_LOW_SPEECH_RATIO:
      return 'Lots of pauses. Read at your normal pace.';
    case VOICE_ENROLLMENT_MULTIPLE_SPEAKERS:
      return 'We heard more than one voice. Try again on your own.';
    case VOICE_ENROLLMENT_PROFILE_NOT_FOUND:
      return 'This voice profile was deleted. Go back to Voice Profiles to add it again.';
    default:
      return VOICE_ENROLLMENT_UNEXPLAINED_FAILURE;
  }
}
