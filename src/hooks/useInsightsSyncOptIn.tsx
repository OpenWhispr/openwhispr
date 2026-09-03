import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/dialog";
import { canChangeCloudBackupPreference, isCloudBackupAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { syncService } from "../services/SyncService.js";
import { LeaderboardService } from "../services/LeaderboardService";
import { reconcileLeaderboardParticipation } from "../helpers/leaderboard";
import { useAuth } from "./useAuth";
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
  const { isLoaded, isSignedIn } = useAuth();
  const { insightsSyncEnabled, setInsightsSyncEnabled } = useSettings();
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [awaitingUploadCount, setAwaitingUploadCount] = useState(0);
  const [participationReady, setParticipationReady] = useState(false);
  const [participationEnabled, setParticipationEnabled] = useState(false);
  const [participationError, setParticipationError] = useState(false);
  const [participationUpdating, setParticipationUpdating] = useState(false);
  const reconciliationIdRef = useRef(0);
  // Separate from the counts: a live count must never be what holds the dialog
  // open, or it reopens itself on mount for anyone with rows left behind.
  // "enable" asks about everything the first pass would upload; "claim" is the
  // narrower question that is left once sync is already on.
  const [promptKind, setPromptKind] = useState<"enable" | "claim" | null>(null);
  const syncAllowedByPolicy = usePolicyStore(isCloudBackupAllowed);
  const canToggleSync =
    canChangeCloudBackupPreference(syncAllowedByPolicy, insightsSyncEnabled) &&
    participationReady &&
    !participationUpdating;

  // The account preference is authoritative once it exists. This lets the
  // existing device-local Sync switch roam safely without a newly signed-in
  // device silently opting the account out with its default `false` value.
  useEffect(() => {
    const reconciliationId = ++reconciliationIdRef.current;
    if (!isLoaded || !isSignedIn) {
      setParticipationReady(false);
      setParticipationEnabled(false);
      setParticipationError(false);
      return;
    }

    setParticipationReady(false);
    setParticipationError(false);
    void (async () => {
      try {
        let participation = await LeaderboardService.getParticipation();
        const reconciliation = reconcileLeaderboardParticipation(
          participation,
          insightsSyncEnabled
        );
        if (reconciliation.publish !== null) {
          participation = await LeaderboardService.setParticipation(reconciliation.publish);
        }
        if (reconciliationId !== reconciliationIdRef.current) return;
        setParticipationEnabled(participation.enabled);
        if (reconciliation.enabled !== insightsSyncEnabled) {
          setInsightsSyncEnabled(reconciliation.enabled);
        }
        setParticipationReady(true);
      } catch (error) {
        if (reconciliationId !== reconciliationIdRef.current) return;
        console.error("Reconciling leaderboard participation failed:", error);
        setParticipationError(true);
        setParticipationReady(true);
      }
    })();
  }, [insightsSyncEnabled, isLoaded, isSignedIn, setInsightsSyncEnabled]);

  // The claim lands before the pass is requested so the rows it adopts go up
  // with it, rather than waiting for the next ambient one.
  const activate = useCallback(
    async (claimAnonymous: boolean) => {
      setParticipationUpdating(true);
      if (claimAnonymous) {
        await window.electronAPI.claimAnonymousAnalyticsEvents().catch((error) => {
          console.error("Claiming earlier Insights events failed:", error);
        });
      }
      try {
        const participation = await LeaderboardService.setParticipation(true);
        setParticipationEnabled(participation.enabled);
        setParticipationError(false);
        setInsightsSyncEnabled(true);
        syncService.requestSyncAll("manual");
      } catch (error) {
        console.error("Enabling Insights sync failed:", error);
        setParticipationError(true);
      } finally {
        setParticipationUpdating(false);
      }
    },
    [setInsightsSyncEnabled]
  );

  const disableInsightsSync = useCallback(async () => {
    setParticipationUpdating(true);
    try {
      const participation = await LeaderboardService.setParticipation(false);
      setParticipationEnabled(participation.enabled);
      setParticipationError(false);
      setInsightsSyncEnabled(false);
    } catch (error) {
      // Keep the toggle on when the account-level opt-out did not reach the
      // server; showing it as off while old totals remain ranked would be a
      // privacy-breaking lie.
      console.error("Disabling Insights sync failed:", error);
      setParticipationError(true);
    } finally {
      setParticipationUpdating(false);
    }
  }, [setInsightsSyncEnabled]);

  const refreshCounts = useCallback(async () => {
    const [unclaimed, awaitingUpload] = await Promise.all([
      window.electronAPI.countUnclaimedAnalyticsEvents().catch(() => 0),
      window.electronAPI.countAnalyticsEventsAwaitingUpload().catch(() => 0),
    ]);
    setUnclaimedCount(unclaimed);
    setAwaitingUploadCount(awaitingUpload);
    return { unclaimed, awaitingUpload };
  }, []);

  // Every claim, purge and new dictation broadcasts analytics-changed, so the
  // counts follow the rows without polling.
  useEffect(() => {
    void refreshCounts();
    return window.electronAPI.onAnalyticsChanged?.(() => void refreshCounts());
  }, [refreshCounts]);

  const enableInsightsSync = useCallback(() => {
    if (!syncAllowedByPolicy) return;
    void (async () => {
      const { unclaimed, awaitingUpload } = await refreshCounts();
      // Already on: the pre-sign-in rows are the only thing still unanswered.
      if (insightsSyncEnabled) {
        if (unclaimed > 0) setPromptKind("claim");
        else await activate(false);
        return;
      }
      // Turning it on: ask about everything the first pass would send, not
      // just the pre-sign-in slice. Nothing queued means nothing to disclose.
      if (awaitingUpload > 0) setPromptKind("enable");
      else await activate(false);
    })();
  }, [activate, insightsSyncEnabled, refreshCounts, syncAllowedByPolicy]);

  const claiming = promptKind === "claim";
  const optInDialog = (
    <ConfirmDialog
      open={promptKind !== null}
      onOpenChange={(open) => {
        if (!open) setPromptKind(null);
      }}
      title={t(claiming ? "insights.claimTitle" : "insights.enableTitle")}
      description={t(claiming ? "insights.claimDescription" : "insights.enableDescription", {
        count: claiming ? unclaimedCount : awaitingUploadCount,
      })}
      confirmText={t(claiming ? "insights.claimInclude" : "insights.enableConfirm")}
      cancelText={t("insights.claimSkip")}
      onConfirm={() => void activate(true)}
    />
  );

  return {
    canToggleSync,
    disableInsightsSync,
    enableInsightsSync,
    optInDialog,
    participationEnabled,
    participationError,
    participationReady,
    participationUpdating,
    syncAllowedByPolicy,
    unclaimedCount,
  };
}
