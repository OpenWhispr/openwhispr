import type { BillingTone } from "../components/settings/billing/billingTones";
import type { Workspace } from "../types/electron";
import { workspaceCan } from "./capabilities";
import {
  canSelfServeEnterprise,
  canUpgradeWorkspaceToEnterprise,
  hasActiveWorkspaceSubscription,
  hasSubscription,
  isEnterpriseConsoleAvailable,
} from "./workspaceBilling";
import type { PeopleCount } from "./workspacePeople";

const KEY_PREFIX = "settingsPage.billing.workspace.";
const DAY_MS = 86_400_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Plan names are brand names: shown as they are in every language. */
export const WORKSPACE_PLAN_NAMES: Record<WorkspaceTier, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

export type WorkspaceRoleView = "owner" | "admin" | "member";
export type WorkspaceTier = "free" | "business" | "enterprise" | "pro";

export type WorkspaceAction =
  | { kind: "manageBilling" }
  | { kind: "updatePayment" }
  | { kind: "finishCheckout" }
  | { kind: "keepPlan" }
  | { kind: "resubscribe" }
  | { kind: "openConsole" }
  | { kind: "upgradeEnterprise" }
  | { kind: "addSeats" }
  | { kind: "viewPersonal" }
  | { kind: "copyEmail"; email: string };

type Params = Record<string, string>;

export interface WorkspaceBanner {
  tone: BillingTone;
  titleKey: string;
  bodyKey: string;
  params?: Params;
  action?: WorkspaceAction;
}

export type WorkspaceUsageRow =
  | { kind: "unlimited" }
  | {
      kind: "seats";
      used: number;
      total: number;
      captionKey: string | null;
      params?: Params;
      addSeats: boolean;
    }
  | { kind: "members"; count: number | null };

export type WorkspaceDetailValue =
  | { kind: "text"; text: string }
  /** A full i18n key, not relative: the role label reuses `settingsPage.workspace.role.*`. */
  | { kind: "key"; key: string }
  | { kind: "date"; iso: string }
  | { kind: "manager"; name: string; email: string | null };

export interface WorkspaceDetailRow {
  labelKey: string;
  value: WorkspaceDetailValue;
}

/**
 * Keys are relative to `settingsPage.billing.workspace.`, except a detail value
 * of kind `key`, which is a full key. Dates are ISO strings.
 */
export interface WorkspacePlanState {
  role: WorkspaceRoleView;
  tier: WorkspaceTier;
  badge: { key: string; params?: Params; tone: BillingTone } | null;
  /** Members and admins with a paid seat on an entitled plan. */
  managedBadge: boolean;
  planLine: { key: string; params?: Params } | null;
  /** The right side of Current Plan, as secondary buttons. */
  planActions: WorkspaceAction[];
  /** Render the free-workspace buttons instead of `planActions`. */
  freeCta: boolean;
  banner: WorkspaceBanner | null;
  usage: WorkspaceUsageRow[];
  details: {
    titleKey: "billingDetails" | "workspaceDetails";
    rows: WorkspaceDetailRow[];
  } | null;
  /** A free workspace's owner. */
  showPlansGrid: boolean;
}

interface Facts {
  workspace: Workspace;
  /** The billing status, with Stripe's rarer statuses folded into the ones the copy covers. */
  status: string;
  role: WorkspaceRoleView;
  tier: WorkspaceTier;
  entitled: boolean;
  stripe: boolean;
  provisioned: boolean;
  paidSeat: boolean;
  paused: boolean;
  members: number | null;
  invitations: number | null;
  peopleLoading: boolean;
  /** When an ended plan ended: only a period end already passed, never a future one. */
  endedAt: string | null;
}

// A paused subscription (a trial that ended with no payment method) is fixed the way an unpaid
// one is; an expired first checkout has ended like a cancelled plan.
const STATUS_ALIASES: Record<string, string> = {
  paused: "unpaid",
  incomplete_expired: "canceled",
};

function resolveStatus(status: string): string {
  return STATUS_ALIASES[status] ?? status;
}

function resolveRole(workspace: Workspace): WorkspaceRoleView {
  if (workspaceCan(workspace, "manage_billing")) return "owner";
  if (workspaceCan(workspace, "manage_members")) return "admin";
  return "member";
}

function resolveTier(plan: string): WorkspaceTier {
  return plan === "business" || plan === "enterprise" || plan === "pro" ? plan : "free";
}

function trialBadge(trialEndsAt: string | null, now: number): WorkspacePlanState["badge"] {
  const endsAt = trialEndsAt ? Date.parse(trialEndsAt) : Number.NaN;
  if (Number.isNaN(endsAt)) return { key: "badges.trialUndated", tone: "info" };
  const days = Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
  return { key: "badges.trial", params: { days: String(days) }, tone: "info" };
}

