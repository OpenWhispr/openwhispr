import type { UsageState } from "../lib/usageStore";

/**
 * Connectors are paid-only (subscription or trial). Usage data is only loaded
 * while a surface mounts useUsage(), so other windows read the account-scoped
 * paid-access flag the usage store persists.
 */
export function hasConnectorPlan(usage: UsageState, paidAccessFlag: boolean): boolean {
  if (usage.status === "success") return usage.data.isSubscribed || usage.data.isTrial;
  return paidAccessFlag;
}
