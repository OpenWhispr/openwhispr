import {
  isCardlessTrial,
  type PersonalAction,
  type PersonalPlanState,
  type PersonalUsage,
} from "../../../lib/personalPlanState";
import { CONTACT_SALES_URL } from "../../../lib/contactSales";
import { storeSubscriptionsUrl } from "../../../lib/upsell";
import type { BusinessCardAction, EnterpriseCardAction } from "./PlansGrid";

export type PersonalProCardKind =
  "subscribe" | "current" | "covered" | "signIn" | "downgrade" | "none";

/** What the Personal view's buttons and Plans grid tiles lead to; SettingsPage supplies them. */
export interface PersonalPlanHandlers {
  subscribePro: () => void;
  openBillingPortal: () => void;
  openExternal: (url: string) => void;
  signIn: () => void;
  retry: () => void;
  viewWorkspace: (workspaceId: string) => void;
  createWorkspace: () => void;
}

export function personalProCardKind(input: {
  signedIn: boolean;
  state: PersonalPlanState;
  usage: Pick<
    PersonalUsage,
    | "isPersonallySubscribed"
    | "isPastDue"
    | "isTrial"
    | "plan"
    | "storeBilling"
    | "entitledWorkspaceIds"
  > | null;
}): PersonalProCardKind {
  const { signedIn, state, usage } = input;
  if (!signedIn) return "signIn";
  if (state.kind !== "ready" || !usage) return "none";
  if (state.actions[0]?.kind === "subscribePro") return "subscribe";
  // The failed payment is fixed in the portal, from the current plan's Manage billing.
  if (usage.isPastDue) return "none";
  const covered = usage.entitledWorkspaceIds.length > 0;
  // An uncovered one subscribes above; a covered one pays nothing, as a covered free member.
  if (isCardlessTrial(usage)) return covered ? "covered" : "none";
  if (usage.isPersonallySubscribed) return usage.plan === "business" ? "downgrade" : "current";
  // Still paying for Pro through the store, so Pro stays their plan, as with Stripe.
  if (usage.storeBilling) return usage.plan === "business" ? "none" : "current";
  return covered ? "covered" : "none";
}

// A checkout is a workspace view's own button; the personal view never sells a workspace plan.
export function runBusinessTileAction(
  action: BusinessCardAction,
  handlers: Pick<PersonalPlanHandlers, "viewWorkspace" | "createWorkspace">
): void {
  if (action.kind === "viewWorkspace") handlers.viewWorkspace(action.workspaceId);
  else if (action.kind === "createWorkspace") handlers.createWorkspace();
}

export function runEnterpriseTileAction(
  action: EnterpriseCardAction,
  handlers: Pick<PersonalPlanHandlers, "viewWorkspace" | "openExternal">
): void {
  if (action.kind === "viewWorkspace") handlers.viewWorkspace(action.workspaceId);
  else if (action.kind === "contactSales") handlers.openExternal(CONTACT_SALES_URL);
}

export function runPersonalAction(action: PersonalAction, handlers: PersonalPlanHandlers): void {
  switch (action.kind) {
    case "subscribePro":
      handlers.subscribePro();
      return;
    // Cancelling happens in the Stripe portal.
    case "manageBilling":
    case "updatePayment":
    case "cancelPro":
    case "cancelTrial":
    case "cancelBusiness":
    case "keepPlan":
      handlers.openBillingPortal();
      return;
    case "manageInStore":
      handlers.openExternal(storeSubscriptionsUrl(action.store));
      return;
    case "signIn":
      handlers.signIn();
      return;
    case "retry":
      handlers.retry();
      return;
    case "business":
      runBusinessTileAction(action.action, handlers);
      return;
  }
}

const PORTAL_ACTIONS: ReadonlySet<PersonalAction["kind"]> = new Set([
  "manageBilling",
  "updatePayment",
  "cancelPro",
  "cancelTrial",
  "cancelBusiness",
  "keepPlan",
]);

/** The actions `runPersonalAction` sends to the Stripe portal. */
export function isPortalAction(kind: PersonalAction["kind"] | null): boolean {
  return kind !== null && PORTAL_ACTIONS.has(kind);
}

export type BillingIntervalChoice = "monthly" | "annual";

export function billingIntervalChoice(yearlyBilling: boolean): BillingIntervalChoice {
  return yearlyBilling ? "annual" : "monthly";
}

/** Which button spins: a checkout opening, a retry, or the portal action that was clicked. */
export function personalBusyAction(input: {
  proCheckoutOpening: boolean;
  isRetrying: boolean;
  isOpeningBilling: boolean;
  portalAction: PersonalAction["kind"] | null;
}): PersonalAction["kind"] | null {
  if (input.proCheckoutOpening) return "subscribePro";
  if (input.isRetrying) return "retry";
  return input.isOpeningBilling ? input.portalAction : null;
}
