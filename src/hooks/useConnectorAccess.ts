import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed, isConnectorsBlockedByOrg } from "../stores/policyRules";

export interface ConnectorAccess {
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
  return { blockedByOrg, connectorsAllowed };
}
