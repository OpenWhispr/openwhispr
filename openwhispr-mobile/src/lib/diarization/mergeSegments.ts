export interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SpeakerTurn {
  speakerLabel: string;
  startMs: number;
  endMs: number;
}

export interface MergedSegment {
  text: string;
  startMs: number;
  endMs: number;
  speakerLabel: string;
}

interface LabeledWord extends Word {
  speakerLabel: string;
}

const overlapMs = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

const bestTurnLabel = (word: Word, turns: SpeakerTurn[]): string | null => {
  let best: string | null = null;
  let bestOverlap = 0;
  for (const turn of turns) {
    const ov = overlapMs(word.startMs, word.endMs, turn.startMs, turn.endMs);
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = turn.speakerLabel;
    }
  }
  return best;
};

const groupConsecutive = (words: LabeledWord[]): MergedSegment[] => {
  const segments: MergedSegment[] = [];
  for (const word of words) {
    const last = segments[segments.length - 1];
    if (last && last.speakerLabel === word.speakerLabel) {
      last.text = `${last.text} ${word.text}`;
      last.endMs = word.endMs;
    } else {
      segments.push({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        speakerLabel: word.speakerLabel,
      });
    }
  }
  return segments;
};

// Relabel sub-minimum-duration segments to their previous neighbor so brief
// interjections ("yeah") don't spawn phantom speakers. Iterates to convergence:
// each effective pass merges at least one blip (reducing segment count by ≥1),
// so the loop is bounded by initial.length and cannot infinite-loop.
// Leading segments (no previous neighbor) are never absorbed.
const absorbShortBlips = (initial: MergedSegment[], minSegmentMs: number): MergedSegment[] => {
  if (minSegmentMs === 0) return initial;

  let segments = initial;
  for (let pass = 0; pass < initial.length; pass++) {
    if (segments.length <= 1) break;

    let changed = false;
    const relabeled = segments.map((seg, i) => {
      if (i === 0) return seg; // never absorb a leading segment
      const dur = seg.endMs - seg.startMs;
      if (dur >= minSegmentMs) return seg;
      const prevLabel = segments[i - 1].speakerLabel;
      changed = true;
      return { ...seg, speakerLabel: prevLabel };
    });

    const asWords: LabeledWord[] = relabeled.map((s) => ({
      text: s.text,
      startMs: s.startMs,
      endMs: s.endMs,
      speakerLabel: s.speakerLabel,
    }));
    segments = groupConsecutive(asWords);
    if (!changed) break;
  }
  return segments;
};

/**
 * Align time-stamped words to diarizer speaker turns and return merged segments.
 *
 * **Blip absorption is OPT-IN.** With the default `minSegmentMs = 0` no
 * merging occurs — output mirrors diarizer turns literally. Pass
 * `minSegmentMs > 0` (e.g. 1500) to absorb short blips; M2 should set and
 * tune this value against real audio.
 *
 * **Known limitations deferred to M2:**
 * (a) A short *leading* segment (index 0) is never absorbed — no previous
 *     neighbor exists to absorb it into.
 * (b) Word `text` is joined with single spaces and NOT trimmed, so
 *     empty/whitespace-only word tokens produce stray or double spaces —
 *     normalize tokens before calling and/or trim after.
 */
export const mergeWordsWithSpeakers = (
  words: Word[],
  turns: SpeakerTurn[],
  opts: { minSegmentMs?: number } = {},
): MergedSegment[] => {
  if (words.length === 0) return [];
  const minSegmentMs = opts.minSegmentMs ?? 0;

  let prevLabel = turns[0]?.speakerLabel ?? 'speaker_0';
  const labeled: LabeledWord[] = words.map((word) => {
    const label = bestTurnLabel(word, turns) ?? prevLabel;
    prevLabel = label;
    return { ...word, speakerLabel: label };
  });

  return absorbShortBlips(groupConsecutive(labeled), minSegmentMs);
};
