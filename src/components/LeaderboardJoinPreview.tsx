import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardJoinPreview({
  canJoin,
  error,
  leavePending,
  onJoin,
  scopeName,
  updating,
}: {
  canJoin: boolean;
  error: boolean;
  /** The account is still being taken off the boards this device left. */
  leavePending: boolean;
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
      className="mt-6"
      dataState="join"
      description={t("insights.leaderboard.joinDescription")}
      helperText={
        error
          ? t("insights.leaderboard.activationError")
          : leavePending
            ? t("insights.leaderboard.leavePending")
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
