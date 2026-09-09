import { Check, Loader2, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardRequestJoinPreview({
  className,
  memberCount,
  onRequest,
  pending,
  requesting,
  workspaceName,
}: {
  className?: string;
  memberCount: number;
  onRequest: () => void;
  pending: boolean;
  requesting: boolean;
  workspaceName: string;
}) {
  const { t } = useTranslation();
  return (
    <LeaderboardPreview
      actionDisabled={pending || requesting}
      actionIcon={pending ? Check : requesting ? Loader2 : Send}
      actionIconClassName={requesting ? "animate-spin" : undefined}
      actionLabel={
        pending
          ? t("insights.leaderboard.requestSent")
          : requesting
            ? t("insights.leaderboard.requesting")
            : t("insights.leaderboard.requestJoinCta")
      }
      badge={workspaceName}
      className={className}
      dataState="request_join"
      description={t("insights.leaderboard.requestJoinDescription", {
        count: memberCount,
        workspace: workspaceName,
      })}
      icon={Send}
      onAction={onRequest}
      title={t("insights.leaderboard.requestJoinTitle")}
    />
  );
}
