import type { ManagedEnterpriseConfig, ManagedEnterpriseScope } from "../types/enterpriseIdentity";

export interface ManagedEnterpriseConfigResult {
  success: boolean;
  status?: "network" | "current" | "cached" | "error";
  accountId?: string | null;
  workspaceId?: string | null;
  authGeneration?: number | null;
  config?: ManagedEnterpriseConfig;
  code?: string;
  error?: string;
  enforcementRequired?: boolean;
  enforcedScopes?: ManagedEnterpriseScope[];
}

export async function getManagedEnterpriseConfig(
  accountId: string,
  workspaceId: string,
  authGeneration: number,
  forceRefresh = false
): Promise<ManagedEnterpriseConfigResult> {
  const request = window.electronAPI?.getManagedEnterpriseConfig;
  if (!request) {
    return {
      success: false,
      status: "error",
      code: "MANAGED_ENTERPRISE_UNSUPPORTED",
      error: "Managed enterprise AI requires a newer version of OpenWhispr.",
    };
  }
  // The IPC boundary type carries scope names as bare strings (see
  // src/types/electron.ts); the main process only ever populates them from
  // ManagedEnterpriseScope values (see managedScopesForConfig).
  return request(
    accountId,
    workspaceId,
    authGeneration,
    forceRefresh
  ) as Promise<ManagedEnterpriseConfigResult>;
}

// `next` is the scope the renderer is moving to; main ends enterprise audio
// that belongs to another one.
export type ClearEnterpriseIdentityOptions = {
  next?: { accountId: string; workspaceId: string | null };
};

export function clearManagedEnterpriseIdentity(options?: ClearEnterpriseIdentityOptions): void {
  void window.electronAPI?.clearManagedEnterpriseIdentity?.(options);
}