function resolveBadge(facts: Facts, now: number): WorkspacePlanState["badge"] {
  const { workspace, status, role, paused } = facts;
  // A member's plan is someone else's to pay for: they only learn it is paused.
  if (role !== "owner") return paused ? { key: "badges.paused", tone: "warning" } : null;
  switch (status) {
    case "trialing":
      return trialBadge(workspace.trial_ends_at, now);
    case "past_due":
      return { key: "badges.pastDue", tone: "destructive" };
    case "unpaid":
      return { key: "badges.unpaid", tone: "destructive" };
    case "incomplete":
      return { key: "badges.incomplete", tone: "warning" };
    case "canceled":
      return { key: "badges.cancelled", tone: "destructive" };
    default:
      return null;
  }
}

function resolvePlanLine(facts: Facts): WorkspacePlanState["planLine"] {
  const { workspace, role, tier, provisioned, paidSeat } = facts;
  if (role === "owner") {
    if (tier === "free") return { key: "planLine.free" };
    return provisioned ? { key: "planLine.invoicedByOpenWhispr" } : null;
  }
  if (paidSeat) return { key: "planLine.paidBy", params: { workspace: workspace.name } };
  return { key: "planLine.personalApplies" };
}

function resolvePlanActions(facts: Facts): WorkspaceAction[] {
  const { workspace, role, stripe, paidSeat } = facts;
  const actions: WorkspaceAction[] = [];
  if (role === "owner" && stripe) actions.push({ kind: "manageBilling" });
  if (isEnterpriseConsoleAvailable(workspace)) actions.push({ kind: "openConsole" });
  // A lapsed paid plan with no subscription left can buy Enterprise fresh; free owners use the grid.
  if (
    canUpgradeWorkspaceToEnterprise(workspace) ||
    (facts.tier !== "free" && canSelfServeEnterprise(workspace))
  ) {
    actions.push({ kind: "upgradeEnterprise" });
  }
  if (role !== "owner" && !paidSeat) actions.push({ kind: "viewPersonal" });
  return actions;
}

function banner(
  id: string,
  tone: BillingTone,
  params: Params,
  action: WorkspaceAction | null
): WorkspaceBanner {
  const result: WorkspaceBanner = {
    tone,
    titleKey: `banners.${id}.title`,
    bodyKey: `banners.${id}.body`,
    params,
  };
  if (action) result.action = action;
  return result;
}

/** The copy names the date only when the API sends it. */
function datedBanner(
  id: string,
  date: string | null,
  plan: Params,
  action: WorkspaceAction | null
): WorkspaceBanner {
  return date
    ? banner(id, "warning", { ...plan, date }, action)
    : banner(`${id}Undated`, "warning", plan, action);
}

function ownerBanner(facts: Facts): WorkspaceBanner | null {
  const { workspace, status, tier, entitled, stripe } = facts;
  const plan = { plan: WORKSPACE_PLAN_NAMES[tier] };
  // Every payment fix goes through the Stripe portal; a provisioned plan has none.
  const portal = (kind: "keepPlan" | "updatePayment" | "finishCheckout"): WorkspaceAction | null =>
    stripe ? { kind } : null;

  if (workspace.cancel_at_period_end && entitled) {
    return datedBanner("ends", workspace.current_period_end, plan, portal("keepPlan"));
  }
  switch (status) {
    case "past_due":
      return banner("paymentFailed", "destructive", plan, portal("updatePayment"));
    case "unpaid":
      return banner("paused", "destructive", plan, portal("updatePayment"));
    case "incomplete":
      return banner("checkoutIncomplete", "warning", plan, portal("finishCheckout"));
    case "canceled":
      // Resubscribe restarts the Business checkout. Enterprise has none here: it is bought again
      // through the plan row's Upgrade to Enterprise checkout.
      return datedBanner(
        "ended",
        facts.endedAt,
        plan,
        tier === "business" ? { kind: "resubscribe" } : null
      );
    default:
      return null;
  }
}

function memberBanner(facts: Facts): WorkspaceBanner | null {
  const params = { workspace: facts.workspace.name };
  if (facts.status === "past_due") {
    return banner("memberPaymentProblem", "destructive", params, null);
  }
  if (facts.paused) return banner("memberPaused", "warning", params, null);
  return null;
}

function seatsRow(facts: Facts): WorkspaceUsageRow {
  const { workspace, role, stripe, entitled, invitations } = facts;
  // An older or cached list has no seats_used: the purchased count stands in for the meter only.
  const counted = typeof workspace.seats_used === "number";
  const used = workspace.seats_used ?? workspace.seats;
  const total = Math.max(workspace.seats, used);
  const pending = invitations !== null && invitations > 0 ? invitations : null;
  const row: WorkspaceUsageRow = {
    kind: "seats",
    used,
    total,
    captionKey: null,
    addSeats: role === "owner" && stripe && entitled,
  };
  // A workspace with no seats has none to run out of.
  if (counted && total > 0 && used >= total) {
    row.captionKey = pending === null ? "usage.noSeatsLeft" : "usage.noSeatsLeftWithInvites";
  } else if (pending !== null) {
    row.captionKey = "usage.pendingInvites";
  }
  if (pending !== null) row.params = { count: String(pending) };
  return row;
}

function membersRows(facts: Facts): WorkspaceUsageRow[] {
  const { members, peopleLoading } = facts;
  // A count that failed or was never read has nothing to show.
  if (members === null && !peopleLoading) return [];
  return [{ kind: "members", count: members }];
}

