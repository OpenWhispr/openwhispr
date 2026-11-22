import type { BillingInvoiceValue } from "../components/settings/billing/billingFormat";
import type { BillingTone } from "../components/settings/billing/billingTones";
import type { UseUsageResult } from "../hooks/useUsage";
import type { BillingSummary } from "../services/BillingSummaryService";
import type { ProviderStore } from "./usageStore";
import type { BusinessTileAction } from "./workspaceBilling";

const DAY_MS = 86_400_000;

export type PersonalAction =
  | { kind: "subscribePro" }
  | { kind: "manageBilling" }
  | { kind: "updatePayment" }
  | { kind: "manageInStore"; store: ProviderStore }
  | { kind: "signIn" }
  | { kind: "retry" }
  | { kind: "cancelPro" }
  | { kind: "cancelTrial" }
  | { kind: "cancelBusiness" }
  | { kind: "keepPlan"; plan: "Pro" | "Business" }
  | { kind: "business"; action: BusinessTileAction };

export interface PersonalBanner {
  id: string;
  tone: BillingTone;
  titleKey: string;
  bodyKey?: string;
  params?: Record<string, string>;
  action?: PersonalAction;
}

export type PersonalUsage = Pick<
  UseUsageResult,
  | "status"
  | "subscriptionStatus"
  | "plan"
  | "isTrial"
  | "trialDaysLeft"
  | "isPastDue"
  | "isSubscribed"
  | "isPersonallySubscribed"
  | "storeBilling"
  | "currentPeriodEnd"
  | "billingInterval"
  | "wordsUsed"
  | "limit"
  | "wordsRemaining"
  | "isOverLimit"
  | "isApproachingLimit"
  | "entitledWorkspaceIds"
>;

export interface PersonalPlanInput {
  signedIn: boolean;
  usage: PersonalUsage | null;
  /** From `coveringWorkspaces()`; empty while the workspace list loads. */
  coveringWorkspaceNames: string[];
  businessAction: BusinessTileAction;
  hasWorkspacePlanAction: boolean;
  summary?: BillingSummary;
  now: number;
}

export type PersonalTier = "free" | "pro" | "business";

/** Plan names are brand names: shown as they are in every language. */
const PERSONAL_PLAN_NAMES = {
  pro: "Pro",
  business: "Business",
} as const;

export type PersonalUsageRow =
  | {
      kind: "words";
      used: number;
      limit: number;
      remaining: number;
      tone: "normal" | "warning" | "destructive";
    }
  | { kind: "unlimited" };

export interface PersonalDetail {
  labelKey: string;
  value:
    | { kind: "date"; iso: string }
    | ({ kind: "invoice" } & BillingInvoiceValue)
    | { kind: "text"; text: string }
    | { kind: "storeName"; store: ProviderStore | null };
}

export interface PersonalPrice {
  key: string;
  params?: Record<string, string>;
}

export interface PersonalBadge {
  key: string;
  params?: Record<string, string>;
  tone: BillingTone;
}

/** Keys are relative to `settingsPage.billing.personal.`; dates are ISO strings. */
export type PersonalPlanState =
  | { kind: "signedOut" }
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      tier: PersonalTier | null;
      showPlansGrid: boolean;
      badge: PersonalBadge | null;
      /** `null` when this build can't know what the plan costs. */
      price: PersonalPrice | null;
      /** The first is the primary button only when it is `subscribePro`. */
      actions: PersonalAction[];
      banners: PersonalBanner[];
      usage: PersonalUsageRow[];
      details: PersonalDetail[];
    };

interface Facts {
  usage: PersonalUsage;
  tier: PersonalTier | null;
  covered: boolean;
  /** A Stripe subscription, paid or past due: the portal can manage and cancel it. */
  stripeBilled: boolean;
  cardlessTrial: boolean;
  stripeTrial: boolean;
  ending: boolean;
  summary?: BillingSummary;
  storePastDue: boolean;
  storeCanceled: boolean;
}

