import React from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Loader2 } from "../../icons";
import { Button } from "../../ui/button";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../../ui/SettingsSection";
import WorkspaceBillingCard from "../WorkspaceBillingCard";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { PlansBillingView } from "../../../lib/plansBillingView";

interface WorkspaceBillingViewProps {
  view: Exclude<PlansBillingView, { kind: "personal" }>;
  onViewPersonal: () => void;
  yearly: boolean;
  onYearlyChange: (yearly: boolean) => void;
  onRefreshEntitlement?: () => Promise<void>;
}

export function WorkspaceBillingView({
  view,
  onViewPersonal,
  yearly,
  onYearlyChange,
  onRefreshEntitlement,
}: WorkspaceBillingViewProps): React.ReactElement {
  const { t } = useTranslation();
  const { loading, refresh } = useWorkspaceStore(
    useShallow((s) => ({ loading: s.loading, refresh: s.refresh }))
  );

  if (view.kind === "workspace") {
    return (
      <WorkspaceBillingCard
        // A fresh card per workspace, so nothing one workspace's card holds reaches another's.
        key={view.workspace.id}
        workspace={view.workspace}
        yearly={yearly}
        onYearlyChange={onYearlyChange}
        onViewPersonal={onViewPersonal}
        onRefreshEntitlement={onRefreshEntitlement}
      />
    );
  }

  if (view.kind === "workspaceLoading") {
    return (
      <div className="space-y-2" aria-hidden="true">
        <div className="h-4 w-36 rounded bg-foreground/5 animate-pulse" />
        <div className="h-36 rounded-lg bg-foreground/5 animate-pulse" />
      </div>
    );
  }

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.billing.workspaceUnavailable.title")}
          description={t("settingsPage.billing.workspaceUnavailable.description")}
        >
          <Button onClick={() => void refresh()} variant="outline" size="sm" disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : t("common.retry")}
          </Button>
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}
