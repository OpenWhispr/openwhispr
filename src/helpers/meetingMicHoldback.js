/**
 * Partitions buffered ("risky") meeting mic finals into entries still inside
 * their holdback window, confirmed system-audio duplicates, and entries to
 * release.
 *
 * Policy: a text match (`isDuplicate`) is the only condition that may drop a
 * held-back segment. Audio-only echo evidence delays a segment, never
 * discards it — field logs showed genuine local speech scoring correlations
 * of 0.73–0.81 during double-talk, above every audio gate. Released segments
 * with bleed flags can still be retracted when a matching system transcript
 * arrives late (see removeRacingMicEntriesFor in ipcHandlers.js).
 */
const partitionPendingMicFinals = ({ pending, now, force = false, isDuplicate }) => {
  const deferred = [];
  const duplicates = [];
  const releases = [];

  for (const entry of pending) {
    if (!force && entry.releaseAt > now) {
      deferred.push(entry);
      continue;
    }

    if (isDuplicate(entry)) {
      duplicates.push(entry);
      continue;
    }

    releases.push(entry);
  }

  return { deferred, duplicates, releases };
};

/**
 * A committed mic segment may be retracted by an arriving system transcript
 * when the two plausibly describe the same audio. Capture timestamps race
 * directly for segments committed on arrival; held-back segments commit only
 * after their holdback window, so their confirming transcript — delayed by up
 * to a transcription cycle — races their commit time instead. Without the
 * commit-time comparison, a segment released at capture + holdback could
 * never be retracted: the confirming transcript always arrives more than
 * `holdback` away from the capture timestamp.
 */
const isWithinRetractWindow = ({ candidate, systemTimestamp, windowMs }) => {
  if (Math.abs(candidate.timestamp - systemTimestamp) <= windowMs) {
    return true;
  }

  return (
    candidate.committedAt != null &&
    systemTimestamp >= candidate.timestamp &&
    Math.abs(candidate.committedAt - systemTimestamp) <= windowMs
  );
};

/**
 * A mic final is "risky" (held back rather than committed on arrival) during
 * the startup warmup, whenever the system tap was speaking, or when the audio
 * analysis flagged double-talk / render bleed. Verified 2026-08-17: bare
 * `systemSpeaking` is sufficient today (design plan D4b tightens this).
 * @returns {boolean|undefined} falsy (may be `undefined`, not `false`) when not risky — callers test truthiness only.
 */
const isRiskyMicDuplicateProfile = ({ suppression = null, inStartupWarmup = false } = {}) => {
  if (inStartupWarmup) {
    return true;
  }
  if (suppression?.systemSpeaking) {
    return true;
  }
  return (
    !!suppression &&
    (suppression.reason === "double_talk" ||
      suppression.hasBleedEvidence ||
      suppression.likelyRenderBleed)
  );
};

/**
 * Text-layer duplicate check for a mic final: strict overlap when bleed
 * evidence exists, relaxed overlap for double-talk. `hasNearbyTranscriptMatch`
 * is ipcHandlers' closure over the committed system segments.
 */
const isDuplicateMicSegment = ({
  text,
  timestamp,
  suppression = null,
  hasNearbyTranscriptMatch,
}) => {
  if (suppression?.likelyRenderBleed || suppression?.hasBleedEvidence) {
    if (hasNearbyTranscriptMatch("system", text, timestamp)) {
      return true;
    }
  }

  if (suppression?.reason === "double_talk") {
    return hasNearbyTranscriptMatch("system", text, timestamp, { relaxed: true });
  }

  return false;
};

/**
 * Indices (descending) of committed mic segments that an arriving system final
 * proves to be echo. Scans newest→oldest and stops early once a candidate is
 * older than the largest window (today's `break`; the array is committedAt-
 * ordered, so this is an optimisation that is only unsound under mixed
 * per-candidate windows — see the characterization test).
 */
const selectRacingMicEntryIndices = ({
  segments,
  systemText,
  systemTimestamp,
  hasNearbyTranscriptMatch,
  duplicateWindowMs,
  retractWindowMs,
}) => {
  const removedIndices = [];
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const candidate = segments[i];
    if (candidate.source !== "mic" || candidate.timestamp == null) continue;
    if (systemTimestamp != null) {
      const windowMs =
        candidate.hasBleedEvidence || candidate.likelyRenderBleed
          ? duplicateWindowMs
          : retractWindowMs;
      if (!isWithinRetractWindow({ candidate, systemTimestamp, windowMs })) {
        if (candidate.timestamp < systemTimestamp - duplicateWindowMs) break;
        continue;
      }
    }
    const hasMicDuplicateRisk =
      candidate.likelyRenderBleed ||
      candidate.hasBleedEvidence ||
      candidate.suppressionReason === "double_talk";
    const overlapsSystem = hasNearbyTranscriptMatch("system", candidate.text, candidate.timestamp, {
      extraSegment: {
        text: systemText,
        timestamp: systemTimestamp,
      },
      relaxed: candidate.suppressionReason === "double_talk",
    });
    if (hasMicDuplicateRisk && overlapsSystem) {
      removedIndices.push(i);
    }
  }
  return removedIndices;
};

/**
 * Splits the pending (held-back) mic finals into those that overlap an
 * arriving system final (`removed`) and the rest (`kept`). No risk-flag check
 * today — any overlapping pending final is dropped (design plan Phase 2 routes
 * this into the pending pipeline).
 */
const partitionOverlappingPendingMicFinals = ({
  pending,
  systemText,
  systemTimestamp,
  hasNearbyTranscriptMatch,
}) => {
  const kept = [];
  const removed = [];
  for (const candidate of pending) {
    const overlapsSystem = hasNearbyTranscriptMatch("system", candidate.text, candidate.timestamp, {
      extraSegment: {
        text: systemText,
        timestamp: systemTimestamp,
      },
      relaxed: candidate.micSuppression?.reason === "double_talk",
    });
    (overlapsSystem ? removed : kept).push(candidate);
  }
  return { kept, removed };
};

module.exports = {
  partitionPendingMicFinals,
  isWithinRetractWindow,
  isRiskyMicDuplicateProfile,
  isDuplicateMicSegment,
  selectRacingMicEntryIndices,
  partitionOverlappingPendingMicFinals,
};
