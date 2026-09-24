import type { WhisperSegment } from '@/types';
import type { DiarizationResult } from './diarizer';
import type { Word, SpeakerTurn } from './mergeSegments';

/** Label used when the diarizer cannot attribute a turn (speakerId === null). */
export const UNKNOWN_SPEAKER_LABEL = 'speaker_unknown';

/** Stable string label for a numeric (or null) diarizer speakerId. */
export const speakerLabelFor = (speakerId: number | null): string =>
  speakerId === null ? UNKNOWN_SPEAKER_LABEL : `speaker_${speakerId}`;

const CENTISECONDS_TO_MS = 10;
const SECONDS_TO_MS = 1000;

/**
 * whisper.rn segments (t0/t1 in CENTISECONDS) -> M1 Word[] (ms). Trims token text and
 * drops empty/whitespace-only tokens (mergeSegments joins with single spaces, no trim).
 */
export const whisperSegmentsToWords = (segments: WhisperSegment[]): Word[] =>
  segments
    .map((seg) => ({
      text: seg.text.trim(),
      startMs: Math.round(seg.t0 * CENTISECONDS_TO_MS),
      endMs: Math.round(seg.t1 * CENTISECONDS_TO_MS),
    }))
    .filter((word) => word.text.length > 0);

/** DiarizationResult (seconds, numeric/null speakerId) -> M1 SpeakerTurn[] (ms, string label). */
export const diarizationToTurns = (result: DiarizationResult): SpeakerTurn[] =>
  result.segments.map((seg) => ({
    speakerLabel: speakerLabelFor(seg.speakerId),
    startMs: Math.round(seg.start * SECONDS_TO_MS),
    endMs: Math.round(seg.end * SECONDS_TO_MS),
  }));
