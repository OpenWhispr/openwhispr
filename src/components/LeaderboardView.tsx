import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { useSettings } from "../hooks/useSettings";
import { signInWithSSO } from "../lib/auth";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import LeaderboardSection from "./LeaderboardSection";

interface LeaderboardViewProps {
  disableInsightsSync: () => Promise<boolean>;
  onSignIn: () => void;
  onInvite: () => void;
  participationEnabled: boolean;
  participationError: "read" | "write" | null;
  participationReady: boolean;
  participationUpdating: boolean;
  refreshParticipation: () => Promise<void>;
  syncAllowedByPolicy: boolean;
}

export default function LeaderboardView({
  disableInsightsSync,
  onSignIn,
  onInvite,
  participationEnabled,
  participationError,
  participationReady,
  participationUpdating,
  refreshParticipation,
  syncAllowedByPolicy,
}: LeaderboardViewProps) {
  const { t } = useTranslation();
  const { isSignedIn, user } = useAuth();
  const authGeneration = getValidatedAuthGeneration();
  const [oauthProtocolRegistered, setOauthProtocolRegistered] = useState<boolean | null>(null);
  const [ssoStarting, setSsoStarting] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const { dataRetentionEnabled: personalDataRetentionEnabled } = useSettings();
  const dataRetentionEnabled = usePolicyStore((policyState) =>
    effectiveLocalHistoryEnabled(policyState, personalDataRetentionEnabled)
  );
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
    <>
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
        onLeave={disableInsightsSync}
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
    </>
  );
}
