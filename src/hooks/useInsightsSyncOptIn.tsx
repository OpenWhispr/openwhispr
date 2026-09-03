import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/dialog";
import { canChangeCloudBackupPreference, isCloudBackupAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { syncService } from "../services/SyncService.js";
import { LeaderboardService } from "../services/LeaderboardService";
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
 *
 * Leaderboard participation is a second, narrower consent — it publishes a name
 * and email to teammates — so syncing never implies it. Only joinLeaderboard
 * turns it on, and turning sync off takes it back down with it.
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
  const participationReadIdRef = useRef(0);
  // Separate from the counts: a live count must never be what holds the dialog
  // open, or it reopens itself on mount for anyone with rows left behind.
  // "enable" asks about everything the first pass would upload; "claim" is the
  // narrower question that is left once sync is already on.
  const [promptKind, setPromptKind] = useState<"enable" | "claim" | null>(null);
  const syncAllowedByPolicy = usePolicyStore(isCloudBackupAllowed);
  const canToggleSync =
    canChangeCloudBackupPreference(syncAllowedByPolicy, insightsSyncEnabled) &&
    !participationUpdating;

  // Read-only: the account preference is the one source of truth for who is on
  // a leaderboard, and nothing here may join or leave one on the user's behalf.
  useEffect(() => {
    const readId = ++participationReadIdRef.current;
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
        const participation = await LeaderboardService.getParticipation();
        if (readId !== participationReadIdRef.current) return;
        setParticipationEnabled(participation.enabled);
      } catch (error) {
        if (readId !== participationReadIdRef.current) return;
        console.error("Reading leaderboard participation failed:", error);
        setParticipationError(true);
      } finally {
        if (readId === participationReadIdRef.current) setParticipationReady(true);
      }
    })();
  }, [isLoaded, isSignedIn]);

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

  const disableInsightsSync = useCallback(async () => {
    // The device stops uploading straight away: an opt-out that waits on the
    // network is an opt-out the user loses whenever the network is down.
    setInsightsSyncEnabled(false);
    setParticipationUpdating(true);
    try {
      const participation = await LeaderboardService.setParticipation(false);
      setParticipationEnabled(participation.enabled);
      setParticipationError(false);
    } catch (error) {
      console.error("Leaving the leaderboard failed:", error);
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

  // Joining publishes the account; the counters it ranks still have to reach
  // the server, so a leaderboard opt-in turns the sync on when it is off.
  const joinLeaderboard = useCallback(async () => {
    if (!syncAllowedByPolicy) return;
    setParticipationUpdating(true);
    try {
      const participation = await LeaderboardService.setParticipation(true);
      setParticipationEnabled(participation.enabled);
      setParticipationError(false);
      if (!insightsSyncEnabled) enableInsightsSync();
    } catch (error) {
      console.error("Joining the leaderboard failed:", error);
      setParticipationError(true);
    } finally {
      setParticipationUpdating(false);
    }
  }, [enableInsightsSync, insightsSyncEnabled, syncAllowedByPolicy]);

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
    joinLeaderboard,
    optInDialog,
    participationEnabled,
    participationError,
    participationReady,
    participationUpdating,
    syncAllowedByPolicy,
    unclaimedCount,
  };
}
