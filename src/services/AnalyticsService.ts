import { cloudGet, cloudPost } from "./cloudApi";
import type { AnalyticsSummary, PendingAnalyticsEvent } from "../types/electron";

const BATCH_SIZE = 200;

export async function syncPendingAnalytics(): Promise<number> {
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

const REQUIRED_SUMMARY_TOTALS = [
  "totalWords",
  "totalDictations",
  "totalSpokenDurationMs",
  "currentStreakDays",
  "longestStreakDays",
  "wpmCoveragePercent",
] as const;

export async function getAccountAnalyticsSummary(timeZone: string): Promise<AnalyticsSummary> {
  const summary = await cloudGet<AnalyticsSummary>(
    `/api/analytics/summary?timeZone=${encodeURIComponent(timeZone)}`
  );
  // Every total is rendered straight into a metric card, where a missing field
  // would read as "NaN"; fall back to the device summary instead.
  const totalsAreNumbers = REQUIRED_SUMMARY_TOTALS.every((field) =>
    Number.isFinite(summary?.[field])
  );
  const wpmIsValid = summary?.averageWpm === null || Number.isFinite(summary?.averageWpm);
  if (!Array.isArray(summary?.daily) || !totalsAreNumbers || !wpmIsValid) {
    throw new Error("Malformed analytics summary from cloud");
  }
  return summary;
}