/**
 * The referral trial: personally entitled with no Stripe subscription behind it, so there is
 * nothing in the portal. Stripe trials never report `isTrial` (the webhook clears their end).
 */
export function isCardlessTrial(usage: Pick<PersonalUsage, "isTrial" | "storeBilling">): boolean {
  return usage.isTrial && !usage.storeBilling;
}

/** The creator link only matters before a purchase: hidden once Stripe bills the user personally. */
export function showsCreatorLink(
  usage: Pick<PersonalUsage, "isPersonallySubscribed" | "isTrial" | "storeBilling"> | null
): boolean {
  return !usage?.isPersonallySubscribed || isCardlessTrial(usage);
}

function resolveTier(usage: PersonalUsage): PersonalTier | null {
  // Migrated workspace dunning retains the old tier but clears the personal period.
  // A personal row with an unknown period is indistinguishable from that response.
  if (usage.isPastDue && !usage.currentPeriodEnd) return null;
  if (usage.isPastDue || usage.isPersonallySubscribed || usage.storeBilling) {
    return usage.plan === "business" ? "business" : "pro";
  }
  return usage.isTrial ? "pro" : "free";
}

function resolveBadge(
  { usage, tier, stripeTrial, storePastDue, storeCanceled }: Facts,
  now: number
): PersonalBadge | null {
  if (usage.isTrial) {
    return {
      key: "badges.trial",
      params: { days: String(usage.trialDaysLeft ?? 0) },
      tone: "info",
    };
  }
  if (stripeTrial) {
    const end = Date.parse(usage.currentPeriodEnd ?? "");
    if (!Number.isFinite(end)) return { key: "badges.stripeTrial", tone: "info" };
    const days = Math.max(0, Math.ceil((end - now) / DAY_MS));
    return { key: "badges.trial", params: { days: String(days) }, tone: "info" };
  }
  if (usage.isPastDue || storePastDue) return { key: "badges.pastDue", tone: "destructive" };
  if (storeCanceled) return { key: "badges.cancelled", tone: "destructive" };
  // A covered member's interval can describe the workspace's subscription, not theirs.
  if (tier === "free") return null;
  if (usage.billingInterval === "annual") return { key: "badges.yearly", tone: "info" };
  if (usage.billingInterval === "monthly") return { key: "badges.monthly", tone: "info" };
  return null;
}

function resolvePrice({
  usage,
  tier,
  stripeBilled,
  stripeTrial,
  ending,
  summary,
}: Facts): PersonalPrice | null {
  if (tier === "free") return { key: "price.free" };
  // Usage supplies cadence. Only an invoice establishes what the subscriber owes.
  if (!stripeBilled || tier !== "pro") return null;
  if (stripeTrial) {
    if (ending) return null;
    const date = summary?.next_invoice?.date;
    // Usage infers cadence from the current trial period. A short trial cannot establish monthly billing.
    if (date) {
      return {
        key: usage.billingInterval === "annual" ? "price.trialYearlyStarts" : "price.trialStarts",
        params: { date },
      };
    }
    return usage.billingInterval === "annual" ? { key: "price.billedYearly" } : null;
  }
  return usage.billingInterval === "annual" ? { key: "price.billedYearly" } : null;
}

function businessActions(action: BusinessTileAction): PersonalAction[] {
  if (action.kind === "none" || action.kind === "workspacePlan") return [];
  return [{ kind: "business", action }];
}

function resolveActions(facts: Facts, businessAction: BusinessTileAction): PersonalAction[] {
  const { usage, tier, covered, stripeBilled, cardlessTrial } = facts;
  if (usage.isPastDue) return [{ kind: "manageBilling" }];
  if (tier === "free" || cardlessTrial) {
    // A canceled customer can still pay their personal invoices through the portal.
    const balanceActions: PersonalAction[] =
      (facts.summary?.outstanding_invoice?.amount_remaining ?? 0) > 0
        ? [{ kind: "manageBilling" }]
        : [];
    return covered
      ? balanceActions
      : [{ kind: "subscribePro" }, ...balanceActions, ...businessActions(businessAction)];
  }
  if (stripeBilled) return [{ kind: "manageBilling" }, ...businessActions(businessAction)];
  const storeName = usage.storeBilling?.store;
  if (storeName) return [{ kind: "manageInStore", store: storeName }];
  return [];
}

