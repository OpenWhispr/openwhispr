import { Check, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardRequestJoinPreview({
  className,
  colleagueCount,
  domain,
  onRequest,
  pending,
  requesting,
  workspaceName,
}: {
  className?: string;
  colleagueCount: number;
  domain: string | null;
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
      dataState="request_join"
      description={t("insights.leaderboard.requestJoinDescription", {
        count: colleagueCount,
        domain: domain ?? workspaceName,
        workspace: workspaceName,
      })}
      icon={Send}
      onAction={onRequest}
      title={t("insights.leaderboard.requestJoinTitle")}
    />
  );
}
