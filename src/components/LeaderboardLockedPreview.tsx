import { LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardLockedPreview({
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
      className={className}
      description={t("insights.leaderboard.unavailableDescription")}
      icon={LockKeyhole}
      onAction={onUpgrade}
      title={t("insights.leaderboard.lockedTitle")}
      variant="locked"
    />
  );
}
