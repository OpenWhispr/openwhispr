import { useSyncExternalStore } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed, isConnectorsBlockedByOrg } from "../stores/policyRules";
import { getUsageState, subscribeUsage } from "../lib/usageStore";
import { readIsSubscribed, subscribeIsSubscribed } from "../lib/subscriptionFlag";
import { hasConnectorPlan } from "../utils/connectorEligibility";

export interface ConnectorAccess {
  /** The same plan check that decides whether the chat gets the connector tools. */
  isPaid: boolean;
  blockedByOrg: boolean;
  /**
   * False while the policy loads, after a failed fetch, or when the org requires
   * a newer app: chat has no connector tools then, so nothing may offer them.
   */
  connectorsAllowed: boolean;
}

export function useConnectorAccess(): ConnectorAccess {
  const blockedByOrg = usePolicyStore(isConnectorsBlockedByOrg);
  const connectorsAllowed = usePolicyStore(isConnectorsAllowed);
  const isSignedIn = useSettingsStore((state) => state.isSignedIn);
  const usage = useSyncExternalStore(subscribeUsage, getUsageState);
  const isSubscribedFlag = useSyncExternalStore(subscribeIsSubscribed, readIsSubscribed);
  return {
    isPaid: isSignedIn && hasConnectorPlan(usage, isSubscribedFlag),
    blockedByOrg,
    connectorsAllowed,
  };
}
