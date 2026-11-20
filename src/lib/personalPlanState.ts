import type { BillingTone } from "../components/settings/billing/billingTones";
import type { UseUsageResult } from "../hooks/useUsage";
import type { ProviderStore } from "./usageStore";
import type { BusinessTileAction } from "./workspaceBilling";

export type PersonalAction =
  | { kind: "subscribePro" }
  | { kind: "manageBilling" }
  | { kind: "updatePayment" }
  | { kind: "manageInStore"; store: ProviderStore }
  | { kind: "signIn" }
  | { kind: "retry" }
  | { kind: "cancelPro" }
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
}

export type PersonalTier = "free" | "pro" | "business";

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
  value: { kind: "date"; iso: string } | { kind: "storeName"; store: ProviderStore | null };
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
      tier: PersonalTier;
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
  tier: PersonalTier;
  covered: boolean;
  /** A Stripe subscription, paid or past due: the portal can manage and cancel it. */
  stripeBilled: boolean;
  cardlessTrial: boolean;
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

function resolveTier(usage: PersonalUsage): PersonalTier {
  // Past due isn't entitled, so it reports no personal source, but the plan is still theirs.
  if (usage.isPastDue || usage.isPersonallySubscribed || usage.storeBilling) {
    return usage.plan === "business" ? "business" : "pro";
  }
  return usage.isTrial ? "pro" : "free";
}

function resolveBadge({ usage, tier, storePastDue, storeCanceled }: Facts): PersonalBadge | null {
  if (usage.isTrial) {
    return {
      key: "badges.trial",
      params: { days: String(usage.trialDaysLeft ?? 0) },
      tone: "info",
    };
  }
  if (usage.isPastDue || storePastDue) return { key: "badges.pastDue", tone: "destructive" };
  if (storeCanceled) return { key: "badges.cancelled", tone: "destructive" };
  // A covered member's interval can describe the workspace's subscription, not theirs.
  if (tier === "free") return null;
  if (usage.billingInterval === "annual") return { key: "badges.yearly", tone: "info" };
  if (usage.billingInterval === "monthly") return { key: "badges.monthly", tone: "info" };
  return null;
}

function resolvePrice({ usage, tier, stripeBilled }: Facts): PersonalPrice | null {
  if (tier === "free") return { key: "price.free" };
  // Only Stripe Pro has a known price: Business has none here, a store may charge another,
  // and a cardless trial pays nothing (its badge says so).
  if (!stripeBilled || tier !== "pro") return null;
  if (usage.billingInterval === "annual") return { key: "price.billedYearly" };
  return { key: "price.proMonthly" };
}

function businessActions(action: BusinessTileAction): PersonalAction[] {
  if (action.kind === "none" || action.kind === "workspacePlan") return [];
  return [{ kind: "business", action }];
}

function resolveActions(facts: Facts, businessAction: BusinessTileAction): PersonalAction[] {
  const { usage, tier, covered, stripeBilled, cardlessTrial } = facts;
  if (usage.isPastDue) return [{ kind: "manageBilling" }];
  if (tier === "free" || cardlessTrial) {
    return covered ? [] : [{ kind: "subscribePro" }, ...businessActions(businessAction)];
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
  const { usage, stripeBilled } = facts;
  const named = (id: string, action?: PersonalAction): PersonalBanner =>
    banner(id, "warning", {
      keyId: workspaceName ? id : `${id}Unnamed`,
      params: workspaceName ? { workspace: workspaceName } : {},
      action,
    });

  if (usage.isPastDue) return named("coveredPastDue", { kind: "cancelPro" });
  if (stripeBilled) return named("coveredPaying", { kind: "cancelPro" });
  if (usage.storeBilling) return named("coveredStore");
  return named("covered");
}

function resolveBanners(facts: Facts, coveringWorkspaceNames: string[]): PersonalBanner[] {
  const { usage, tier, covered, storePastDue } = facts;
  if (covered) return [coveredBanner(facts, coveringWorkspaceNames[0])];

  const banners: PersonalBanner[] = [];
  if (usage.isPastDue) {
    banners.push(banner("paymentFailed", "destructive", { action: { kind: "updatePayment" } }));
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

function resolveDetails({ usage, stripeBilled, storeCanceled }: Facts): PersonalDetail[] {
  if (stripeBilled) return dateDetail("details.periodEnds", usage.currentPeriodEnd);
  if (usage.storeBilling) {
    return [
      {
        labelKey: "details.billedThrough",
        value: { kind: "storeName", store: usage.storeBilling.store },
      },
      ...dateDetail(
        storeCanceled ? "details.accessUntil" : "details.renews",
        usage.currentPeriodEnd
      ),
    ];
  }
  return [];
}

export function personalPlanState(input: PersonalPlanInput): PersonalPlanState {
  if (!input.signedIn) return { kind: "signedOut" };
  const { usage } = input;
  if (!usage) return { kind: "loading" };
  if (usage.status === "error") return { kind: "failed" };
  if (usage.status !== "success") return { kind: "loading" };

  const cardlessTrial = isCardlessTrial(usage);
  const facts: Facts = {
    usage,
    tier: resolveTier(usage),
    covered: usage.entitledWorkspaceIds.length > 0,
    stripeBilled: usage.isPastDue || (usage.isPersonallySubscribed && !cardlessTrial),
    cardlessTrial,
    storePastDue: usage.storeBilling?.status === "past_due",
    storeCanceled: usage.storeBilling?.status === "canceled",
  };

  return {
    kind: "ready",
    tier: facts.tier,
    badge: resolveBadge(facts),
    price: resolvePrice(facts),
    actions: resolveActions(facts, input.businessAction),
    banners: resolveBanners(facts, input.coveringWorkspaceNames),
    usage: resolveUsage(facts),
    details: resolveDetails(facts),
  };
}
