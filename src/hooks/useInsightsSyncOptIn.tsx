import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/dialog";
import { syncPendingAnalytics } from "../services/AnalyticsService";
import { useSettings } from "./useSettings";

/**
 * Single owner of the "Sync personal Insights" opt-in, shared by the Settings
 * toggle and the Insights banner. Dictations recorded before signing in stay
 * unattributed until the user says otherwise here — signing in never adopts
 * them on its own — so the prompt is the only path that claims them.
 */
export function useInsightsSyncOptIn() {
  const { t } = useTranslation();
  const { setInsightsSyncEnabled } = useSettings();
  const [unclaimedCount, setUnclaimedCount] = useState(0);

  const activate = useCallback(
    (claimAnonymous: boolean) => {
      void (async () => {
        setInsightsSyncEnabled(true);
        try {
          if (claimAnonymous) await window.electronAPI.claimAnonymousAnalyticsEvents();
          await syncPendingAnalytics();
        } catch (error) {
          console.error("Enabling Insights sync failed:", error);
        }
      })();
    },
    [setInsightsSyncEnabled]
  );

  const enableInsightsSync = useCallback(() => {
    void (async () => {
      const unclaimed = await window.electronAPI.countUnclaimedAnalyticsEvents().catch(() => 0);
      if (unclaimed > 0) setUnclaimedCount(unclaimed);
      else activate(false);
    })();
  }, [activate]);

  const optInDialog = (
    <ConfirmDialog
      open={unclaimedCount > 0}
      onOpenChange={(open) => {
        if (!open) setUnclaimedCount(0);
      }}
      title={t("insights.claimTitle")}
      description={t("insights.claimDescription", { count: unclaimedCount })}
      confirmText={t("insights.claimInclude")}
      cancelText={t("insights.claimSkip")}
      onConfirm={() => activate(true)}
      onCancel={() => activate(false)}
    />
  );

  return { enableInsightsSync, optInDialog };
}