function banner(
  id: string,
  tone: BillingTone,
  options: { keyId?: string; params?: Record<string, string>; action?: PersonalAction } = {}
): PersonalBanner {
  const keyId = options.keyId ?? id;
  const result: PersonalBanner = {
    id,
    tone,
    titleKey: `banners.${keyId}.title`,
    bodyKey: `banners.${keyId}.body`,
  };
  if (options.params && Object.keys(options.params).length > 0) result.params = options.params;
  if (options.action) result.action = options.action;
  return result;
}

function coveredBanner(facts: Facts, workspaceName: string | undefined): PersonalBanner {
  const { usage, tier, stripeBilled, stripeTrial, ending } = facts;
  const named = (
    id: string,
    action?: PersonalAction,
    extra: Record<string, string> = {}
  ): PersonalBanner =>
    banner(id, "warning", {
      keyId: workspaceName ? id : `${id}Unnamed`,
      params: workspaceName ? { workspace: workspaceName, ...extra } : extra,
      action,
    });
  // The plan still being paid for, by its brand name.
  const plan = PERSONAL_PLAN_NAMES[tier === "business" ? "business" : "pro"];
  const cancel: PersonalAction = { kind: tier === "business" ? "cancelBusiness" : "cancelPro" };

  if (ending || facts.storeCanceled) return named("covered");
  if (usage.isPastDue) return named("coveredPastDue", { kind: "updatePayment" });
  if (stripeTrial && tier === "pro") return named("coveredStripeTrial", { kind: "cancelTrial" });
  if (stripeBilled) return named("coveredPaying", cancel, { plan });
  if (usage.storeBilling && usage.currentPeriodEnd)
    return named("coveredStore", undefined, { plan });
  return named("covered");
}

function resolveBanners(facts: Facts, coveringWorkspaceNames: string[]): PersonalBanner[] {
  const { usage, tier, covered, storePastDue, ending, summary } = facts;
  const banners: PersonalBanner[] = [];
  if (ending) {
    const plan = PERSONAL_PLAN_NAMES[tier === "business" ? "business" : "pro"];
    const date = usage.currentPeriodEnd;
    banners.push(
      banner("ending", "warning", {
        keyId: date ? "endingDated" : "ending",
        params: date ? { plan, date } : { plan },
        action: { kind: "keepPlan", plan },
      })
    );
  }
  if (covered) return [...banners, coveredBanner(facts, coveringWorkspaceNames[0])];

  if (usage.isPastDue) {
    const retry = summary?.outstanding_invoice?.next_payment_attempt;
    banners.push(
      banner("paymentFailed", "destructive", {
        keyId: retry ? "paymentFailedRetry" : "paymentFailed",
        params: retry ? { date: retry } : undefined,
        action: { kind: "updatePayment" },
      })
    );
  }
  if (storePastDue) banners.push(banner("storeRenewalFailed", "destructive"));
  if (tier === "free" && usage.isOverLimit) banners.push(banner("weeklyLimit", "warning"));
  return banners;
}

function resolveUsage({ usage, covered }: Facts): PersonalUsageRow[] {
  if (covered || (usage.isSubscribed && !usage.isPastDue)) return [{ kind: "unlimited" }];
  const tone = usage.isOverLimit ? "destructive" : usage.isApproachingLimit ? "warning" : "normal";
  return [
    {
      kind: "words",
      used: usage.wordsUsed,
      limit: usage.limit,
      remaining: usage.wordsRemaining,
      tone,
    },
  ];
}

function dateDetail(labelKey: string, iso: string | null): PersonalDetail[] {
  return iso ? [{ labelKey, value: { kind: "date", iso } }] : [];
}

