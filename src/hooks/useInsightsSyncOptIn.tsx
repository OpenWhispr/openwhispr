import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/dialog";
import { useToast } from "../components/ui/useToast";
import {
  answerInsightsConsent,
  cancelInsightsConsent,
  requestInsightsConsent,
} from "../helpers/insightsConsentCoordinator";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { writePendingLeaderboardLeave } from "../lib/pendingLeaderboardLeave";
import { useLeaderboardParticipationStore } from "../stores/leaderboardParticipationStore";
import { canChangeCloudBackupPreference, isCloudBackupAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { syncService } from "../services/SyncService.js";
import { useAuth } from "./useAuth";
import { useSettings } from "./useSettings";

/**
 * Single owner of the Insights and Leaderboards opt-in, shared by Settings and
 * the Insights page. Dictations recorded before signing in stay
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
 * Joining publishes a name and email to teammates, so the combined action waits
 * for the analytics consent to land before it enables participation. Declining
 * that prompt declines both parts of the opt-in.
 *
 * Leaving is the opposite combined action: sync stops on the device before the
 * account request, and a failed leaderboard leave is retried until it lands.
 * A confirmed server-side leave also turns off local sync, so the two states do
 * not drift when participation changes outside the current surface.
 *
 * Participation itself lives in leaderboardParticipationStore rather than here:
 * Settings and the Insights page can both mount this hook, and an opt-out taken
 * in one has to reach the other.
 */
export function useInsightsSyncOptIn() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isLoaded, isSignedIn, user } = useAuth();
  const userId = user?.id ?? null;
  const { insightsSyncEnabled, setInsightsSyncEnabled } = useSettings();
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [awaitingUploadCount, setAwaitingUploadCount] = useState(0);
  const participationReady = useLeaderboardParticipationStore((state) => state.ready);
  const participationEnabled = useLeaderboardParticipationStore((state) => state.enabled);
  const participationConfigured = useLeaderboardParticipationStore((state) => state.configured);
  const participationError = useLeaderboardParticipationStore((state) => state.error);
  const participationUpdating = useLeaderboardParticipationStore((state) => state.updating);
  const consentOwnerRef = useRef({});
  // Separate from the counts: a live count must never be what holds the dialog
  // open, or it reopens itself on mount for anyone with rows left behind.
  // "enable" asks about everything the first pass would upload; "claim" is the
  // narrower question that is left once sync is already on.
  const [promptKind, setPromptKind] = useState<"enable" | "claim" | null>(null);
  const promptAccountIdRef = useRef(userId);
  const syncAllowedByPolicy = usePolicyStore(isCloudBackupAllowed);
  const canToggleSync =
    canChangeCloudBackupPreference(syncAllowedByPolicy, insightsSyncEnabled) &&
    !participationUpdating;

  const reportActivationFailure = useCallback(
    (error: unknown) => {
      console.error("Claiming earlier Insights events failed:", error);
      toast({ title: t("insights.syncEnableError"), variant: "destructive" });
    },
    [t, toast]
  );

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

  // Every surface that exposes the combined preference must reconcile its
  // account half. Keeping this in the shared hook prevents Settings from
  // showing a stale local-only value when the account left elsewhere.
  useEffect(() => {
    void refreshParticipation();
  }, [insightsSyncEnabled, refreshParticipation]);

  // Participation can change on another surface or client. False wins because
  // enabling local uploads without leaderboard participation recreates the
  // split state this combined preference is meant to prevent.
  useEffect(() => {
    if (
      !insightsSyncEnabled ||
      !participationReady ||
      !participationConfigured ||
      participationEnabled ||
      participationError !== null ||
      participationUpdating
    )
      return;
    setInsightsSyncEnabled(false);
  }, [
    insightsSyncEnabled,
    participationConfigured,
    participationEnabled,
    participationError,
    participationReady,
    participationUpdating,
    setInsightsSyncEnabled,
  ]);

  // The claim lands before the pass is requested so the rows it adopts go up
  // with it, rather than waiting for the next ambient one.
  const prepareInsightsSync = useCallback(
    async (claimAnonymous: boolean, expectedAccountId: string, expectedAuthGeneration: number) => {
      if (claimAnonymous) {
        try {
          const result = await window.electronAPI.claimAnonymousAnalyticsEvents(
            expectedAccountId,
            expectedAuthGeneration
          );
          if (!result.success) {
            reportActivationFailure(result.code ?? "The local account scope changed");
            return false;
          }
        } catch (error) {
          reportActivationFailure(error);
          return false;
        }
      }
      if (
        promptAccountIdRef.current !== expectedAccountId ||
        getValidatedAuthGeneration() !== expectedAuthGeneration
      )
        return false;
      return true;
    },
    [reportActivationFailure]
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

  // Consent belongs to the account that opened the prompt. If auth changes
  // while it is open, settle that account's request as declined and close it;
  // otherwise accepting the stale dialog could publish the replacement account.
  useEffect(() => {
    if (promptAccountIdRef.current === userId) return;
    promptAccountIdRef.current = userId;
    cancelInsightsConsent(consentOwnerRef.current);
  }, [userId]);

  useEffect(() => {
    const owner = consentOwnerRef.current;
    // Unmount removes the dialog itself; only settle callers still awaiting it.
    return () => cancelInsightsConsent(owner, false);
  }, []);

  // Resolves once the upload consent has settled, so the combined action can
  // wait for the user's answer before it publishes participation.
  const confirmInsightsSync = useCallback(async () => {
    if (!syncAllowedByPolicy) return false;
    const requestedAccountId = userId;
    const requestedAuthGeneration = getValidatedAuthGeneration();
    if (!requestedAccountId || requestedAuthGeneration == null) return false;
    const { unclaimed, awaitingUpload } = await refreshCounts();
    if (
      promptAccountIdRef.current !== requestedAccountId ||
      getValidatedAuthGeneration() !== requestedAuthGeneration
    )
      return false;
    // Already on: the pre-sign-in rows are the only thing still unanswered.
    // Turning it on: ask about everything the first pass would send, not just
    // the pre-sign-in slice. Even with nothing queued, joining publishes the
    // account profile and therefore still needs an explicit confirmation.
    const pending = insightsSyncEnabled ? unclaimed : awaitingUpload;
    const accepted = await requestInsightsConsent({
      accountId: requestedAccountId,
      authGeneration: requestedAuthGeneration,
      kind: insightsSyncEnabled ? "claim" : "enable",
      owner: consentOwnerRef.current,
      open: setPromptKind,
      close: () => setPromptKind(null),
    });
    if (!accepted) return false;
    return prepareInsightsSync(pending > 0, requestedAccountId, requestedAuthGeneration);
  }, [insightsSyncEnabled, prepareInsightsSync, refreshCounts, syncAllowedByPolicy, userId]);

  // The product exposes one enable action for Insights and Leaderboards. The
  // analytics consent must land before the account is published. Sync turns on
  // only after that write succeeds, so a refused join cannot leave half of the
  // combined preference enabled.
  const joinLeaderboard = useCallback(async () => {
    if (!syncAllowedByPolicy) return false;
    const requestedAccountId = userId;
    const requestedAuthGeneration = getValidatedAuthGeneration();
    if (!requestedAccountId || requestedAuthGeneration == null) return false;
    if (!(await confirmInsightsSync())) return false;
    if (
      promptAccountIdRef.current !== requestedAccountId ||
      getValidatedAuthGeneration() !== requestedAuthGeneration
    )
      return false;
    const joined = await useLeaderboardParticipationStore.getState().join(requestedAccountId);
    if (!joined) {
      // A stale account's fenced request must not change the replacement
      // account's device preference or show its failure in the new session.
      if (
        promptAccountIdRef.current === requestedAccountId &&
        getValidatedAuthGeneration() === requestedAuthGeneration
      ) {
        setInsightsSyncEnabled(false);
        toast({
          title: t("insights.leaderboard.activationError"),
          variant: "destructive",
        });
      }
      return false;
    }
    if (
      promptAccountIdRef.current !== requestedAccountId ||
      getValidatedAuthGeneration() !== requestedAuthGeneration
    ) {
      // The join response landed, but its consenting account is no longer the
      // active auth context. Do not issue a leave with somebody else's token;
      // retain the compensating opt-out for this account's next valid pass.
      writePendingLeaderboardLeave(requestedAccountId);
      return false;
    }
    setInsightsSyncEnabled(true);
    syncService.requestSyncAll("manual");
    return true;
  }, [confirmInsightsSync, setInsightsSyncEnabled, syncAllowedByPolicy, t, toast, userId]);

  const claiming = promptKind === "claim";
  const promptCount = claiming ? unclaimedCount : awaitingUploadCount;
  const answerClaimPrompt = (claimed: boolean) => {
    answerInsightsConsent(consentOwnerRef.current, claimed);
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
      title={t("insights.syncAndJoinTitle")}
      description={`${t(
        promptCount === 0
          ? "insights.syncAndJoinEmptyDescription"
          : claiming
            ? "insights.claimDescription"
            : "insights.enableDescription",
        { count: promptCount }
      )} ${t("insights.syncAndJoinDisclosure")}`}
      confirmText={t("insights.syncAndJoinConfirm")}
      cancelText={t("insights.claimSkip")}
      onConfirm={() => answerClaimPrompt(true)}
    />
  );

  return {
    canToggleSync,
    disableInsightsSync,
    joinLeaderboard,
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
