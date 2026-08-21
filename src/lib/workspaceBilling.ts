import type { Workspace } from "../types/electron";
import { canManageWorkspace } from "./spacePermissions.ts";

const PAID_PLANS = new Set(["pro", "business", "enterprise"]);
const ENTITLED_STATUSES = new Set(["active", "trialing"]);

type WorkspaceBillingState = Pick<Workspace, "plan" | "status" | "role" | "stripe_subscription_id">;

/** Mirrors the API's `hasActiveWorkspaceSubscription`: a paid plan that is currently entitled. */
export function hasActiveWorkspaceSubscription(
  workspace: Pick<WorkspaceBillingState, "plan" | "status">
): boolean {
  return PAID_PLANS.has(workspace.plan) && ENTITLED_STATUSES.has(workspace.status);
}

/**
 * Mirrors the API's workspace checkout guard: only an owned workspace with no
 * live Stripe subscription and no active plan can start a self-serve
 * Enterprise checkout. Client checks are cosmetic — the server enforces (409).
 */
export function canSelfServeEnterprise(workspace: WorkspaceBillingState): boolean {
  return (
    workspace.role === "owner" &&
    !workspace.stripe_subscription_id &&
    !hasActiveWorkspaceSubscription(workspace)
  );
}

/** Mirrors the admin console's own gate: entitled Enterprise plan + owner/admin role. */
export function isEnterpriseConsoleAvailable(
  workspace: Pick<WorkspaceBillingState, "plan" | "status" | "role">
): boolean {
  return (
    workspace.plan === "enterprise" &&
    ENTITLED_STATUSES.has(workspace.status) &&
    canManageWorkspace(workspace.role)
  );
}
