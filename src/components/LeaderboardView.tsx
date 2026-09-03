import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useSettings } from "../hooks/useSettings";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import LeaderboardSection from "./LeaderboardSection";

interface LeaderboardViewProps {
  onSignIn: () => void;
  onUpgrade: () => void;
}

export default function LeaderboardView({ onSignIn, onUpgrade }: LeaderboardViewProps) {
  const { t } = useTranslation();
  const { isSignedIn, user } = useAuth();
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
  // it is the only one that pays for reading it.
  useEffect(() => {
    void refreshParticipation();
  }, [refreshParticipation]);

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
        isSignedIn={isSignedIn}
        syncActive={
          isSignedIn && insightsSyncEnabled && syncAllowedByPolicy && participationEnabled
        }
        canJoin={
          isSignedIn && syncAllowedByPolicy && dataRetentionEnabled && !participationUpdating
        }
        participationReady={participationReady}
        participationError={participationError}
        participationUpdating={participationUpdating}
        onJoin={() => void joinLeaderboard()}
        onLeave={() => void leaveLeaderboard()}
        onParticipationStale={refreshParticipation}
        onSignIn={onSignIn}
        onUpgrade={onUpgrade}
      />

      {optInDialog}
    </div>
  );
}
