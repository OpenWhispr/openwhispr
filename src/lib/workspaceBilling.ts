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

/**
 * An owned workspace with a live, entitled Stripe subscription on a lower plan
 * can upgrade in place (subscription price swap, no new checkout). Manually
 * provisioned plans have no subscription to update, so they stay sales-led.
 */
export function canUpgradeWorkspaceToEnterprise(workspace: WorkspaceBillingState): boolean {
  return (
    workspace.role === "owner" &&
    Boolean(workspace.stripe_subscription_id) &&
    hasActiveWorkspaceSubscription(workspace) &&
    workspace.plan !== "enterprise"
  );
}

export type EnterpriseTileCta =
  | { action: "openDialog" }
  | { action: "createWorkspace" }
  | { action: "contactSales"; ownerName: string | null };

/**
 * Which CTA the Enterprise pricing tile leads with: owners of a workspace the
 * dialog can actually serve (fresh checkout or in-place upgrade) get the
 * purchase dialog, users with no workspace at all get the create-workspace
 * on-ramp, and members/admins of someone else's workspace are pointed at the
 * owner — upgrading in-app would otherwise create a workspace they didn't
 * want. Owners whose workspaces are all ineligible (e.g. already Enterprise)
 * get plain contact sales: they are the decision makers, so no ask-owner hint.
 */
export function enterpriseTileCta(
  workspaces: Array<
    Pick<
      Workspace,
      "id" | "role" | "billing_manager" | "plan" | "status" | "stripe_subscription_id"
    >
  >,
  activeWorkspaceId: string | null
): EnterpriseTileCta {
  if (
    workspaces.some(
      (workspace) => canSelfServeEnterprise(workspace) || canUpgradeWorkspaceToEnterprise(workspace)
    )
  ) {
    return { action: "openDialog" };
  }
  if (workspaces.length === 0) return { action: "createWorkspace" };
  if (workspaces.some((workspace) => workspace.role === "owner")) {
    return { action: "contactSales", ownerName: null };
  }
  const target =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  return { action: "contactSales", ownerName: target.billing_manager ?? null };
}
