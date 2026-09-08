import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useSettings } from "../hooks/useSettings";
import { signInWithSSO } from "../lib/auth";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import LeaderboardSection from "./LeaderboardSection";

interface LeaderboardViewProps {
  onSignIn: () => void;
  onInvite: () => void;
}

export default function LeaderboardView({ onSignIn, onInvite }: LeaderboardViewProps) {
  const { t } = useTranslation();
  const { isSignedIn, user } = useAuth();
  const authGeneration = getValidatedAuthGeneration();
  const [oauthProtocolRegistered, setOauthProtocolRegistered] = useState<boolean | null>(null);
  const [ssoStarting, setSsoStarting] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const { dataRetentionEnabled: personalDataRetentionEnabled, insightsSyncEnabled } = useSettings();
  const dataRetentionEnabled = usePolicyStore((policyState) =>
    effectiveLocalHistoryEnabled(policyState, personalDataRetentionEnabled)
  );
  const {
    joinLeaderboard,
    leaveLeaderboard,
    optInDialog,
    participationEnabled,
    participationError,
    participationReady,
    participationUpdating,
    refreshParticipation,
    syncAllowedByPolicy,
  } = useInsightsSyncOptIn();

  // The leaderboard is the only surface that needs the account preference, so
  // it is the only one that pays for reading it. The device sync switch is not
  // a gate here, but flipping it off elsewhere leaves the account too, so it is
  // the signal to re-read rather than keep showing a roster nobody is in.
  useEffect(() => {
    void refreshParticipation();
  }, [insightsSyncEnabled, refreshParticipation]);

  useEffect(() => {
    window.electronAPI
      ?.getOAuthProtocolRegistered?.()
      .then(setOauthProtocolRegistered)
      .catch(() => setOauthProtocolRegistered(false));
  }, []);

  // A successful browser callback rotates the validated credential. That both
  // releases the launch guard and gives LeaderboardSection a reason to retry
  // the request that returned SSO_REQUIRED.
  useEffect(() => {
    setSsoStarting(false);
    setSsoError(null);
  }, [authGeneration]);

  // Browser auth may end without a callback when the user closes or cancels
  // the flow. Release the launch guard after focus returns so they can retry.
  useEffect(() => {
    if (!ssoStarting) return;

    let timeout: ReturnType<typeof setTimeout>;
    const handleFocus = () => {
      timeout = setTimeout(() => setSsoStarting(false), 1000);
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      clearTimeout(timeout);
    };
  }, [ssoStarting]);

  const startSsoSignIn = useCallback(async () => {
    const email = user?.email;
    if (!email) {
      onSignIn();
      return;
    }
    if (oauthProtocolRegistered !== true || ssoStarting) return;
    setSsoStarting(true);
    setSsoError(null);
    const { error } = await signInWithSSO(email);
    if (!error) return;
    console.error("Starting leaderboard SSO sign-in failed:", error);
    setSsoError(t("auth.sso.failed"));
    setSsoStarting(false);
  }, [oauthProtocolRegistered, onSignIn, ssoStarting, t, user?.email]);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header>
        <h1 className="text-base! font-semibold! leading-none! tracking-normal! text-foreground">
          {t("insights.leaderboard.title")}
        </h1>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("insights.leaderboard.description")}
        </p>
      </header>

      <LeaderboardSection
        key={user?.id ?? "guest"}
        accountId={user?.id ?? null}
        authGeneration={authGeneration}
        isSignedIn={isSignedIn}
        participating={isSignedIn && participationEnabled}
        cloudAccessAllowed={syncAllowedByPolicy}
        canJoin={
          isSignedIn && syncAllowedByPolicy && dataRetentionEnabled && !participationUpdating
        }
        participationReady={participationReady}
        participationError={participationError}
        participationUpdating={participationUpdating}
        onJoin={() => void joinLeaderboard()}
        onLeave={leaveLeaderboard}
        onRefreshParticipation={refreshParticipation}
        onSignIn={onSignIn}
        onSsoSignIn={() => void startSsoSignIn()}
        ssoActionDisabled={ssoStarting || oauthProtocolRegistered !== true}
        ssoRecoveryError={
          oauthProtocolRegistered === false ? t("auth.social.protocolUnavailable") : ssoError
        }
        ssoStarting={ssoStarting}
        onInvite={onInvite}
      />

      {optInDialog}
    </div>
  );
}
