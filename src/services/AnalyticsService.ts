import {
  cloudDelete,
  cloudDeleteForAuthGeneration,
  cloudGet,
  cloudPost,
  cloudPostForAuthGeneration,
  isAuthContextError,
} from "./cloudApi";
import type {
  AnalyticsSummary,
  AnalyticsSyncContext,
  PendingAnalyticsEvent,
} from "../types/electron";
import { ANALYTICS_HISTORICAL_COUNTER_VERSION } from "../helpers/analytics";

const BATCH_SIZE = 200;
// A pass uploads at most this many batches. Insights waits on a pass before
// it can read the account summary, so an unbounded drain would hold the view's
// spinner — and hammer the batch endpoint — for the length of a whole history
// backfill. What is left over stays pending and still counts as moved work,
// which keeps the ambient pass cadence tight until the queue is empty.
const MAX_BATCHES_PER_PASS = 5;
export const ANALYTICS_SUMMARY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const ANALYTICS_REMOTE_REFRESH_DEBOUNCE_MS = 250;
const requestedHistoryBackfillAccounts = new Set<string>();

export function subscribeToAnalyticsRefresh(
  refresh: () => void | Promise<void>,
  cloudInsightsActive: boolean
): () => void {
  let disposed = false;
  let refreshRunning = false;
  let trailingLocalRefreshRequested = false;
  let trailingRemoteRefreshRequested = false;
  const runRefresh = async (remoteOnly = false): Promise<void> => {
    if (disposed || (remoteOnly && window.document.visibilityState !== "visible")) {
      return;
    }
    if (refreshRunning) {
      if (remoteOnly) trailingRemoteRefreshRequested = true;
      else trailingLocalRefreshRequested = true;
      return;
    }

    refreshRunning = true;
    try {
      await refresh();
    } catch (error) {
      console.error("Refreshing analytics failed:", error);
    } finally {
      refreshRunning = false;
      const runLocalRefresh = trailingLocalRefreshRequested;
      const runRemoteRefresh = trailingRemoteRefreshRequested;
      trailingLocalRefreshRequested = false;
      trailingRemoteRefreshRequested = false;
      if (!disposed && runLocalRefresh) {
        void runRefresh();
      } else if (!disposed && runRemoteRefresh && window.document.visibilityState === "visible") {
        void runRefresh(true);
      }
    }
  };
  const requestLocalRefresh = (): void => {
    void runRefresh();
  };
  const requestRemoteRefresh = (): void => {
    void runRefresh(true);
  };

  const disposeLocal = window.electronAPI.onAnalyticsChanged?.(requestLocalRefresh);
  requestLocalRefresh();
  if (!cloudInsightsActive) {
    return () => {
      disposed = true;
      disposeLocal?.();
    };
  }

  let remoteRefreshTimeoutId: number | null = null;
  const refreshRemoteWhenVisible = (): void => {
    if (window.document.visibilityState !== "visible") {
      trailingRemoteRefreshRequested = false;
      if (remoteRefreshTimeoutId !== null) {
        window.clearTimeout(remoteRefreshTimeoutId);
        remoteRefreshTimeoutId = null;
      }
      return;
    }
    if (remoteRefreshTimeoutId !== null) window.clearTimeout(remoteRefreshTimeoutId);
    remoteRefreshTimeoutId = window.setTimeout(() => {
      remoteRefreshTimeoutId = null;
      requestRemoteRefresh();
    }, ANALYTICS_REMOTE_REFRESH_DEBOUNCE_MS);
  };

  window.addEventListener("focus", refreshRemoteWhenVisible);
  window.document.addEventListener("visibilitychange", refreshRemoteWhenVisible);
  const intervalId = window.setInterval(
    refreshRemoteWhenVisible,
    ANALYTICS_SUMMARY_REFRESH_INTERVAL_MS
  );

  return () => {
    disposed = true;
    disposeLocal?.();
    window.removeEventListener("focus", refreshRemoteWhenVisible);
    window.document.removeEventListener("visibilitychange", refreshRemoteWhenVisible);
    window.clearInterval(intervalId);
    if (remoteRefreshTimeoutId !== null) window.clearTimeout(remoteRefreshTimeoutId);
  };
}

