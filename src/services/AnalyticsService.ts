import { CloudApiError, cloudDelete, cloudGet, cloudPost } from "./cloudApi";
import type { AnalyticsSummary, PendingAnalyticsEvent } from "../types/electron";

const BATCH_SIZE = 200;

// Mirrors SyncService.pushNoteDeletes: a tombstone that the cloud can never
// accept (404 — the delete route is not live yet) is retired locally instead of
// being replayed on every sync, so a missing route degrades to a local erase.
async function pushAnalyticsDeletes(): Promise<void> {
  while (true) {
    const pending = await window.electronAPI.getPendingAnalyticsDeletes(BATCH_SIZE);
    if (pending.length === 0) return;

    const eventIds = pending.map((row) => row.event_id);
    try {
      await cloudDelete("/api/analytics/events/delete", { eventIds });
    } catch (error) {
      if (!(error instanceof CloudApiError && error.status === 404)) {
        console.error("Analytics delete sync failed:", error);
        return;
      }
    }
    await window.electronAPI.hardDeleteAnalyticsEvents(eventIds);
    if (pending.length < BATCH_SIZE) return;
  }
}

export async function syncPendingAnalytics(): Promise<number> {
  await pushAnalyticsDeletes();
  let synced = 0;

  while (true) {
    const events: PendingAnalyticsEvent[] =
      await window.electronAPI.getPendingAnalyticsEvents(BATCH_SIZE);
    if (events.length === 0) return synced;

    const result = await cloudPost<{ accepted: string[] }>("/api/analytics/events/batch", {
      events,
    });
    const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
    if (accepted.length === 0) return synced;

    // Every pass must retire rows locally, or the next read returns the same
    // batch and this loop re-posts it forever.
    const { updated } = await window.electronAPI.markAnalyticsEventsSynced(accepted);
    if (updated === 0) return synced;
    synced += updated;
    if (events.length < BATCH_SIZE) return synced;
  }
}

export async function getAccountAnalyticsSummary(timeZone: string): Promise<AnalyticsSummary> {
  const summary = await cloudGet<AnalyticsSummary>(
    `/api/analytics/summary?timeZone=${encodeURIComponent(timeZone)}`
  );
  if (!Array.isArray(summary?.daily)) {
    throw new Error("Malformed analytics summary from cloud");
  }
  return summary;
}
