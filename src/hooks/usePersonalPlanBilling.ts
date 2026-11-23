import {
  isCardlessTrial,
  personalPlanState,
  type PersonalPlanInput,
  type PersonalPlanState,
} from "../lib/personalPlanState";
import type { PlansBillingView } from "../lib/plansBillingView";
import { useBillingSummary } from "./useBillingSummary";

interface PersonalPlanBillingInput extends Omit<PersonalPlanInput, "now" | "summary"> {
  enabled: boolean;
  view: PlansBillingView["kind"];
}

interface PersonalPlanBillingResult {
  state: PersonalPlanState;
  refreshSummary: () => void;
}

export function usePersonalPlanBilling({
  enabled,
  view,
  ...plan
}: PersonalPlanBillingInput): PersonalPlanBillingResult {
  const { usage, signedIn } = plan;
  const showSummary =
    enabled &&
    signedIn &&
    view === "personal" &&
    usage?.status === "success" &&
    !usage.storeBilling &&
    !isCardlessTrial(usage);
  const { summary, refresh } = useBillingSummary(
    showSummary ? { kind: "personal" } : { kind: "disabled" },
    showSummary
      ? [
          usage.plan,
          usage.isPersonallySubscribed,
          usage.subscriptionStatus,
          usage.billingInterval,
          usage.currentPeriodEnd,
        ].join("|")
      : undefined
  );

  return {
    state: personalPlanState({ ...plan, summary, now: Date.now() }),
    refreshSummary: refresh,
  };
}
