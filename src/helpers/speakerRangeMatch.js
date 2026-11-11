// Matches a transcript row's audio range to the live speaker identifications
// (epoch ms windows). Shared by main and the renderer, so keep it dependency-free.

// Identification windows keep growing while a speaker talks, so only recent ones can still overlap a row.
export const IDENTIFICATION_RETENTION_MS = 120_000;

export function rangeOverlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function pickSpeakerForRange(identifications, start, end) {
  // One speaker's windows grow cumulatively, so summing them would count the same audio repeatedly.
  const bySpeaker = new Map();
  for (const identification of identifications) {
    const overlapMs = rangeOverlapMs(
      start,
      end,
      identification.startTime,
      identification.endTime
    );
    if (overlapMs <= 0) continue;

    const previous = bySpeaker.get(identification.speakerId);
    bySpeaker.delete(identification.speakerId);
    // Re-inserting moves the speaker to the end, so a tie goes to the later identification.
    bySpeaker.set(identification.speakerId, {
      speakerId: identification.speakerId,
      displayName: identification.displayName ?? previous?.displayName ?? null,
      overlapMs: Math.max(overlapMs, previous?.overlapMs ?? 0),
    });
  }

  let best = null;
  for (const candidate of bySpeaker.values()) {
    if (!best || candidate.overlapMs >= best.overlapMs) best = candidate;
  }
  return best;
}

export function relabelForIdentification(row, identification) {
  const overlapMs = rangeOverlapMs(
    row.start,
    row.end,
    identification.startTime,
    identification.endTime
  );
  if (overlapMs <= row.overlapMs) return null;
  return {
    speakerId: identification.speakerId,
    displayName: identification.displayName ?? null,
    overlapMs,
  };
}

export function pruneIdentifications(
  identifications,
  newestEndTime,
  retentionMs = IDENTIFICATION_RETENTION_MS
) {
  return identifications.filter((id) => id.endTime >= newestEndTime - retentionMs);
}
