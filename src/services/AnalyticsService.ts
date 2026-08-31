import { cloudGet, cloudPost } from "./cloudApi";
import type { AnalyticsSummary, PendingAnalyticsEvent } from "../types/electron";

const BATCH_SIZE = 200;

export async function syncPendingAnalytics(): Promise<number> {
  await window.electronAPI.claimAnonymousAnalyticsEvents();
  let synced = 0;

  while (true) {
    const events: PendingAnalyticsEvent[] =
      await window.electronAPI.getPendingAnalyticsEvents(BATCH_SIZE);
    if (events.length === 0) return synced;

    const result = await cloudPost<{ accepted: string[] }>("/api/analytics/events/batch", {
      events,
    });
    const accepted = Array.isArray(result.accepted) ? result.accepted : [];
    if (accepted.length === 0) return synced;

    await window.electronAPI.markAnalyticsEventsSynced(accepted);
    synced += accepted.length;
    if (events.length < BATCH_SIZE) return synced;
  }
}

export async function getAccountAnalyticsSummary(timeZone: string): Promise<AnalyticsSummary> {
  return cloudGet<AnalyticsSummary>(
    `/api/analytics/summary?timeZone=${encodeURIComponent(timeZone)}`
  );
}
