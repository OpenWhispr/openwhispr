import { UserPlus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardCreateTeamPreview({
  className,
  domain,
  onCreate,
}: {
  className?: string;
  domain: string;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <LeaderboardPreview
      actionIcon={UserPlus}
      actionLabel={t("insights.leaderboard.createTeamCta")}
      badge={domain}
      className={className}
      description={t("insights.leaderboard.createTeamDescription", { domain })}
      icon={Users}
      onAction={onCreate}
      title={t("insights.leaderboard.createTeamTitle")}
      variant="locked"
    />
  );
}
