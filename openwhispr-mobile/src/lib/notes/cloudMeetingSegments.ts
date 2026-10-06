import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import type { NewSegment } from '@/data/types';

/** A transcript segment ready to persist, minus noteId (injected at write time). */
export type CloudMeetingSegment = Omit<NewSegment, 'noteId'>;

/**
 * Maps finalized realtime utterances to persistable transcript segments.
 *
 * `transcript_segments.startMs/endMs` are NOT NULL, but a realtime utterance's
 * timings can be null (the transcription session may not emit VAD timing), so
 * absent timings fall back to values derived from the utterance's position
 * across the elapsed recording — keeping segments ordered and non-null. Speakers
 * are unlabeled: OpenAI realtime transcription returns no diarization.
 */
export function mapUtterancesToSegments(
  utterances: RealtimeUtterance[],
  elapsedSeconds: number,
): CloudMeetingSegment[] {
  const totalMs = Math.max(0, elapsedSeconds) * 1000;
  const count = utterances.length;
  return utterances.map((utterance, index) => {
    const fallbackStart = count > 0 ? Math.round((index / count) * totalMs) : 0;
    const fallbackEnd = count > 0 ? Math.round(((index + 1) / count) * totalMs) : totalMs;
    const startMs = utterance.startMs ?? fallbackStart;
    const endMs = Math.max(utterance.endMs ?? fallbackEnd, startMs);
    return {
      text: utterance.text.trim(),
      startMs,
      endMs,
      speakerLabel: null,
      sortOrder: index,
    };
  });
}
