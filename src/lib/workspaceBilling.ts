import type { Workspace } from "../types/electron";
import { workspaceCan } from "./capabilities.ts";

const PAID_PLANS = new Set(["pro", "business", "enterprise"]);
const SHARED_DICTIONARY_PLANS = new Set(["business", "enterprise"]);
const ENTITLED_STATUSES = new Set(["active", "trialing"]);

type WorkspaceBillingState = Pick<
  Workspace,
  "plan" | "status" | "role" | "capabilities" | "stripe_subscription_id" | "has_subscription"
>;

/**
 * The API's checkout gate: a Stripe subscription, or a paid plan provisioned
 * without one. Not "a Stripe subscription exists" — use the raw
 * `stripe_subscription_id` for Stripe-only actions. APIs that predate
 * `has_subscription` only send the raw id.
 */
export function hasSubscription(
  workspace: Pick<Workspace, "has_subscription" | "stripe_subscription_id">
): boolean {
  return workspace.has_subscription ?? Boolean(workspace.stripe_subscription_id);
}

/** Mirrors the API's `hasActiveWorkspaceSubscription`: a paid plan that is currently entitled. */
export function hasActiveWorkspaceSubscription(
  workspace: Pick<WorkspaceBillingState, "plan" | "status">
): boolean {
  return PAID_PLANS.has(workspace.plan) && ENTITLED_STATUSES.has(workspace.status);
}

/**
 * The paid plans the user's workspaces are currently on, so the Plans grid can
 * mark the tiers a workspace provides, not only the personal plan.
 */
export function entitledWorkspacePlans(
  workspaces: Array<Pick<Workspace, "plan" | "status">>
): Set<string> {
  return new Set(
    workspaces
      .filter((workspace) => hasActiveWorkspaceSubscription(workspace))
      .map((workspace) => workspace.plan)
  );
}

/** The shared team dictionary is a Business feature: Business or Enterprise, currently entitled. */
export function hasSharedDictionaryPlan(
  workspace: Pick<Workspace, "plan" | "status"> | null | undefined
): boolean {
  return Boolean(
    workspace &&
    SHARED_DICTIONARY_PLANS.has(workspace.plan) &&
    ENTITLED_STATUSES.has(workspace.status)
  );
}

/**
 * Mirrors the API's workspace checkout guard: only an owned workspace with no
 * live Stripe subscription and no active plan can start a self-serve
 * Enterprise checkout. Client checks are cosmetic — the server enforces (409).
 */
export function canSelfServeEnterprise(workspace: WorkspaceBillingState): boolean {
  return (
    workspaceCan(workspace, "manage_billing") &&
    !hasSubscription(workspace) &&
    !hasActiveWorkspaceSubscription(workspace)
  );
}

/** Mirrors the admin console's own gate: entitled Enterprise plan + owner/admin role. */
export function isEnterpriseConsoleAvailable(
  workspace: Pick<WorkspaceBillingState, "plan" | "status" | "role" | "capabilities">
): boolean {
  return (
    workspace.plan === "enterprise" &&
    ENTITLED_STATUSES.has(workspace.status) &&
    workspaceCan(workspace, "manage_settings")
  );
}

/** Where a Plans grid button for a workspace's plan leads. */
export type WorkspacePlanAction =
  { kind: "stripePortal"; workspaceId: string } | { kind: "console" } | { kind: "contactSales" };

type PlanCardWorkspace = Pick<Workspace, "id"> & WorkspaceBillingState;

/** Entitled Enterprise workspaces, the active one first. */
function entitledEnterpriseWorkspaces(
  workspaces: PlanCardWorkspace[],
  activeWorkspaceId: string | null
): PlanCardWorkspace[] {
  return workspaces
    .filter(
      (workspace) => workspace.plan === "enterprise" && hasActiveWorkspaceSubscription(workspace)
    )
    .sort((a, b) => Number(b.id === activeWorkspaceId) - Number(a.id === activeWorkspaceId));
}

/** The Stripe portal changes the plan only for the billing owner of a Stripe-billed plan. */
function billsThroughStripe(workspace: PlanCardWorkspace): boolean {
  return workspaceCan(workspace, "manage_billing") && Boolean(workspace.stripe_subscription_id);
}

/**
 * The Enterprise card's Manage button: Stripe billing for the billing owner of
 * a Stripe-billed plan, the admin console for owners and admins otherwise
 * (a provisioned plan has no Stripe portal), nothing for members.
 */
export function enterpriseManageAction(
  workspaces: PlanCardWorkspace[],
  activeWorkspaceId: string | null
): WorkspacePlanAction | null {
  for (const workspace of entitledEnterpriseWorkspaces(workspaces, activeWorkspaceId)) {
    if (billsThroughStripe(workspace)) return { kind: "stripePortal", workspaceId: workspace.id };
    if (isEnterpriseConsoleAvailable(workspace)) return { kind: "console" };
  }
  return null;
}

/**
 * The Business card's button for someone on Enterprise: Downgrade through the
 * Stripe portal when they bill a Stripe-billed Enterprise plan, contact sales
 * when they bill a provisioned plan, nothing when someone else bills.
 * The active eligible billing workspace takes priority over the billing method.
 */
export function businessDowngradeAction(
  workspaces: PlanCardWorkspace[],
  activeWorkspaceId: string | null
): WorkspacePlanAction | null {
  const workspace = entitledEnterpriseWorkspaces(workspaces, activeWorkspaceId).find((workspace) =>
    workspaceCan(workspace, "manage_billing")
  );
  if (!workspace) return null;
  return billsThroughStripe(workspace)
    ? { kind: "stripePortal", workspaceId: workspace.id }
    : { kind: "contactSales" };
}

/**
 * An owned workspace with a live, entitled Stripe subscription on a lower plan
 * can upgrade in place (subscription price swap, no new checkout). Manually
 * provisioned plans have no subscription to update, so they stay sales-led.
 * Reads the raw id, not `has_subscription`, which also covers manual plans.
 */
export function canUpgradeWorkspaceToEnterprise(workspace: WorkspaceBillingState): boolean {
  return (
    workspaceCan(workspace, "manage_billing") &&
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
      | "id"
      | "role"
      | "capabilities"
      | "billing_manager"
      | "plan"
      | "status"
      | "stripe_subscription_id"
      | "has_subscription"
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
  if (workspaces.some((workspace) => workspaceCan(workspace, "manage_billing"))) {
    return { action: "contactSales", ownerName: null };
  }
  const target =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  return { action: "contactSales", ownerName: target.billing_manager ?? null };
}
