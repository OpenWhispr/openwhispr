import { LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardFreePreview({
  className,
  onUpgrade,
}: {
  className?: string;
  onUpgrade: () => void;
}) {
  const { t } = useTranslation();

  return (
    <LeaderboardPreview
      actionLabel={t("upgradePrompt.upgradeToPro")}
      badge={t("insights.leaderboard.freeAccount")}
      className={className}
      description={t("insights.leaderboard.unavailableDescription")}
      icon={LockKeyhole}
      onAction={onUpgrade}
      title={t("insights.leaderboard.lockedTitle")}
    />
  );
}
