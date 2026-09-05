import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardInvitePreview({
  className,
  onInvite,
}: {
  className?: string;
  onInvite: () => void;
}) {
  const { t } = useTranslation();

  return (
    <LeaderboardPreview
      actionIcon={UserPlus}
      actionLabel={t("insights.leaderboard.inviteCta")}
      badge={t("insights.leaderboard.proAccount")}
      className={className}
      description={t("insights.leaderboard.inviteDescription")}
      icon={UserPlus}
      onAction={onInvite}
      title={t("insights.leaderboard.inviteTitle")}
    />
  );
}
