import * as Sentry from '@sentry/react-native';
import { notesRepository } from '@/data';

// A park is a normal, self-healing outcome the first time or two: the space or
// folder a row needs simply hasn't been mirrored yet, and the next run's
// syncSpaces/pullFolders pass fixes it. A row that parks run after run is a
// wedge instead — the crawl never advances past it — and an info breadcrumb
// alone makes that invisible. Track the streak so it can escalate.
const ESCALATE_AFTER_RUNS = 3;

/** Stored as `<rowId>:<consecutiveParks>`; empty means nothing is parked. */
function readStreak(stateKey: string, rowId: string): number {
  const raw = notesRepository.getSyncState(stateKey);
  if (!raw) return 0;
  const separator = raw.lastIndexOf(':');
  if (separator < 0) return 0;
  if (raw.slice(0, separator) !== rowId) return 0;
  const count = Number.parseInt(raw.slice(separator + 1), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Records that `rowId` parked this run and reports it: a breadcrumb while the
 * park still looks transient, a warning-level Sentry message once the same row
 * has parked ESCALATE_AFTER_RUNS runs in a row.
 */
export function recordPark(stateKey: string, rowId: string, message: string): void {
  const streak = readStreak(stateKey, rowId) + 1;
  notesRepository.setSyncState(stateKey, `${rowId}:${streak}`);
  if (streak >= ESCALATE_AFTER_RUNS) {
    Sentry.captureMessage(`${message} (parked ${streak} consecutive syncs)`, 'warning');
    return;
  }
  Sentry.addBreadcrumb({ category: 'sync', message, level: 'info' });
}

/**
 * The crawl got past whatever was parked (or nothing parked at all), so the
 * streak starts over. Writes only when something was actually stored, to keep
 * a clean run free of pointless sync_state churn.
 */
export function clearPark(stateKey: string): void {
  if (notesRepository.getSyncState(stateKey)) {
    notesRepository.setSyncState(stateKey, '');
  }
}
