import type { ParakeetTokenTiming } from '../../../modules/parakeet-asr/src';
import type { WhisperSegment } from '../../types';

// Parakeet TDT emits SentencePiece subword tokens; a token starting with the boundary marker
// (▁, U+2581) or a literal space opens a new word. Punctuation tokens carry no marker, so they
// attach to the preceding word — same shape whisper.rn produces with maxLen: 1.
const WORD_BOUNDARY = '▁';
const SECONDS_TO_CENTISECONDS = 100;

interface WordAccumulator {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

function pushWord(segments: WhisperSegment[], word: WordAccumulator): void {
  const text = word.text.trim();
  if (text.length === 0) {
    return;
  }
  const t0 = Math.round(word.startSeconds * SECONDS_TO_CENTISECONDS);
  // TDT can emit zero-duration tokens; clamp so t1 never precedes t0.
  const t1 = Math.max(t0, Math.round(word.endSeconds * SECONDS_TO_CENTISECONDS));
  segments.push({ text, t0, t1 });
}

/**
 * Groups Parakeet token timings into word-level WhisperSegments (t0/t1 in centiseconds) so the
 * meeting-diarization pipeline (`whisperSegmentsToWords`) works identically for both engines.
 */
export function tokenTimingsToWhisperSegments(
  timings: readonly ParakeetTokenTiming[],
): WhisperSegment[] {
  const segments: WhisperSegment[] = [];
  let current: WordAccumulator | null = null;

  for (const timing of timings) {
    const opensWord = timing.token.startsWith(WORD_BOUNDARY) || timing.token.startsWith(' ');
    const text = timing.token.replace(/^[▁ ]+/, '');

    if (opensWord || current === null) {
      if (current) {
        pushWord(segments, current);
      }
      current = { text, startSeconds: timing.startTime, endSeconds: timing.endTime };
    } else {
      current.text += text;
      current.endSeconds = Math.max(current.endSeconds, timing.endTime);
    }
  }

  if (current) {
    pushWord(segments, current);
  }
  return segments;
}
