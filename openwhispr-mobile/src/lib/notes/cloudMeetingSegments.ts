import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import type { NewSegment } from '@/data/types';

/** A transcript segment ready to persist, minus noteId (injected at write time). */
export type CloudMeetingSegment = Omit<NewSegment, 'noteId'>;

/**
 * Segments in the order they were spoken, sortOrder renumbered to match, since every reader puts
 * sortOrder before time. Utterances finish out of that order: at a leg rotation and at Stop, the
 * retired leg's last turn finishes after the new leg's first. Stable, so of two segments that
 * start together the one listed first stays first.
 */
export function inSpokenOrder<T extends { startMs: number }>(
  segments: T[],
): (T & { sortOrder: number })[] {
  return [...segments]
    .sort((a, b) => a.startMs - b.startMs)
    .map((segment, index) => ({ ...segment, sortOrder: index }));
}

/**
 * Maps finalized realtime utterances to persistable transcript segments, in spoken order.
 *
 * `transcript_segments.startMs/endMs` are NOT NULL, but a realtime utterance's
 * timings can be null (the transcription session may not emit VAD timing), so
 * absent timings fall back to values derived from the utterance's position
 * across the captured audio, never before the utterance that finished ahead of
 * it — keeping segments ordered and non-null. Speakers are unlabeled: OpenAI
 * realtime transcription returns no diarization.
 */
export function mapUtterancesToSegments(
  utterances: RealtimeUtterance[],
  capturedSeconds: number,
): CloudMeetingSegment[] {
  const totalMs = Math.max(0, capturedSeconds) * 1000;
  const count = utterances.length;
  let previousEndMs = 0;
  return inSpokenOrder(
    utterances.map((utterance, index) => {
      const spreadStart = count > 0 ? Math.round((index / count) * totalMs) : 0;
      const spreadEnd = count > 0 ? Math.round(((index + 1) / count) * totalMs) : totalMs;
      const fallbackStart = Math.max(spreadStart, previousEndMs);
      const startMs = utterance.startMs ?? fallbackStart;
      const endMs = Math.max(utterance.endMs ?? Math.max(spreadEnd, fallbackStart), startMs);
      previousEndMs = endMs;
      return { text: utterance.text.trim(), startMs, endMs, speakerLabel: null };
    }),
  );
}
