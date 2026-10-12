import type { Segment, Speaker } from '@/data/types';
import { getSpeakerDisplayName } from '@/lib/diarization/transcriptDisplay';
import { hasFiniteNonZeroNorm } from '@/lib/diarization/voiceprints';
import { ENROLLMENT_MIN_SPEECH_ACTIVITY_MS } from '@/services/diarization/VoiceprintService';

export interface VoiceSetupCandidate {
  speakerId: number;
  name: string;
  speechMs: number;
  sampleLine: string;
}

/**
 * The meeting-note banner. It only shows when That's me can work: the meeting was diarized
 * on this device and a speaker's sample is still held from it (samples don't survive a
 * restart), so it never opens onto an empty sheet.
 */
export function shouldOfferVoiceSetup({
  isOnDeviceMeeting,
  transcriptStatus,
  hasOwnerProfile,
  dismissed,
  candidateCount,
}: {
  isOnDeviceMeeting: boolean;
  transcriptStatus: string;
  hasOwnerProfile: boolean;
  dismissed: boolean;
  candidateCount: number;
}): boolean {
  return (
    isOnDeviceMeeting &&
    transcriptStatus === 'done' &&
    !hasOwnerProfile &&
    !dismissed &&
    candidateCount > 0
  );
}

/**
 * Speakers who said enough, with a sample still held from this meeting, longest first. A
 * speaker still pointing at a deleted profile counts as unlinked, so you can claim it again.
 */
export function voiceSetupCandidates({
  segments,
  speakers,
  embeddingsByLabel,
  profileIds,
}: {
  segments: Segment[];
  speakers: Speaker[];
  embeddingsByLabel: Record<string, number[]> | undefined;
  profileIds: ReadonlySet<number>;
}): VoiceSetupCandidate[] {
  return speakers
    .filter(
      (speaker) =>
        (speaker.profileId == null || !profileIds.has(speaker.profileId)) &&
        hasFiniteNonZeroNorm(embeddingsByLabel?.[speaker.speakerLabel]),
    )
    .map((speaker) => {
      const own = segments.filter((segment) => segment.speakerLabel === speaker.speakerLabel);
      const speechMs = own.reduce(
        (total, segment) => total + Math.max(0, segment.endMs - segment.startMs),
        0,
      );
      const sampleLine = own
        .map((segment) => segment.text.trim())
        .reduce((longest, text) => (text.length > longest.length ? text : longest), '');
      return {
        speakerId: speaker.id,
        name: getSpeakerDisplayName(speaker, speaker.sortOrder),
        speechMs,
        sampleLine,
      };
    })
    .filter((candidate) => candidate.speechMs >= ENROLLMENT_MIN_SPEECH_ACTIVITY_MS)
    .sort((a, b) => b.speechMs - a.speechMs);
}

/** "45 sec", "3 min": how long someone spoke, not a position in the recording. */
export function formatSpeakingTime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`;
}
