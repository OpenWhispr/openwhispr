import { useTranslation } from "react-i18next";
import { useUsageReturnCountdown } from "../hooks/useUsageReturnCountdown";
import { getUsagePercentage } from "../lib/usagePresentation";
import { cn } from "./lib/utils";
import { Progress } from "./ui/progress";

interface WeeklyUsageMeterProps {
  wordsUsed: number;
  limit: number;
  isOverLimit: boolean;
  nextWordsAvailableAt: number | null;
  onRefresh: () => Promise<void>;
}

export default function WeeklyUsageMeter({
  wordsUsed,
  limit,
  isOverLimit,
  nextWordsAvailableAt,
  onRefresh,
}: WeeklyUsageMeterProps) {
  const { t, i18n } = useTranslation();
  const percentage = getUsagePercentage(wordsUsed, limit);
  const countdown = useUsageReturnCountdown(nextWordsAvailableAt, onRefresh);

  if (percentage === null) return null;

  const timing = countdown
    ? t(`settingsPage.account.usageReturn.${countdown.unit}`, { count: countdown.count })
    : null;
  const usageLabel = t("settingsPage.account.planDescriptions.freeUsage", {
    used: wordsUsed.toLocaleString(i18n.language),
    limit: limit.toLocaleString(i18n.language),
  });

  return (
    <div className="mt-4 space-y-1.5">
      <Progress
        value={percentage}
        aria-label={usageLabel}
        aria-valuetext={usageLabel}
        className={cn("h-1.5", isOverLimit ? "[&>div]:bg-destructive" : "[&>div]:bg-primary")}
      />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{timing}</span>
        <span className="shrink-0 tabular-nums">
          {new Intl.NumberFormat(i18n.language, {
            style: "percent",
            maximumFractionDigits: 0,
          }).format(Math.floor(percentage) / 100)}
        </span>
      </div>
    </div>
  );
}
