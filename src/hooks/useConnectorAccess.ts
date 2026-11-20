import { useSyncExternalStore } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicySnapshot } from "./usePolicy";
import { getUsageState, subscribeUsage } from "../lib/usageStore";
import { readIsSubscribed, subscribeIsSubscribed } from "../lib/subscriptionFlag";
import { connectorEligibilityFor, type ConnectorEligibility } from "../utils/connectorEligibility";
import { CLOUD_ENABLED } from "../config/forkRuntime";
import { useTitaniumAuth } from "./useTitaniumAuth";

export interface ConnectorAccess {
  /** The same plan check that decides whether the chat gets the connector tools. */
  isPaid: boolean;
  /** Why connectors are off for this user (sign in, sign in again, license), or null. */
  reason: ConnectorEligibility["reason"];
  blockedByOrg: boolean;
  /**
   * False while the policy loads, after a failed fetch, or when the org requires
   * a newer app: chat has no connector tools then, so nothing may offer them.
   */
  connectorsAllowed: boolean;
}

export function useConnectorAccess(): ConnectorAccess {
  const policy = usePolicySnapshot();
  const titanium = useTitaniumAuth();
  const isSignedIn = useSettingsStore((state) => state.isSignedIn);
  const usage = useSyncExternalStore(subscribeUsage, getUsageState);
  const isSubscribedFlag = useSyncExternalStore(subscribeIsSubscribed, readIsSubscribed);
  const { isPaid, reason, blockedByOrg, connectorsAllowed } = connectorEligibilityFor({
    cloudEnabled: CLOUD_ENABLED,
    titanium,
    upstream: { isSignedIn, usage, isSubscribed: isSubscribedFlag, policy },
  });
  return { isPaid, reason, blockedByOrg, connectorsAllowed };
}
