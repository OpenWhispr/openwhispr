import {
  VOICE_ENROLLMENT_DIARIZATION_FAILED,
  VOICE_ENROLLMENT_LOW_SNR,
  VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
  VOICE_ENROLLMENT_MULTIPLE_SPEAKERS,
  VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER,
  VOICE_ENROLLMENT_NO_SPEECH,
  VOICE_ENROLLMENT_PROFILE_NOT_FOUND,
  VOICE_ENROLLMENT_SHORT_SPEECH,
  VoiceEnrollmentError,
  type EnrollmentQualityFailureCode,
} from '@/services/diarization/VoiceprintService';
import {
  VOICE_ENROLLMENT_UNEXPLAINED_FAILURE,
  voiceEnrollmentFailureMessage,
} from '../voiceEnrollmentMessages';

const failure = (code: ConstructorParameters<typeof VoiceEnrollmentError>[0]) =>
  voiceEnrollmentFailureMessage(new VoiceEnrollmentError(code, 'raw service text'));

describe('voiceEnrollmentFailureMessage', () => {
  it('asks for the whole script when too little speech was heard', () => {
    expect(failure(VOICE_ENROLLMENT_SHORT_SPEECH)).toBe(
      "We didn't hear enough. Read the whole script.",
    );
    expect(failure(VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER)).toBe(
      "We couldn't pick out your voice. Read the whole script with your phone close by.",
    );
  });

  it('points at the microphone when nothing was heard at all', () => {
    expect(failure(VOICE_ENROLLMENT_NO_SPEECH)).toBe(
      "We couldn't hear you. Check that nothing is covering the microphone, then try again.",
    );
  });

  it('says so when the profile being retrained was deleted', () => {
    expect(failure(VOICE_ENROLLMENT_PROFILE_NOT_FOUND)).toBe(
      'This voice profile was deleted. Go back to Voice Profiles to add it again.',
    );
  });

  it('explains noise, pauses and extra voices', () => {
    expect(failure(VOICE_ENROLLMENT_LOW_SNR)).toBe(
      'Too much background noise. Try somewhere quieter.',
    );
    expect(failure(VOICE_ENROLLMENT_LOW_SPEECH_RATIO)).toBe(
      'Lots of pauses. Read at your normal pace.',
    );
    expect(failure(VOICE_ENROLLMENT_MULTIPLE_SPEAKERS)).toBe(
      'We heard more than one voice. Try again on your own.',
    );
  });

  describe('when the recording was quiet', () => {
    const levelFailure = (code: EnrollmentQualityFailureCode, peakDb: number) =>
      voiceEnrollmentFailureMessage(
        new VoiceEnrollmentError(code, 'raw service text', {
          ok: false,
          code,
          reason: 'raw service text',
          speechActivity: {
            durationMs: 16_906,
            analyzedMs: 16_906,
            speechActivityMs: 3_397,
            speechRatio: 0.2,
            peakDb,
            averageDb: -34,
            noiseFloorDb: -37.3,
            thresholdDb: -30,
            noSpeechLikely: false,
            reason: 'speech_activity_detected',
            confidence: 0.65,
          },
        }),
      );
    const quiet = 'We could barely hear you. Speak up or hold your phone closer.';

    it('blames the volume, not pauses or length', () => {
      // Levels logged from a simulator read through a Mac mic at 29% input volume.
      expect(levelFailure(VOICE_ENROLLMENT_LOW_SPEECH_RATIO, -22.6)).toBe(quiet);
      expect(levelFailure(VOICE_ENROLLMENT_SHORT_SPEECH, -22.6)).toBe(quiet);
      expect(levelFailure(VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER, -22.6)).toBe(quiet);
    });

    it('keeps the pause and length messages when the voice was loud enough', () => {
      expect(levelFailure(VOICE_ENROLLMENT_LOW_SPEECH_RATIO, -9.4)).toBe(
        'Lots of pauses. Read at your normal pace.',
      );
      expect(levelFailure(VOICE_ENROLLMENT_SHORT_SPEECH, -9.4)).toBe(
        "We didn't hear enough. Read the whole script.",
      );
      expect(levelFailure(VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER, -9.4)).toBe(
        "We couldn't pick out your voice. Read the whole script with your phone close by.",
      );
    });

    it('draws the line at a loudest moment of -18 dB', () => {
      expect(levelFailure(VOICE_ENROLLMENT_LOW_SPEECH_RATIO, -18)).toBe(
        'Lots of pauses. Read at your normal pace.',
      );
      expect(levelFailure(VOICE_ENROLLMENT_LOW_SPEECH_RATIO, -18.1)).toBe(quiet);
    });

    it("keeps the noise and second-voice messages, which a quiet voice doesn't explain", () => {
      expect(levelFailure(VOICE_ENROLLMENT_LOW_SNR, -30)).toBe(
        'Too much background noise. Try somewhere quieter.',
      );
      expect(levelFailure(VOICE_ENROLLMENT_MULTIPLE_SPEAKERS, -30)).toBe(
        'We heard more than one voice. Try again on your own.',
      );
    });
  });

  it('falls back to a general message for anything else', () => {
    const general = VOICE_ENROLLMENT_UNEXPLAINED_FAILURE;
    expect(failure(VOICE_ENROLLMENT_DIARIZATION_FAILED)).toBe(general);
    expect(voiceEnrollmentFailureMessage(new Error('boom'))).toBe(general);
    expect(voiceEnrollmentFailureMessage(null)).toBe(general);
  });
});
