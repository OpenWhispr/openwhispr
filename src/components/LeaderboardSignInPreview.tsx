import { LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import LeaderboardPreview from "./LeaderboardPreview";

export default function LeaderboardSignInPreview({
  className,
  onSignIn,
}: {
  className?: string;
  onSignIn: () => void;
}) {
  const { t } = useTranslation();

  return (
    <LeaderboardPreview
      actionIcon={LogIn}
      actionLabel={t("auth.passwordForm.signInLink")}
      className={className}
      description={t("insights.leaderboard.signInDescription")}
      icon={LogIn}
      onAction={onSignIn}
      title={t("insights.leaderboard.signInTitle")}
    />
  );
}
