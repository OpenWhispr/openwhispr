// Matches a transcript row's audio range to the live speaker identifications
// (epoch ms windows). Shared by main and the renderer, so keep it dependency-free.

// Identification windows keep growing while a speaker talks, so only recent ones can still overlap a row.
export const IDENTIFICATION_RETENTION_MS = 120_000;

export function rangeOverlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Every identification within one speech segment shares the segment's start and
// covers all of it so far, and a segment can span a change of speaker. Each one is
// credited only with the audio it added after the previous one, so the slices of a
// segment never overlap and can be summed per speaker.
function identificationSlices(identifications) {
  const bySegment = new Map();
  identifications.forEach((identification, order) => {
    const group = bySegment.get(identification.startTime) ?? [];
    group.push({ identification, order });
    bySegment.set(identification.startTime, group);
  });

  const slices = [];
  for (const group of bySegment.values()) {
    group.sort(
      (left, right) =>
        left.identification.endTime - right.identification.endTime || left.order - right.order
    );
    let sliceStart = group[0].identification.startTime;
    for (const { identification, order } of group) {
      slices.push({ identification, order, start: sliceStart, end: identification.endTime });
      sliceStart = Math.max(sliceStart, identification.endTime);
    }
  }
  return slices;
}

const isHeardMoreRecently = (candidate, other) =>
  candidate.latestEnd > other.latestEnd ||
  (candidate.latestEnd === other.latestEnd && candidate.latestOrder > other.latestOrder);

export function pickSpeakerForRange(identifications, start, end) {
  const bySpeaker = new Map();
  for (const slice of identificationSlices(identifications)) {
    const overlapMs = rangeOverlapMs(start, end, slice.start, slice.end);
    if (overlapMs <= 0) continue;

    const { speakerId, displayName } = slice.identification;
    const candidate = bySpeaker.get(speakerId) ?? {
      speakerId,
      displayName: null,
      nameOrder: -1,
      overlapMs: 0,
      latestEnd: -Infinity,
      latestOrder: -1,
    };
    candidate.overlapMs += overlapMs;
    if (displayName != null && slice.order > candidate.nameOrder) {
      candidate.displayName = displayName;
      candidate.nameOrder = slice.order;
    }
    if (isHeardMoreRecently({ latestEnd: slice.end, latestOrder: slice.order }, candidate)) {
      candidate.latestEnd = slice.end;
      candidate.latestOrder = slice.order;
    }
    bySpeaker.set(speakerId, candidate);
  }

  let best = null;
  for (const candidate of bySpeaker.values()) {
    if (
      !best ||
      candidate.overlapMs > best.overlapMs ||
      (candidate.overlapMs === best.overlapMs && isHeardMoreRecently(candidate, best))
    ) {
      best = candidate;
    }
  }
  return best
    ? { speakerId: best.speakerId, displayName: best.displayName, overlapMs: best.overlapMs }
    : null;
}

// `row` is { speaker, speakerName, speakerStatus, speakerIsPlaceholder }. A row keeps
// its name when the pick has none for the same speaker, so only a move, a label
// that isn't confirmed yet, or a new name is a change.
export function rangedLabelChanges(row, heard) {
  return (
    row.speaker !== heard.speakerId ||
    row.speakerIsPlaceholder === true ||
    row.speakerStatus !== "confirmed" ||
    (heard.displayName != null && heard.displayName !== row.speakerName)
  );
}

export function pruneIdentifications(
  identifications,
  newestEndTime,
  retentionMs = IDENTIFICATION_RETENTION_MS
) {
  return identifications.filter((id) => id.endTime >= newestEndTime - retentionMs);
}
