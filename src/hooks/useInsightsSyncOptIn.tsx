import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/dialog";
import { useLeaderboardParticipationStore } from "../stores/leaderboardParticipationStore";
import { canChangeCloudBackupPreference, isCloudBackupAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { syncService } from "../services/SyncService.js";
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
 * turns it on, and it waits for the sync opt-in to actually land first, because
 * a claim prompt the user declines is a join the user never agreed to.
 *
 * Leaving is the opposite: it holds on the device the moment it is asked for
 * and is retried against the account until it lands, so an opt-out is never
 * lost to a network that happened to be down.
 *
 * Participation itself lives in leaderboardParticipationStore rather than here:
 * Settings and the leaderboard both mount this hook, and an opt-out taken in
 * one has to reach the other.
 */
export function useInsightsSyncOptIn() {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn, user } = useAuth();
  const userId = user?.id ?? null;
  const { insightsSyncEnabled, setInsightsSyncEnabled } = useSettings();
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [awaitingUploadCount, setAwaitingUploadCount] = useState(0);
  const participationReady = useLeaderboardParticipationStore((state) => state.ready);
  const participationEnabled = useLeaderboardParticipationStore((state) => state.enabled);
  const participationError = useLeaderboardParticipationStore((state) => state.error);
  const participationUpdating = useLeaderboardParticipationStore((state) => state.updating);
  // Settles when the claim prompt is answered, so an opt-in that opens it can
  // wait for the answer instead of racing ahead of the user.
  const claimAnswerRef = useRef<((claimed: boolean) => void) | null>(null);
  // Separate from the counts: a live count must never be what holds the dialog
  // open, or it reopens itself on mount for anyone with rows left behind.
  // "enable" asks about everything the first pass would upload; "claim" is the
  // narrower question that is left once sync is already on.
  const [promptKind, setPromptKind] = useState<"enable" | "claim" | null>(null);
  const syncAllowedByPolicy = usePolicyStore(isCloudBackupAllowed);
  const canToggleSync =
    canChangeCloudBackupPreference(syncAllowedByPolicy, insightsSyncEnabled) &&
    !participationUpdating;

  // Signed out there is no account to read, so the store goes back to unknown
  // rather than keeping the previous user's answer.
  const refreshParticipation = useCallback(async () => {
    const { refresh, reset } = useLeaderboardParticipationStore.getState();
    if (!isLoaded || !isSignedIn) {
      reset();
      return;
    }
    await refresh(userId);
  }, [isLoaded, isSignedIn, userId]);

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

  const leaveLeaderboard = useCallback(
    () => useLeaderboardParticipationStore.getState().leave(userId),
    [userId]
  );

  const disableInsightsSync = useCallback(async () => {
    // The device stops uploading straight away: an opt-out that waits on the
    // network is an opt-out the user loses whenever the network is down.
    setInsightsSyncEnabled(false);
    // Signed out there is no account row to clear, and the call could only fail
    // for want of a credential.
    if (!isSignedIn) return true;
    return leaveLeaderboard();
  }, [isSignedIn, leaveLeaderboard, setInsightsSyncEnabled]);

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

  // Resolves once the opt-in has settled, so a caller that needs sync on before
  // it acts can wait for the user's answer rather than assume it.
  const enableInsightsSync = useCallback(async () => {
    if (!syncAllowedByPolicy) return false;
    const { unclaimed, awaitingUpload } = await refreshCounts();
    // Already on: the pre-sign-in rows are the only thing still unanswered.
    // Turning it on: ask about everything the first pass would send, not just
    // the pre-sign-in slice. Nothing queued means nothing to disclose.
    const pending = insightsSyncEnabled ? unclaimed : awaitingUpload;
    if (pending === 0) {
      await activate(false);
      return true;
    }
    const claimed = await new Promise<boolean>((resolve) => {
      claimAnswerRef.current = resolve;
      setPromptKind(insightsSyncEnabled ? "claim" : "enable");
    });
    if (claimed) await activate(true);
    return claimed;
  }, [activate, insightsSyncEnabled, refreshCounts, syncAllowedByPolicy]);

  // Joining publishes the account, and the counters it ranks still have to
  // reach the server — so the sync opt-in has to land first. Declining it
  // declines the join too, rather than leaving the account on a leaderboard it
  // never feeds.
  const joinLeaderboard = useCallback(async () => {
    if (!syncAllowedByPolicy) return;
    if (!insightsSyncEnabled && !(await enableInsightsSync())) return;
    await useLeaderboardParticipationStore.getState().join(userId);
  }, [enableInsightsSync, insightsSyncEnabled, syncAllowedByPolicy, userId]);

  const claiming = promptKind === "claim";
  const answerClaimPrompt = (claimed: boolean) => {
    claimAnswerRef.current?.(claimed);
    claimAnswerRef.current = null;
  };

  const optInDialog = (
    <ConfirmDialog
      open={promptKind !== null}
      onOpenChange={(open) => {
        if (open) return;
        setPromptKind(null);
        // Also covers Esc and the overlay: a dismissed prompt is a declined one.
        answerClaimPrompt(false);
      }}
      title={t(claiming ? "insights.claimTitle" : "insights.enableTitle")}
      description={t(claiming ? "insights.claimDescription" : "insights.enableDescription", {
        count: claiming ? unclaimedCount : awaitingUploadCount,
      })}
      confirmText={t(claiming ? "insights.claimInclude" : "insights.enableConfirm")}
      cancelText={t("insights.claimSkip")}
      onConfirm={() => answerClaimPrompt(true)}
    />
  );

  return {
    canToggleSync,
    disableInsightsSync,
    enableInsightsSync,
    joinLeaderboard,
    leaveLeaderboard,
    optInDialog,
    participationEnabled,
    participationError,
    participationReady,
    participationUpdating,
    refreshParticipation,
    syncAllowedByPolicy,
    unclaimedCount,
  };
}
