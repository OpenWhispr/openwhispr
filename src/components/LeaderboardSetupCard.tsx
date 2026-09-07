import { UserPlus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";

export default function LeaderboardSetupCard({
  className,
  domain,
  onCreate,
}: {
  className?: string;
  domain: string | null;
  onCreate: () => void;
}) {
  const { t } = useTranslation();

  return (
    <section
      className={cn(
        "flex min-h-64 flex-col items-center justify-center rounded-2xl border border-border/50 bg-card/70 px-6 py-10 text-center dark:border-white/8",
        className
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Users size={20} />
      </div>
      <h2 className="mt-4 text-base font-semibold">{t("insights.leaderboard.setupTitle")}</h2>
      <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
        {domain
          ? t("insights.leaderboard.setupDomainDescription", { domain })
          : t("insights.leaderboard.setupDescription")}
      </p>
      <Button className="mt-5" onClick={onCreate}>
        <UserPlus size={14} />
        {t("insights.leaderboard.setupCta")}
      </Button>
    </section>
  );
}