async function deleteFromCloud(
  path: string,
  body: unknown,
  context?: AnalyticsSyncContext
): Promise<void> {
  if (context) {
    await cloudDeleteForAuthGeneration(path, body, context.authGeneration);
    return;
  }
  await cloudDelete(path, body);
}

async function postToCloud<T>(
  path: string,
  body: unknown,
  context?: AnalyticsSyncContext
): Promise<T> {
  return context
    ? cloudPostForAuthGeneration<T>(path, body, context.authGeneration)
    : cloudPost<T>(path, body);
}

async function pushAnalyticsDeletes(context?: AnalyticsSyncContext): Promise<void> {
  while (true) {
    const pending = await window.electronAPI.getPendingAnalyticsDeletes(BATCH_SIZE, context);
    if (pending.length === 0) return;

    const eventIds = pending.map((row) => row.event_id);
    await deleteFromCloud("/api/analytics/events/delete", { eventIds }, context);
    await window.electronAPI.hardDeleteAnalyticsEvents(eventIds, context);
    if (pending.length < BATCH_SIZE) return;
  }
}

async function pushAnalyticsClear(context?: AnalyticsSyncContext): Promise<void> {
  const pending = await window.electronAPI.getPendingAnalyticsClear(context);
  if (!pending) return;

  await deleteFromCloud(
    "/api/analytics/events/delete",
    {
      deleteAll: true,
      clearedThrough: pending.cleared_through,
    },
    context
  );
  await window.electronAPI.completeAnalyticsClear(pending.cleared_through, context);
}

// Erasures and uploads are independent work that happens to share a pass. A
// clear the server keeps refusing must not stop queued deletes from draining,
// and neither may block an upload — running them in one try block meant a
// single stuck request wedged the whole feature until it cleared. Auth-context
// errors still escape, because SyncService uses them to abandon the pass.
async function runStage(name: string, stage: () => Promise<void>): Promise<void> {
  try {
    await stage();
  } catch (error) {
    if (isAuthContextError(error)) throw error;
    console.error(`Analytics ${name} failed:`, error);
  }
}

// One pass at a time. InsightsView flushes on its own schedule — focus, the
// analytics-changed broadcast, a five-minute timer — while SyncService runs
// passes inside SYNC_ALL_LOCK, and the two share no lock. Overlapping passes
// read the same pending rows and post them twice. Queueing rather than
// coalescing keeps a caller that may upload from joining one that may not.
let passQueue: Promise<unknown> = Promise.resolve();

type AnalyticsUploadGate = boolean | (() => boolean | Promise<boolean>);
interface AnalyticsSyncOptions {
  uploadAllowed?: AnalyticsUploadGate;
  context?: AnalyticsSyncContext;
}

export function syncPendingAnalytics(options: AnalyticsSyncOptions = {}): Promise<number> {
  const pass = passQueue.then(
    () => runAnalyticsPass(options),
    () => runAnalyticsPass(options)
  );
  passQueue = pass.catch(() => {});
  return pass;
}

async function runAnalyticsPass({
  uploadAllowed = true,
  context,
}: AnalyticsSyncOptions = {}): Promise<number> {
  // Erasures still go first, so a clear cannot race an older batch and
  // recreate data the user asked us to erase.
  await runStage("clear", () => pushAnalyticsClear(context));
  await runStage("deletes", () => pushAnalyticsDeletes(context));
  // Resolve functions only after this pass reaches the head of passQueue.
  // Consent can be revoked while an earlier pass is still running, so queuing
  // an already-resolved `true` would let the delayed pass upload afterward.
  const canUpload = async (): Promise<boolean> =>
    typeof uploadAllowed === "function" ? uploadAllowed() : uploadAllowed;
  if (!(await canUpload())) return 0;

  let synced = 0;
  // Ids this pass has already offered. The server deliberately withholds rows
  // it could not store, which keeps them pending — but they stay at the head
  // of an oldest-first queue, so without this they ride along in every later
  // batch and one stuck row costs an extra POST per batch behind it.
  const offered = new Set<string>();

  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
    // Re-check between batches. Revoking consent while a >200-row drain is in
    // flight cannot cancel the active request, but it must stop the next one.
    if (!(await canUpload())) return synced;
    const events: PendingAnalyticsEvent[] = await window.electronAPI.getPendingAnalyticsEvents(
      BATCH_SIZE,
      context
    );
    const fresh = events.filter((event) => !offered.has(event.event_id));
    if (fresh.length === 0) return synced;
    for (const event of fresh) offered.add(event.event_id);

    // `accepted` is an ack list, not a list of stored rows. Only a capable API
    // can distinguish a permanently invalid version-zero row from an older
    // deployment rejecting that version altogether. Keep those ids pending
    // when the capability is absent so an API rollback cannot destroy history.
    if (!(await canUpload())) return synced;
    const result = await postToCloud<{
      accepted?: string[];
      rejected?: string[];
      supportsHistoricalCounterVersion?: boolean;
    }>("/api/analytics/events/batch", { events: fresh }, context);
    const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
    const rejected = new Set(Array.isArray(result?.rejected) ? result.rejected : []);
    const historicalEventIds = new Set(
      fresh
        .filter((event) => event.counter_version === ANALYTICS_HISTORICAL_COUNTER_VERSION)
        .map((event) => event.event_id)
    );
    const acknowledged =
      result?.supportsHistoricalCounterVersion === true
        ? accepted
        : accepted.filter((eventId) => !rejected.has(eventId) || !historicalEventIds.has(eventId));

    const { updated } = await window.electronAPI.markAnalyticsEventsSynced(acknowledged, context);
    synced += updated;
    // The whole queue fit in one read, so there is nothing behind this batch.
    if (events.length < BATCH_SIZE) return synced;
  }
  return synced;
}

