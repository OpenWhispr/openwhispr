import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/dialog";
import { useSettings } from "./useSettings";

/**
 * Single owner of the "Sync personal Insights" opt-in, shared by the Settings
 * toggle and the Insights banner. Dictations recorded before signing in stay
 * unattributed until the user says otherwise here — signing in never adopts
 * them on its own — so the prompt is the only path that claims them.
 *
 * Flipping the setting and claiming are all this does: pushing the pending
 * rows stays with InsightsView, whose reload the flip and the claim's
 * analytics-changed broadcast both re-fire. Syncing here too would race that
 * reload, which could then read a summary the other pass had not finished.
 */
export function useInsightsSyncOptIn() {
  const { t } = useTranslation();
  const { setInsightsSyncEnabled } = useSettings();
  const [unclaimedCount, setUnclaimedCount] = useState(0);

  const activate = useCallback(
    (claimAnonymous: boolean) => {
      setInsightsSyncEnabled(true);
      if (!claimAnonymous) return;
      window.electronAPI.claimAnonymousAnalyticsEvents().catch((error) => {
        console.error("Claiming earlier Insights events failed:", error);
      });
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
