import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/dialog";
import { canChangeCloudBackupPreference, isCloudBackupAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { syncService } from "../services/SyncService.js";
import { useSettings } from "./useSettings";

/**
 * Single owner of the "Sync personal Insights" opt-in, shared by the Settings
 * toggle and the Insights banner. Dictations recorded before signing in stay
 * unattributed until the user says otherwise here — signing in never adopts
 * them on its own — so the prompt is the only path that claims them.
 *
 * These counters are user data leaving the device, so they ride on the same
 * managed-workspace permission as cloud backup: a policy that forbids backup
 * forbids the sync, and an already-on toggle stays switchable off.
 *
 * Declining the prompt declines the whole opt-in, exactly like dismissing it:
 * turning sync on while leaving those rows behind would swap the dashboard to
 * the account summary they are not in, dropping totals the user just chose to
 * keep. Enabling therefore always means "these counters too". With sync already
 * on that swap has happened, so declining there just leaves the rows where the
 * user already had them.
 *
 * unclaimedCount is kept live rather than read only at opt-in time, because
 * more rows appear after it: the toggle survives sign-out, so anything spoken
 * before the next sign-in is unattributed with sync already on. It is what
 * canOfferAnalyticsClaim uses to keep offering this prompt.
 */
export function useInsightsSyncOptIn() {
  const { t } = useTranslation();
  const { insightsSyncEnabled, setInsightsSyncEnabled } = useSettings();
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  // Separate from the count: a live count must never be what holds the dialog
  // open, or it reopens itself on mount for anyone with rows left behind.
  const [claimPromptOpen, setClaimPromptOpen] = useState(false);
  const syncAllowedByPolicy = usePolicyStore(isCloudBackupAllowed);
  const canToggleSync = canChangeCloudBackupPreference(syncAllowedByPolicy, insightsSyncEnabled);

  // The claim lands before the pass is requested so the rows it adopts go up
  // with it, rather than waiting for the next ambient one.
  const activate = useCallback(
    async (claimAnonymous: boolean) => {
      if (claimAnonymous) {
        await window.electronAPI.claimAnonymousAnalyticsEvents().catch((error) => {
          console.error("Claiming earlier Insights events failed:", error);
        });
      }
      setInsightsSyncEnabled(true);
      syncService.requestSyncAll("manual");
    },
    [setInsightsSyncEnabled]
  );

  const refreshUnclaimedCount = useCallback(async () => {
    const unclaimed = await window.electronAPI.countUnclaimedAnalyticsEvents().catch(() => 0);
    setUnclaimedCount(unclaimed);
    return unclaimed;
  }, []);

  // Every claim, purge and new dictation broadcasts analytics-changed, so the
  // count follows the rows without polling.
  useEffect(() => {
    void refreshUnclaimedCount();
    return window.electronAPI.onAnalyticsChanged?.(() => void refreshUnclaimedCount());
  }, [refreshUnclaimedCount]);

  const enableInsightsSync = useCallback(() => {
    if (!syncAllowedByPolicy) return;
    void (async () => {
      if ((await refreshUnclaimedCount()) > 0) setClaimPromptOpen(true);
      else await activate(false);
    })();
  }, [activate, refreshUnclaimedCount, syncAllowedByPolicy]);

  const optInDialog = (
    <ConfirmDialog
      open={claimPromptOpen}
      onOpenChange={(open) => {
        if (!open) setClaimPromptOpen(false);
      }}
      title={t("insights.claimTitle")}
      description={t("insights.claimDescription", { count: unclaimedCount })}
      confirmText={t("insights.claimInclude")}
      cancelText={t("insights.claimSkip")}
      onConfirm={() => void activate(true)}
    />
  );

  return { canToggleSync, enableInsightsSync, optInDialog, syncAllowedByPolicy, unclaimedCount };
}
