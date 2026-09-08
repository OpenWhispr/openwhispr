import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardAcceptInvitePreview({
  className,
  inviterName,
  joining,
  onAccept,
  workspaceName,
}: {
  className?: string;
  inviterName: string | null;
  joining: boolean;
  onAccept: () => void;
  workspaceName: string;
}) {
  const { t } = useTranslation();

  return (
    <LeaderboardPreview
      actionDisabled={joining}
      actionIcon={joining ? Loader2 : Check}
      actionIconClassName={joining ? "animate-spin" : undefined}
      actionLabel={
        joining ? t("insights.leaderboard.joining") : t("insights.leaderboard.acceptInviteCta")
      }
      badge={workspaceName}
      className={className}
      dataState="accept_invite"
      description={
        inviterName
          ? t("insights.leaderboard.acceptInviteDescription", {
              inviter: inviterName,
              workspace: workspaceName,
            })
          : t("insights.leaderboard.acceptInviteDescriptionNoInviter", {
              workspace: workspaceName,
            })
      }
      icon={Check}
      onAction={onAccept}
      title={t("insights.leaderboard.acceptInviteTitle", { workspace: workspaceName })}
    />
  );
}