function resolveDetails(
  { usage, stripeBilled, stripeTrial, storeCanceled, cardlessTrial, ending, summary }: Facts,
  now: number
): PersonalDetail[] {
  if (usage.storeBilling) {
    return [
      {
        labelKey: "details.billedThrough",
        value: { kind: "storeName", store: usage.storeBilling.store },
      },
      ...dateDetail(
        storeCanceled ? "details.accessUntil" : "details.periodEnds",
        usage.currentPeriodEnd
      ),
    ];
  }
  const details: PersonalDetail[] = [];
  const next = summary?.next_invoice;
  const hasNextInvoice =
    next && (next.date || (Number.isFinite(next.amount) && next.currency?.trim()));
  const outstanding = summary?.outstanding_invoice;
  const { currentPeriodEnd, subscriptionStatus } = usage;
  if (cardlessTrial) return details;

  if (ending) {
    details.push(...dateDetail("details.ends", currentPeriodEnd));
  } else if (
    subscriptionStatus === "canceled" &&
    currentPeriodEnd &&
    Date.parse(currentPeriodEnd) <= now
  ) {
    details.push(...dateDetail("details.ended", currentPeriodEnd));
  } else if (stripeBilled && !usage.isPastDue && hasNextInvoice) {
    details.push({
      labelKey: stripeTrial ? "details.firstInvoice" : "details.nextInvoice",
      value: { kind: "invoice", ...next },
    });
  } else if (stripeBilled && (stripeTrial || !outstanding)) {
    details.push(...dateDetail("details.periodEnds", currentPeriodEnd));
  }

  if (hasNextInvoice && (ending || (usage.isPastDue && summary?.cancel_at_period_end))) {
    details.push({ labelKey: "details.finalInvoice", value: { kind: "invoice", ...next } });
  }

  if (outstanding) {
    const { next_payment_attempt: date, amount_remaining: amount, currency } = outstanding;
    if (date || (Number.isFinite(amount) && currency?.trim())) {
      details.push({
        labelKey: date ? "details.nextRetry" : "details.amountDue",
        value: { kind: "invoice", date, amount, currency },
      });
    }
  }
  if (summary?.billing_email?.trim()) {
    details.push({
      labelKey: "details.billingContact",
      value: { kind: "text", text: summary.billing_email },
    });
  }
  return details;
}

export function personalPlanState(input: PersonalPlanInput): PersonalPlanState {
  if (!input.signedIn) return { kind: "signedOut" };
  const { usage } = input;
  if (!usage) return { kind: "loading" };
  if (usage.status === "error") return { kind: "failed" };
  if (usage.status !== "success") return { kind: "loading" };

  const cardlessTrial = isCardlessTrial(usage);
  const summary = cardlessTrial || usage.storeBilling ? undefined : input.summary;
  const stripeBilled =
    !usage.storeBilling && !cardlessTrial && (usage.isPastDue || usage.isPersonallySubscribed);
  const stripeTrial = stripeBilled && usage.subscriptionStatus === "trialing";
  const facts: Facts = {
    usage,
    tier: resolveTier(usage),
    covered: usage.entitledWorkspaceIds.length > 0,
    stripeBilled,
    cardlessTrial,
    stripeTrial,
    ending: Boolean(
      summary?.cancel_at_period_end &&
      stripeBilled &&
      !usage.isPastDue &&
      (usage.subscriptionStatus === "active" || stripeTrial)
    ),
    summary,
    storePastDue: usage.storeBilling?.status === "past_due",
    storeCanceled: usage.storeBilling?.status === "canceled",
  };

  return {
    kind: "ready",
    tier: facts.tier,
    showPlansGrid: !facts.covered || facts.tier !== "free" || input.hasWorkspacePlanAction,
    badge: resolveBadge(facts, input.now),
    price: resolvePrice(facts),
    actions: resolveActions(facts, input.businessAction),
    banners: resolveBanners(facts, input.coveringWorkspaceNames),
    usage: resolveUsage(facts),
    details: resolveDetails(facts, input.now),
  };
}
