import { Check, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardRequestJoinPreview({
  className,
  onRequest,
  pending,
  requesting,
  workspaceName,
}: {
  className?: string;
  onRequest: () => void;
  pending: boolean;
  requesting: boolean;
  workspaceName: string;
}) {
  const { t } = useTranslation();
  return (
    <LeaderboardPreview
      actionDisabled={pending || requesting}
      actionIcon={pending ? Check : Send}
      actionLabel={
        pending
          ? t("insights.leaderboard.requestSent")
          : requesting
            ? t("insights.leaderboard.requesting")
            : t("insights.leaderboard.requestJoinCta")
      }
      badge={workspaceName}
      className={className}
      description={t("insights.leaderboard.requestJoinDescription", {
        workspace: workspaceName,
      })}
      icon={Send}
      onAction={onRequest}
      title={t("insights.leaderboard.requestJoinTitle")}
      variant="locked"
    />
  );
}
