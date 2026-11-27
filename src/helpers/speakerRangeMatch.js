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
    const segmentStart = identification.speechStartTime ?? identification.startTime;
    // A whole-turn rejudgment supersedes every tentative slice of this turn.
    const group = identification.rejudged ? [] : (bySegment.get(segmentStart) ?? []);
    group.push({ identification, order });
    bySegment.set(segmentStart, group);
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

// An identification's window is padded on both sides, so it reaches a reply that
// starts right after its speaker stops. Its speech range, when it has one, is the
// part that is the speaker's own, and two speech ranges never overlap unless they
// belong to the same segment. So a row first given to a speaker by padding alone
// goes to the speaker in whose speech it starts.
export function isWithinSpeech(identification, timestamp) {
  return (
    identification.speechStartTime != null &&
    identification.speechEndTime != null &&
    timestamp >= identification.speechStartTime &&
    timestamp <= identification.speechEndTime
  );
}

// Reproduce live delivery for a late cloud final. The first padded window can
// supply a label until an identification actually hears speech at the point.
export function pickIdentificationForPoint(identifications, timestamp) {
  let picked = null;
  for (const identification of identifications) {
    if (timestamp < identification.startTime || timestamp > identification.endTime) continue;
    if (!picked || isWithinSpeech(identification, timestamp)) picked = identification;
  }
  return picked;
}

export function takesRowFromOtherSpeaker(row, timestamp, identification) {
  return row.speaker !== identification.speakerId && isWithinSpeech(identification, timestamp);
}

// A retroactive window can be minutes old. The identifications that gave a ranged
// row its speaker may be pruned by then, so the window would win the row on any
// overlap. It moves a confirmed row only when it covers at least half of it.
export function retroactiveMayMoveRangedRow(row, start, end, identification, history = []) {
  if (
    identification.retroactive !== true ||
    row.speakerStatus !== "confirmed" ||
    row.speakerIsPlaceholder === true ||
    row.speaker === identification.speakerId
  ) {
    return true;
  }
  const overlapMs = rangeOverlapMs(start, end, identification.startTime, identification.endTime);
  if (overlapMs * 2 >= end - start) return true;
  // If the tentative window is still available, re-score with its correction
  // even when this turn only covers a fraction of a mostly silent local row.
  return (
    identification.rejudged === true &&
    history.some(
      (prior) =>
        prior.tentative === true &&
        prior.speakerId === row.speaker &&
        prior.speechStartTime === identification.speechStartTime &&
        rangeOverlapMs(start, end, prior.startTime, prior.endTime) > 0
    )
  );
}

export function pruneIdentifications(identifications, newestEndTime, retainFromTime = Infinity) {
  const cutoff = Math.min(newestEndTime - IDENTIFICATION_RETENTION_MS, retainFromTime);
  return identifications.filter((identification) => identification.endTime >= cutoff);
}
