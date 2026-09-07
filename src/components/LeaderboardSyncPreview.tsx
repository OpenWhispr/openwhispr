import { CloudUpload, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardSyncPreview({
  canEnable,
  error,
  onEnable,
  scopeName,
  updating,
}: {
  canEnable: boolean;
  error: boolean;
  onEnable: () => void;
  scopeName: string;
  updating: boolean;
}) {
  const { t } = useTranslation();
  return (
    <LeaderboardPreview
      actionDisabled={!canEnable || updating}
      actionIcon={updating ? Loader2 : CloudUpload}
      actionIconClassName={updating ? "animate-spin" : undefined}
      actionLabel={
        updating ? t("insights.leaderboard.enablingSync") : t("insights.leaderboard.enableSyncCta")
      }
      badge={scopeName}
      className="mt-8"
      dataState="sync"
      description={t("insights.leaderboard.syncDescription")}
      helperText={
        error
          ? t("insights.leaderboard.activationError")
          : !canEnable
            ? t("insights.leaderboard.syncPolicyBlocked")
            : undefined
      }
      icon={CloudUpload}
      onAction={onEnable}
      title={t("insights.leaderboard.syncTitle", { scope: scopeName })}
    />
  );
}
