import type { UsageState } from "../lib/usageStore";
import { readHasPaidAccess } from "../lib/paidAccessFlag";
import { readIsSubscribed } from "../lib/subscriptionFlag";

/**
 * Connectors are paid-only (subscription or trial). Usage data is only loaded
 * while a surface mounts useUsage(), so other windows read the account-scoped
 * paid-access flag the usage store persists.
 */
export function hasConnectorPlan(usage: UsageState, paidAccessFlag: boolean): boolean {
  if (usage.status === "success") return usage.data.isSubscribed || usage.data.isTrial;
  return paidAccessFlag;
}

/**
 * Paid-access flag for a window that hasn't loaded usage yet. `hasPaidAccess`
 * is only written by the usage store's load, but `isSubscribed` is already
 * persisted for existing subscribers, so either flag being set grants access.
 * Both are cleared together on account change.
 */
export function readConnectorPaidAccessFlag(): boolean {
  return readHasPaidAccess() || readIsSubscribed();
}
