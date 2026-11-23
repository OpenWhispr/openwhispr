import { getValidatedAuthGeneration } from "./authRequestContext";

export interface BillingIdentity {
  workspaceId: string | null;
  authGeneration: number;
}

/** Null without a validated sign-in: such a request must not be sent. */
export function currentBillingIdentity(workspaceId: string | null): BillingIdentity | null {
  const authGeneration = getValidatedAuthGeneration();
  return authGeneration == null ? null : { workspaceId, authGeneration };
}

/** False when either side is null. */
export function isSameBillingIdentity(
  a: BillingIdentity | null,
  b: BillingIdentity | null
): boolean {
  if (!a || !b) return false;
  return a.workspaceId === b.workspaceId && a.authGeneration === b.authGeneration;
}
