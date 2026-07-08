/**
 * Holdback policy for buffered ("risky") meeting mic finals.
 *
 * Mic segments that overlap system audio (double-talk, echo-leak evidence,
 * startup warmup, system speech activity) are buffered for a holdback window
 * before being committed, giving the system channel time to produce a
 * transcript that confirms the mic text as an echo duplicate.
 *
 * Policy: a held-back mic segment may only be dropped when system transcript
 * text actually matches it (`isDuplicate`). Audio-only echo evidence
 * (correlation/residual heuristics) is enough to delay a segment, never to
 * discard it — field logs showed genuine local speech scoring correlations
 * of 0.73–0.81 during double-talk, above every audio gate.
 *
 * Coverage after release: bleed-flagged segments can still be retracted by
 * the racing retract when their matching system transcript arrives late
 * (`removeRacingMicEntriesFor` widens its window for them). Segments buffered
 * only for warmup or system speech activity carry no bleed flags, so the
 * duplicate matcher never confirms them — their drop opportunity is a system
 * transcript arriving while they are still buffered; after release they are
 * committed. The post-meeting merge dedupe additionally filters the
 * diarization payload, but does not rewrite segments already committed live.
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

module.exports = { partitionPendingMicFinals };
