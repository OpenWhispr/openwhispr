import { create } from "zustand";
import logger from "../utils/logger";
import type { InferenceMode } from "../types/electron";
import type { OrgPolicy, PolicyScope } from "../types/policy";

interface PolicyState {
  /** True once the org enforces a policy on this user. */
  managed: boolean;
  /** The resolved policy, or null when unmanaged. */
  policy: OrgPolicy | null;
  /** True after the first fetch resolves (success or fail-closed cache). */
  loaded: boolean;
  fetchPolicy: () => Promise<void>;
}

export const usePolicyStore = create<PolicyState>()((set) => ({
  managed: false,
  policy: null,
  loaded: false,
  fetchPolicy: async () => {
    try {
      const result = await window.electronAPI.getWorkspacePolicy?.();
      if (result?.success) {
        set({
          managed: Boolean(result.managed),
          policy: result.policy ?? null,
          loaded: true,
        });
        return;
      }
      // Fetch failed with no cache: treat as unmanaged until a later fetch
      // succeeds. The stt-config `managed` bootstrap flag locks provider
      // settings in the meantime for a fresh managed install.
      set({ loaded: true });
    } catch (error) {
      logger.error("Failed to fetch workspace policy:", error);
      set({ loaded: true });
    }
  },
}));

/** Whether a transcription/LLM mode is allowed. Unmanaged users allow everything. */
export function isModeAllowed(
  state: Pick<PolicyState, "managed" | "policy">,
  scope: PolicyScope,
  mode: InferenceMode
): boolean {
  if (!state.managed || !state.policy) return true;
  return state.policy[scope].allowedModes.includes(mode);
}

/** Whether a BYOK provider id is allowed for a scope. Unmanaged users allow everything. */
export function isProviderAllowed(
  state: Pick<PolicyState, "managed" | "policy">,
  scope: PolicyScope,
  providerId: string
): boolean {
  if (!state.managed || !state.policy) return true;
  return state.policy[scope].allowedByokProviders.includes(providerId);
}

/** Whether an enterprise-cloud provider id is allowed. Unmanaged users allow everything. */
export function isEnterpriseProviderAllowed(
  state: Pick<PolicyState, "managed" | "policy">,
  providerId: string
): boolean {
  if (!state.managed || !state.policy) return true;
  return state.policy.llm.allowedEnterpriseProviders.includes(providerId);
}

/** Mark policy-disallowed mode options disabled with a "managed" badge. */
export function enforceModeOptions<
  T extends { id: InferenceMode; disabled?: boolean; badge?: string },
>(
  options: T[],
  scope: PolicyScope,
  state: Pick<PolicyState, "managed" | "policy">,
  managedBadge: string
): T[] {
  if (!state.managed || !state.policy) return options;
  return options.map((option) =>
    isModeAllowed(state, scope, option.id)
      ? option
      : { ...option, disabled: true, badge: managedBadge }
  );
}
