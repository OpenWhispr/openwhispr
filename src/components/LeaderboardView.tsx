import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useSettings } from "../hooks/useSettings";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import LeaderboardSection from "./LeaderboardSection";

interface LeaderboardViewProps {
  onUpgrade: () => void;
}

export default function LeaderboardView({ onUpgrade }: LeaderboardViewProps) {
  const { t } = useTranslation();
  const { isSignedIn, user } = useAuth();
  const { dataRetentionEnabled: personalDataRetentionEnabled, insightsSyncEnabled } = useSettings();
  const dataRetentionEnabled = usePolicyStore((policyState) =>
    effectiveLocalHistoryEnabled(policyState, personalDataRetentionEnabled)
  );
  const {
    enableInsightsSync,
    optInDialog,
    participationEnabled,
    participationError,
    participationReady,
    participationUpdating,
    syncAllowedByPolicy,
  } = useInsightsSyncOptIn();

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
        syncCanBeEnabled={
          isSignedIn && syncAllowedByPolicy && dataRetentionEnabled && !participationUpdating
        }
        participationReady={participationReady}
        participationError={participationError}
        onEnableSync={enableInsightsSync}
        onUpgrade={onUpgrade}
      />

      {optInDialog}
    </div>
  );
}
