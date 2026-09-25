import type { UsageState } from "../lib/usageStore";

/**
 * Connectors are paid-only (subscription or trial, like useUsage's
 * hasPaidAccess). Usage data is only loaded while a surface mounts useUsage(),
 * so other windows (the voice assistant) pass the persisted isSubscribed flag,
 * which the API also sets for trials.
 */
export function hasConnectorPlan(usage: UsageState, isSubscribedFlag: boolean): boolean {
  if (usage.status === "success") return usage.data.isSubscribed || usage.data.isTrial;
  return isSubscribedFlag;
}
