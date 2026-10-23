import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { highestPlan } from "../lib/usageStore";
import { resolveAccountPlan } from "../lib/upsell";
import type { UseUsageResult } from "./useUsage";

interface AccountPlan {
  accountPlan: ReturnType<typeof resolveAccountPlan>;
  isWorkspaceCovered: boolean;
  coveringWorkspaceNames: string[];
  /** The covering workspaces' best plan; null until the workspace store resolves them. */
  coveringPlanLabel: string | null;
  /** The plan the account is on, as Settings → Plans & Billing names it; null until known. */
  planLabel: string | null;
}

export function useAccountPlan(usage: UseUsageResult | null): AccountPlan {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const coveringWorkspaces = workspaces.filter((workspace) =>
    usage?.entitledWorkspaceIds?.includes(workspace.id)
  );
  const coveringWorkspaceNames = coveringWorkspaces.map((workspace) => workspace.name);
  // Reads the usage payload, not the workspace store, so the upgrade affordances
  // stay hidden across the window where the store is still loading.
  const isWorkspaceCovered =
    !usage?.isPersonallySubscribed && (usage?.entitledWorkspaceIds?.length ?? 0) > 0;
  // Null until the store resolves, so the label waits rather than guessing a tier.
  const coveringPlanLabel =
    isWorkspaceCovered && coveringWorkspaces.length
      ? t(
          `settingsPage.workspace.billing.planLabel.${highestPlan(
            coveringWorkspaces.map((workspace) => workspace.plan)
          )}`
        )
      : null;

  const accountPlan = resolveAccountPlan({
    isTrial: usage?.isTrial ?? false,
    isPastDue: usage?.isPastDue ?? false,
    isPersonallySubscribed: usage?.isPersonallySubscribed ?? false,
    storeBilling: usage?.storeBilling ?? null,
    isWorkspaceCovered,
    hasPeriodEnd: Boolean(usage?.currentPeriodEnd),
    hasCoveringWorkspaceNames: coveringWorkspaceNames.length > 0,
  });

  const planLabel =
    usage?.status !== "success"
      ? null
      : accountPlan.row === "trial"
        ? t("settingsPage.account.planLabels.trial")
        : accountPlan.row === "pastDue"
          ? t("settingsPage.account.planLabels.free")
          : accountPlan.row === "personal" || accountPlan.row === "store"
            ? usage.plan === "business"
              ? t("settingsPage.account.planLabels.business")
              : t("settingsPage.account.planLabels.pro")
            : isWorkspaceCovered
              ? coveringPlanLabel
              : t("settingsPage.account.planLabels.free");

  return {
    accountPlan,
    isWorkspaceCovered,
    coveringWorkspaceNames,
    coveringPlanLabel,
    planLabel,
  };
}