const REQUIRED_NONNEGATIVE_SUMMARY_FIELDS = [
  "totalWords",
  "totalDictations",
  "totalSpokenDurationMs",
  "currentStreakDays",
  "longestStreakDays",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isAnalyticsDailyBucket(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCalendarDate(value.date) &&
    isNonnegativeFiniteNumber(value.words) &&
    isNonnegativeFiniteNumber(value.dictations) &&
    isNonnegativeFiniteNumber(value.spokenDurationMs)
  );
}

function isAnalyticsSummary(value: unknown): value is AnalyticsSummary {
  if (!isRecord(value)) return false;
  const totalsAreValid = REQUIRED_NONNEGATIVE_SUMMARY_FIELDS.every((field) =>
    isNonnegativeFiniteNumber(value[field])
  );
  const averageWpmIsValid =
    value.averageWpm === null || isNonnegativeFiniteNumber(value.averageWpm);
  const coverageIsValid =
    isNonnegativeFiniteNumber(value.wpmCoveragePercent) && value.wpmCoveragePercent <= 100;
  const retryHintIsValid =
    value.historyBackfillRetryRequired === undefined ||
    typeof value.historyBackfillRetryRequired === "boolean";
  return (
    totalsAreValid &&
    averageWpmIsValid &&
    coverageIsValid &&
    retryHintIsValid &&
    Array.isArray(value.daily) &&
    value.daily.length <= 366 &&
    value.daily.every(isAnalyticsDailyBucket)
  );
}

export async function getAccountAnalyticsSummary(
  accountId: string | null = null
): Promise<AnalyticsSummary> {
  const requestHistoryBackfill = Boolean(
    accountId && !requestedHistoryBackfillAccounts.has(accountId)
  );
  if (requestHistoryBackfill && accountId) requestedHistoryBackfillAccounts.add(accountId);
  const params = new URLSearchParams({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });
  if (requestHistoryBackfill) params.set("backfill", "true");

  let summary: unknown;
  try {
    summary = await cloudGet<unknown>(`/api/analytics/summary?${params}`);
  } catch (error) {
    // A transient first request must not permanently suppress reconciliation.
    // The Set is claimed before I/O so overlapping refreshes still collapse to
    // one trigger for this account and renderer process.
    if (requestHistoryBackfill && accountId) requestedHistoryBackfillAccounts.delete(accountId);
    throw error;
  }
  // The cloud is an untrusted JSON boundary. Invalid buckets crash Heatmap
  // during render, outside the caller's async fallback, so validate the whole
  // shape before any part of it reaches component state. A successful request
  // already triggered history reconciliation; malformed presentation data
  // must not start another continuation chain on the next refresh.
  if (!isAnalyticsSummary(summary)) {
    throw new Error("Malformed analytics summary from cloud");
  }
  if (requestHistoryBackfill && accountId && summary.historyBackfillRetryRequired === true) {
    requestedHistoryBackfillAccounts.delete(accountId);
  }
  return summary;
}
