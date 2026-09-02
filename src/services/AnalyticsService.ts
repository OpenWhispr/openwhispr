import { cloudDelete, cloudGet, cloudPost } from "./cloudApi";
import type { AnalyticsSummary, PendingAnalyticsEvent } from "../types/electron";

const BATCH_SIZE = 200;
export const ANALYTICS_SUMMARY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const ANALYTICS_REMOTE_REFRESH_DEBOUNCE_MS = 250;

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

async function pushAnalyticsDeletes(): Promise<void> {
  while (true) {
    const pending = await window.electronAPI.getPendingAnalyticsDeletes(BATCH_SIZE);
    if (pending.length === 0) return;

    const eventIds = pending.map((row) => row.event_id);
    await cloudDelete("/api/analytics/events/delete", { eventIds });
    await window.electronAPI.hardDeleteAnalyticsEvents(eventIds);
    if (pending.length < BATCH_SIZE) return;
  }
}

async function pushAnalyticsClear(): Promise<void> {
  const pending = await window.electronAPI.getPendingAnalyticsClear();
  if (!pending) return;

  await cloudDelete("/api/analytics/events/delete", {
    deleteAll: true,
    clearedThrough: pending.cleared_through,
  });
  await window.electronAPI.completeAnalyticsClear(pending.cleared_through);
}

export async function syncPendingAnalytics({
  uploadAllowed = true,
}: { uploadAllowed?: boolean } = {}): Promise<number> {
  // Deletes take precedence over uploads so a clear/retention action cannot
  // race with an older batch and recreate data the user asked us to erase.
  await pushAnalyticsClear();
  await pushAnalyticsDeletes();
  if (!uploadAllowed) return 0;

  let synced = 0;

  while (true) {
    const events: PendingAnalyticsEvent[] =
      await window.electronAPI.getPendingAnalyticsEvents(BATCH_SIZE);
    if (events.length === 0) return synced;

    // `accepted` is an ack list, not a list of stored rows. The endpoint
    // validates per event and deliberately echoes back the ids it refused as
    // permanently invalid, so marking exactly `accepted` as synced is what
    // retires them. Narrowing this to the ids that were actually stored -- or
    // deriving it from the sibling `rejected` field -- would leave a row that
    // can never validate at the head of the queue forever. A batch the server
    // refuses outright throws and stays pending for the next pass.
    const result = await cloudPost<{ accepted: string[] }>("/api/analytics/events/batch", {
      events,
    });
    const accepted = Array.isArray(result?.accepted) ? result.accepted : [];

    // Every pass must retire rows locally, or the next read returns the same
    // batch and this loop re-posts it forever.
    const { updated } = await window.electronAPI.markAnalyticsEventsSynced(accepted);
    if (updated === 0) return synced;
    synced += updated;
    if (events.length < BATCH_SIZE) return synced;
  }
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
  return (
    totalsAreValid &&
    averageWpmIsValid &&
    coverageIsValid &&
    Array.isArray(value.daily) &&
    value.daily.length <= 366 &&
    value.daily.every(isAnalyticsDailyBucket)
  );
}

export async function getAccountAnalyticsSummary(timeZone: string): Promise<AnalyticsSummary> {
  const summary = await cloudGet<unknown>(
    `/api/analytics/summary?timeZone=${encodeURIComponent(timeZone)}`
  );
  // The cloud is an untrusted JSON boundary. Invalid buckets crash Heatmap
  // during render, outside the caller's async fallback, so validate the whole
  // shape before any part of it reaches component state.
  if (!isAnalyticsSummary(summary)) {
    throw new Error("Malformed analytics summary from cloud");
  }
  return summary;
}
