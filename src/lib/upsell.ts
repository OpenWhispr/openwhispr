import type { ProviderStore, StoreBilling } from "./usageStore.ts";

export type UpsellDecision = "show" | "hide" | "unknown";

export interface UpsellInput {
  authLoaded: boolean;
  isSignedIn: boolean;
  /** `null` while the entitlement is unresolved. */
  hasPaidAccess: boolean | null;
  isPastDue: boolean;
}

export function decideUpsell({
  authLoaded,
  isSignedIn,
  hasPaidAccess,
  isPastDue,
}: UpsellInput): UpsellDecision {
  if (!authLoaded) return "unknown";
  // Signed out there is no usage response to await; the upsell is the point.
  if (!isSignedIn) return "show";
  if (hasPaidAccess === null) return "unknown";
  // Past due already has its own banner, toast and recovery button.
  if (isPastDue || hasPaidAccess) return "hide";
  return "show";
}

export type ProPlanCardCta =
  "currentPlan" | "downgradeToPro" | "coveredByWorkspace" | "checkout" | "signUp" | "none";

export interface ProPlanCardInput {
  isSignedIn: boolean;
  /** Signed out, or usage.status === "success". */
  planStateKnown: boolean;
  isPersonallySubscribed: boolean;
  /** Bought in the mobile app: any Stripe checkout or plan switch would bill twice. */
  isStoreBilled: boolean;
  plan: string;
  isTrial: boolean;
  /** SettingsPage's usage-payload predicate — not the workspace store. */
  isWorkspaceCovered: boolean;
}

export function decideProPlanCardCta(i: ProPlanCardInput): ProPlanCardCta {
  // A workspace seat outranks a store plan, as it does in the account row.
  if (i.isStoreBilled && !i.isWorkspaceCovered)
    return i.plan === "business" ? "none" : "currentPlan";
  if ((i.isPersonallySubscribed && i.plan === "pro" && !i.isTrial) || i.isTrial)
    return "currentPlan";
  if (i.isPersonallySubscribed && i.plan === "business") return "downgradeToPro";
  if (!i.isSignedIn) return "signUp";
  if (!i.planStateKnown) return "none"; // fail-closed while entitlement unknown
  if (i.isWorkspaceCovered) return "coveredByWorkspace"; // the regression fix
  return "checkout";
}

/** Which plan the account row shows, in precedence order. */
export type AccountPlanRow = "trial" | "pastDue" | "personal" | "store" | "workspaceOrFree";

/** The account row's description text. */
export type AccountPlanDescription =
  | "trial"
  | "pastDue"
  | "storePaymentIssue"
  | "accessUntil"
  | "nextBilling"
  | "unlimited"
  | "providedBy"
  | "freeUsage";

/** The account row's billing button. `storeNote` is store billing on an API that doesn't name the store. */
export type AccountPlanAction =
  "updatePayment" | "manageBilling" | "manageInStore" | "storeNote" | "upgrade" | "none";

export interface AccountPlanInput {
  isTrial: boolean;
  /** Stripe past due only (`isPastDueUsage`). */
  isPastDue: boolean;
  isPersonallySubscribed: boolean;
  storeBilling: StoreBilling | null;
  isWorkspaceCovered: boolean;
  hasPeriodEnd: boolean;
  /** The workspace store has loaded the covering workspaces, so their names can be shown. */
  hasCoveringWorkspaceNames: boolean;
}

export function resolveAccountPlan(i: AccountPlanInput): {
  row: AccountPlanRow;
  description: AccountPlanDescription;
  action: AccountPlanAction;
} {
  // A workspace seat outranks a store plan for the row, but the store still
  // bills, so the button stays on the store.
  const row: AccountPlanRow = i.isTrial
    ? "trial"
    : i.isPastDue
      ? "pastDue"
      : i.isPersonallySubscribed
        ? "personal"
        : i.storeBilling && !i.isWorkspaceCovered
          ? "store"
          : "workspaceOrFree";
  const storeStatus = row === "store" ? i.storeBilling?.status : undefined;
  const description: AccountPlanDescription =
    row === "trial" || row === "pastDue"
      ? row
      : row === "workspaceOrFree"
        ? i.hasCoveringWorkspaceNames
          ? "providedBy"
          : // usage.limit is -1 once subscribed, which the free-usage copy
            // would print as "-1 words".
            i.isWorkspaceCovered
            ? "unlimited"
            : "freeUsage"
        : storeStatus === "past_due"
          ? "storePaymentIssue"
          : !i.hasPeriodEnd
            ? "unlimited"
            : // A canceled store subscription stays entitled until the period
              // it was paid for ends.
              storeStatus === "canceled"
              ? "accessUntil"
              : "nextBilling";
  const action: AccountPlanAction = i.isPastDue
    ? "updatePayment"
    : i.storeBilling
      ? i.storeBilling.store
        ? "manageInStore"
        : "storeNote"
      : i.isPersonallySubscribed && !i.isTrial
        ? "manageBilling"
        : i.isWorkspaceCovered
          ? "none"
          : "upgrade";
  return { row, description, action };
}

const STORE_SUBSCRIPTIONS_URL: Record<ProviderStore, string> = {
  app_store: "https://apps.apple.com/account/subscriptions",
  play_store: "https://play.google.com/store/account/subscriptions",
};

export function storeSubscriptionsUrl(store: ProviderStore): string {
  return STORE_SUBSCRIPTIONS_URL[store];
}
