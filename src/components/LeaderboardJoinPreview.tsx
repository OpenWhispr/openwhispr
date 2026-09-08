import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardJoinPreview({
  canJoin,
  error,
  onJoin,
  scopeName,
  updating,
}: {
  canJoin: boolean;
  error: boolean;
  onJoin: () => Promise<boolean>;
  scopeName: string;
  updating: boolean;
}) {
  const { t } = useTranslation();
  return (
    <LeaderboardPreview
      actionDisabled={!canJoin || updating}
      actionLabel={t(
        updating ? "insights.leaderboard.joiningLeaderboard" : "insights.leaderboard.joinCta"
      )}
      badge={scopeName}
      className="mt-8"
      dataState="join"
      description={t("insights.leaderboard.joinDescription")}
      helperText={
        error
          ? t("insights.leaderboard.activationError")
          : !canJoin
            ? t("insights.leaderboard.joinPolicyBlocked")
            : undefined
      }
      icon={UserPlus}
      onAction={() => void onJoin()}
      title={t("insights.leaderboard.joinTitle", { scope: scopeName })}
    />
  );
}