function resolveUsage(facts: Facts): WorkspaceUsageRow[] {
  const { role, tier, paidSeat } = facts;
  if (role === "member") return paidSeat ? [{ kind: "unlimited" }] : [];
  return tier === "free" ? membersRows(facts) : [seatsRow(facts)];
}

function dateRow(labelKey: string, iso: string | null): WorkspaceDetailRow[] {
  return iso ? [{ labelKey, value: { kind: "date", iso } }] : [];
}

function billingRows(facts: Facts): WorkspaceDetailRow[] {
  const { workspace, status, entitled, provisioned } = facts;
  if (status === "canceled") return dateRow("details.ended", facts.endedAt);
  // Checked before the trial: a trial set to cancel has no first invoice.
  if (workspace.cancel_at_period_end && entitled) {
    return dateRow("details.ends", workspace.current_period_end);
  }
  if (status === "trialing") return dateRow("details.firstInvoice", workspace.trial_ends_at);
  if (provisioned) {
    return [
      {
        labelKey: "details.billing",
        value: { kind: "key", key: `${KEY_PREFIX}details.invoicedByOpenWhispr` },
      },
    ];
  }
  return dateRow("details.periodEnds", workspace.current_period_end);
}

function managerEmail(workspace: Workspace, manager: string): string | null {
  if (workspace.billing_manager_email) return workspace.billing_manager_email;
  return EMAIL_PATTERN.test(manager) ? manager : null;
}

function workspaceRows(facts: Facts): WorkspaceDetailRow[] {
  const { workspace, tier, entitled, paidSeat } = facts;
  const rows: WorkspaceDetailRow[] = [
    { labelKey: "details.workspace", value: { kind: "text", text: workspace.name } },
    {
      labelKey: "details.yourRole",
      value: { kind: "key", key: `settingsPage.workspace.role.${workspace.role}` },
    },
  ];
  // A lapsed plan has no seats to hold: the plan ended, not the seat.
  if (tier !== "free" && entitled) {
    rows.push({
      labelKey: "details.yourSeat",
      value: { kind: "key", key: `${KEY_PREFIX}details.${paidSeat ? "paidSeat" : "noPaidSeat"}` },
    });
  }
  const manager = workspace.billing_manager;
  if (manager) {
    rows.push({
      labelKey: "details.managedBy",
      value: { kind: "manager", name: manager, email: managerEmail(workspace, manager) },
    });
  }
  return rows;
}

function resolveDetails(facts: Facts): WorkspacePlanState["details"] {
  if (facts.role !== "owner") return { titleKey: "workspaceDetails", rows: workspaceRows(facts) };
  const rows = billingRows(facts);
  return rows.length > 0 ? { titleKey: "billingDetails", rows } : null;
}

/** The workspace's own counts stand in while the people list hasn't been read. */
function peopleNumbers(
  workspace: Workspace,
  people: PeopleCount | null
): { members: number | null; invitations: number | null } {
  if (people?.status === "known") {
    return { members: people.members, invitations: people.invitations };
  }
  return {
    members: workspace.member_count ?? null,
    invitations: workspace.invitation_count ?? null,
  };
}

function pastDate(iso: string | null, now: number): string | null {
  return iso !== null && Date.parse(iso) <= now ? iso : null;
}

/** Whether the view has a Members row, so the card knows to read the people count. */
export function showsMembersCount(workspace: Workspace): boolean {
  return resolveRole(workspace) !== "member" && resolveTier(workspace.plan) === "free";
}

/** What one workspace's billing view shows, by the viewer's role and the plan's billing status. */
export function workspacePlanState(
  workspace: Workspace,
  people: PeopleCount | null,
  now: number
): WorkspacePlanState {
  const role = resolveRole(workspace);
  const tier = resolveTier(workspace.plan);
  const status = resolveStatus(workspace.status);
  const entitled = hasActiveWorkspaceSubscription(workspace);
  const stripe = Boolean(workspace.stripe_subscription_id);
  const paidSeat = workspace.is_billable !== false && entitled;
  const facts: Facts = {
    workspace,
    status,
    role,
    tier,
    entitled,
    stripe,
    provisioned: !stripe && hasSubscription(workspace),
    paidSeat,
    paused: tier !== "free" && (status === "unpaid" || status === "canceled"),
    ...peopleNumbers(workspace, people),
    peopleLoading: people?.status === "loading",
    endedAt: pastDate(workspace.current_period_end, now),
  };
  const ownsFreeWorkspace = role === "owner" && tier === "free";

  return {
    role,
    tier,
    badge: resolveBadge(facts, now),
    managedBadge: role !== "owner" && paidSeat,
    planLine: resolvePlanLine(facts),
    planActions: resolvePlanActions(facts),
    freeCta: ownsFreeWorkspace,
    banner: role === "owner" ? ownerBanner(facts) : memberBanner(facts),
    usage: resolveUsage(facts),
    details: resolveDetails(facts),
    showPlansGrid: ownsFreeWorkspace,
  };
}
