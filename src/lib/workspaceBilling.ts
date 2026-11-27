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

/** The workspaces whose billable seat covers the user: the ids /api/usage lists, as far as the list knows them. */
export function coveringWorkspaces<W extends Pick<Workspace, "id">>(
  entitledWorkspaceIds: string[] | undefined,
  workspaces: W[]
): W[] {
  if (!entitledWorkspaceIds?.length) return [];
  const entitled = new Set(entitledWorkspaceIds);
  return workspaces.filter((workspace) => entitled.has(workspace.id));
}

export type BusinessTileAction =
  | { kind: "none" }
  | { kind: "workspacePlan" }
  | { kind: "viewWorkspace"; workspaceId: string }
  | { kind: "createWorkspace" };

type BusinessTileWorkspace = Pick<Workspace, "id"> & WorkspaceBillingState;

/**
 * What the Business pricing tile does. None of these starts a checkout: the
 * personal view never sells a workspace plan, it only points at the workspace
 * view or the create-workspace on-ramp.
 */
export function businessTileAction(input: {
  listLoaded: boolean;
  listError: boolean;
  entitledWorkspaceIds: string[] | undefined;
  workspaces: BusinessTileWorkspace[];
  defaultWorkspaceId: string | null;
}): BusinessTileAction {
  // An unloaded list reads as empty, which must never send a member to "Create workspace".
  if (!input.listLoaded || input.listError) return { kind: "none" };

  const covering = coveringWorkspaces(input.entitledWorkspaceIds, input.workspaces);
  if (covering.some((workspace) => workspace.plan === "business")) {
    return { kind: "workspacePlan" };
  }
  if (covering.some((workspace) => workspace.plan === "enterprise")) return { kind: "none" };

  const unpaid = input.workspaces.filter(
    (workspace) =>
      workspaceCan(workspace, "manage_billing") &&
      !hasSubscription(workspace) &&
      !hasActiveWorkspaceSubscription(workspace)
  );
  const target = unpaid.find((workspace) => workspace.id === input.defaultWorkspaceId) ?? unpaid[0];
  if (target) return { kind: "viewWorkspace", workspaceId: target.id };
  return { kind: "createWorkspace" };
}

export type EnterpriseTileAction =
  | { kind: "none" }
  | { kind: "workspacePlan" }
  | { kind: "viewWorkspace"; workspaceId: string }
  | { kind: "contactSales"; ownerName: string | null };

type EnterpriseTileWorkspace = Pick<Workspace, "id" | "billing_manager"> & WorkspaceBillingState;

/**
 * What the personal view's Enterprise tile does. Like the Business tile it
 * never starts a checkout: an owner of a workspace the purchase dialog can
 * serve (fresh checkout or in-place upgrade) is sent to that workspace's view,
 * where the dialog lives. Members of someone else's workspace are pointed at
 * its owner; owners with nothing eligible are the decision makers, so no hint.
 */
export function enterpriseTileAction(input: {
  listLoaded: boolean;
  listError: boolean;
  entitledWorkspaceIds: string[] | undefined;
  workspaces: EnterpriseTileWorkspace[];
  defaultWorkspaceId: string | null;
  activeWorkspaceId: string | null;
}): EnterpriseTileAction {
  if (!input.listLoaded || input.listError) return { kind: "none" };

  const eligible = input.workspaces.filter(
    (workspace) => canSelfServeEnterprise(workspace) || canUpgradeWorkspaceToEnterprise(workspace)
  );
  const target =
    eligible.find((workspace) => workspace.id === input.defaultWorkspaceId) ?? eligible[0];
  if (target) return { kind: "viewWorkspace", workspaceId: target.id };

  const covering = coveringWorkspaces(input.entitledWorkspaceIds, input.workspaces);
  if (covering.some((workspace) => workspace.plan === "enterprise")) {
    return { kind: "workspacePlan" };
  }

  if (
    input.workspaces.length === 0 ||
    input.workspaces.some((workspace) => workspaceCan(workspace, "manage_billing"))
  ) {
    return { kind: "contactSales", ownerName: null };
  }
  const asked =
    input.workspaces.find((workspace) => workspace.id === input.activeWorkspaceId) ??
    input.workspaces[0];
  return { kind: "contactSales", ownerName: asked.billing_manager ?? null };
}
