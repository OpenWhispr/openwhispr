import { cloudGet, cloudPost } from "./cloudApi";
import type { AnalyticsSummary, PendingAnalyticsEvent } from "../types/electron";

const BATCH_SIZE = 200;

export async function syncPendingAnalytics(): Promise<number> {
  let synced = 0;

  // A session that never opens the control panel (start minimized, launch at
  // login) never binds the local account scope, so its rows are written with
  // no account and would stay unpushable forever. Both callers run only with
  // the Insights opt-in active, and that opt-in is only ever set by confirming
  // the claim dialog, so adopting them needs no further consent. The claim
  // targets the signed-in account and only rows that carry no account, so it
  // can never move another account's counters.
  await window.electronAPI.claimAnonymousAnalyticsEvents().catch((error) => {
    console.error("Adopting unattributed Insights events failed:", error);
  });

  while (true) {
    const events: PendingAnalyticsEvent[] =
      await window.electronAPI.getPendingAnalyticsEvents(BATCH_SIZE);
    if (events.length === 0) return synced;

    // The batch endpoint is all-or-nothing: it validates every event before
    // recording any, so a 200 means each id it echoes back was stored. A
    // rejected batch throws and stays pending for the next pass.
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
