import type { ManagedEnterpriseConfig } from "../types/enterpriseIdentity";

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
  return request(accountId, workspaceId, authGeneration, forceRefresh);
}

export function clearManagedEnterpriseIdentity(): void {
  void window.electronAPI?.clearManagedEnterpriseIdentity?.();
}
