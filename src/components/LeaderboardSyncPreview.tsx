import { CloudUpload } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardSyncPreview({
  canEnable,
  error,
  scopeName,
}: {
  canEnable: boolean;
  error: boolean;
  scopeName: string;
}) {
  const { t } = useTranslation();
  return (
    <LeaderboardPreview
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
      title={t("insights.leaderboard.syncTitle", { scope: scopeName })}
    />
  );
}
