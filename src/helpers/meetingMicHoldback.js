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

module.exports = { partitionPendingMicFinals, isWithinRetractWindow };
