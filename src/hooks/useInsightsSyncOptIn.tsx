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
import { canChangeCloudBackupPreference, isCloudBackupAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { syncService } from "../services/SyncService.js";
import type { AnalyticsSyncContext } from "../types/electron";
import { useAuth } from "./useAuth";
import { useSettings } from "./useSettings";

/**
 * Single owner of the Insights Sync opt-in, shared by Settings and the Insights
 * page. Dictations recorded before signing in stay
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
 * account-scope bootstrap can leave new rows unattributed even after the
 * setting was enabled. It is what canOfferAnalyticsClaim uses to keep offering
 * this prompt.
 *
 * Leaderboard participation is separate account-level consent. Enabling or
 * disabling this device's Insights Sync never publishes or removes that account.
 */
export interface EnableInsightsSyncOptions {
  /** Join must obtain explicit Sync consent even when no rows are queued yet. */
  confirmWhenEmpty?: boolean;
}

export function useInsightsSyncOptIn() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { insightsSyncEnabled, setInsightsSyncEnabled } = useSettings();
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [awaitingUploadCount, setAwaitingUploadCount] = useState(0);
  const consentOwnerRef = useRef({});
  // Separate from the counts: a live count must never be what holds the dialog
  // open, or it reopens itself on mount for anyone with rows left behind.
  // "enable" asks about everything the first pass would upload; "claim" is the
  // narrower question that is left once sync is already on.
  const [promptKind, setPromptKind] = useState<"enable" | "claim" | null>(null);
  const promptAccountIdRef = useRef(userId);
  const syncAllowedByPolicy = usePolicyStore(isCloudBackupAllowed);
  const canToggleSync = canChangeCloudBackupPreference(syncAllowedByPolicy, insightsSyncEnabled);

  const reportActivationFailure = useCallback(
    (error: unknown) => {
      console.error("Enabling Insights Sync failed:", error);
      toast({ title: t("insights.syncEnableError"), variant: "destructive" });
    },
    [t, toast]
  );

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
      setInsightsSyncEnabled(true);
      syncService.requestSyncAll("manual");
      return true;
    },
    [reportActivationFailure, setInsightsSyncEnabled]
  );

  const disableInsightsSync = useCallback(() => {
    setInsightsSyncEnabled(false);
  }, [setInsightsSyncEnabled]);

  const refreshCounts = useCallback(async (context?: AnalyticsSyncContext) => {
    const [unclaimed, awaitingUpload] = await Promise.all([
      window.electronAPI.countUnclaimedAnalyticsEvents(context),
      window.electronAPI.countAnalyticsEventsAwaitingUpload(context),
    ]);
    setUnclaimedCount(unclaimed);
    setAwaitingUploadCount(awaitingUpload);
    return { unclaimed, awaitingUpload };
  }, []);

  // Every claim, purge and new dictation broadcasts analytics-changed, so the
  // counts follow the rows without polling.
  useEffect(() => {
    const refresh = () => {
      void refreshCounts().catch((error) => {
        console.error("Reading Insights Sync counts failed:", error);
      });
    };
    refresh();
    return window.electronAPI.onAnalyticsChanged?.(refresh);
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

  const enableInsightsSync = useCallback(
    async (options: EnableInsightsSyncOptions = {}) => {
      if (!syncAllowedByPolicy) return false;
      const requestedAccountId = userId;
      const requestedAuthGeneration = getValidatedAuthGeneration();
      if (!requestedAccountId || requestedAuthGeneration == null) return false;
      let counts: { unclaimed: number; awaitingUpload: number };
      try {
        counts = await refreshCounts({
          accountId: requestedAccountId,
          authGeneration: requestedAuthGeneration,
        });
      } catch (error) {
        reportActivationFailure(error);
        return false;
      }
      const { unclaimed, awaitingUpload } = counts;
      if (
        promptAccountIdRef.current !== requestedAccountId ||
        getValidatedAuthGeneration() !== requestedAuthGeneration
      )
        return false;
      // Already on: the pre-sign-in rows are the only thing still unanswered.
      // Turning it on: ask about everything the first pass would send, not just
      // the pre-sign-in slice. Nothing queued means there is nothing to claim.
      const pending = insightsSyncEnabled ? unclaimed : awaitingUpload;
      if (pending === 0 && !options.confirmWhenEmpty) {
        return prepareInsightsSync(false, requestedAccountId, requestedAuthGeneration);
      }
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
    },
    [
      insightsSyncEnabled,
      prepareInsightsSync,
      refreshCounts,
      reportActivationFailure,
      syncAllowedByPolicy,
      userId,
    ]
  );

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
      title={t(claiming ? "insights.claimTitle" : "insights.enableTitle")}
      description={t(
        promptCount === 0
          ? "insights.syncPrompt"
          : claiming
            ? "insights.claimDescription"
            : "insights.enableDescription",
        { count: promptCount }
      )}
      confirmText={t(claiming ? "insights.claimInclude" : "insights.enableConfirm")}
      cancelText={t("insights.claimSkip")}
      onConfirm={() => answerClaimPrompt(true)}
    />
  );

  return {
    canToggleSync,
    disableInsightsSync,
    enableInsightsSync,
    optInDialog,
    syncAllowedByPolicy,
    unclaimedCount,
  };
}
