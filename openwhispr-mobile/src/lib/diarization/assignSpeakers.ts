import { UNKNOWN_SPEAKER_LABEL } from './diarizationBridge';
import type { SpeakerTurn } from './mergeSegments';

const overlapMs = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

const labelFor = (startMs: number, endMs: number, turns: SpeakerTurn[]): string | null => {
  const durationMs = endMs - startMs;
  if (!(durationMs > 0)) return null;
  // Summed per speaker: the engine often splits one person's speech into several turns.
  const bySpeaker = new Map<string, number>();
  for (const turn of turns) {
    if (turn.speakerLabel === UNKNOWN_SPEAKER_LABEL) continue;
    const overlap = overlapMs(startMs, endMs, turn.startMs, turn.endMs);
    if (overlap > 0) {
      bySpeaker.set(turn.speakerLabel, (bySpeaker.get(turn.speakerLabel) ?? 0) + overlap);
    }
  }
  let best: string | null = null;
  let bestMs = 0;
  for (const [label, ms] of bySpeaker) {
    if (ms > bestMs) {
      best = label;
      bestMs = ms;
    }
  }
  // A backfilled stretch can run two minutes with several people in it; pinning it on whoever
  // spoke longest would misattribute the rest, so a speaker must hold most of it.
  return bestMs * 2 > durationMs ? best : null;
};

/**
 * Each segment takes the label of the turn it overlaps most, when that speaker covers more than
 * half of it; otherwise (and with no overlap) it is unlabelled. Text and timing are untouched.
 */
export function assignSpeakersToSegments<
  T extends { startMs: number; endMs: number; speakerLabel?: string | null },
>(segments: T[], turns: SpeakerTurn[]): (T & { speakerLabel: string | null })[] {
  return segments.map((segment) => ({
    ...segment,
    speakerLabel: labelFor(segment.startMs, segment.endMs, turns),
  }));
}
