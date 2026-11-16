import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed, isConnectorsBlockedByOrg } from "../stores/policyRules";

export interface ConnectorAccess {
  /**
   * Connectors are free for any signed-in user. The name is kept for existing
   * callers; it no longer means a paid plan.
   */
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
  return {
    isPaid: isSignedIn,
    blockedByOrg,
    connectorsAllowed,
  };
}
