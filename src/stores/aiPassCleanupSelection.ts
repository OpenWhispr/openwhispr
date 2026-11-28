import { getManagedScopeResolution } from "./enterpriseIdentityStore";
import { usePolicyStore } from "./policyStore";
import type { SettingsState } from "./settingsStore";

// Keep the personal wallet opt-in separate from cleanup defaults inherited by other scopes.
export function selectAiPassCleanupModel(
  state: Pick<SettingsState, "aiPassCleanupModel" | "cleanupMode" | "enterpriseSetupMode">
): string {
  const model = state.aiPassCleanupModel?.trim();
  if (
    !model ||
    state.cleanupMode !== "providers" ||
    usePolicyStore.getState().status !== "unmanaged" ||
    getManagedScopeResolution("dictationCleanup", state.enterpriseSetupMode).kind !== "manual"
  ) {
    return "";
  }
  return model;
}
