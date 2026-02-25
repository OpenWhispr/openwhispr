import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useUsage } from "../hooks/useUsage";
import { useToast } from "./ui/Toast";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { Button } from "./ui/button";
import { useSettingsStore } from "../stores/settingsStore";

export default function UsageDisplay() {
  const { t } = useTranslation();
  const usage = useUsage();
  const { toast } = useToast();
  const hasShownApproachingToast = useRef(false);

  // One-time toast when approaching limit (>80%)
  useEffect(() => {
    if (usage?.isApproachingLimit && !hasShownApproachingToast.current) {
      hasShownApproachingToast.current = true;
      toast({
        title: t("usage.approachingLimit"),
        description: t("usage.approachingLimitDescription", {
          wordsUsed: usage.wordsUsed.toLocaleString(),
          limit: usage.limit.toLocaleString(),
        }),
        duration: 6000,
      });
    }
  }, [usage?.isApproachingLimit, usage?.wordsUsed, usage?.limit, toast, t]);

  if (!usage) return null;

  // Pro plan or trial — minimal display
  if (usage.isSubscribed) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">{t("usage.yourPlan")}</span>
          {usage.isTrial ? (
            <Badge variant="outline" className="text-primary border-primary/30">
              {t("usage.trial", { days: usage.trialDaysLeft, count: usage.trialDaysLeft })}
            </Badge>
          ) : (
            <Badge variant="success">{t("usage.pro")}</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {usage.isTrial ? t("usage.unlimitedTrial") : t("usage.unlimited")}
        </p>
        {!usage.isTrial && (
          <Button variant="outline" size="sm" onClick={() => usage.openBillingPortal()}>
            {t("usage.manageSubscription")}
          </Button>
        )}
      </div>
    );
  }

  // Free plan
  const percentage = usage.limit > 0 ? Math.min(100, (usage.wordsUsed / usage.limit) * 100) : 0;
  const progressColor =
    percentage >= 100
      ? "[&>div]:bg-destructive"
      : percentage >= 80
        ? "[&>div]:bg-warning"
        : "[&>div]:bg-primary";

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{t("usage.weeklyUsage")}</span>
        {usage.isOverLimit ? (
          <Badge variant="warning">{t("usage.limitReached")}</Badge>
        ) : (
          <Badge variant="outline">{t("usage.free")}</Badge>
        )}
      </div>

      <div className="space-y-1.5">
        <Progress
          value={percentage}
          className={`h-2 transition-colors duration-500 ${progressColor}`}
        />
        <div className="flex items-center justify-between">
          <span className="text-sm tabular-nums text-muted-foreground">
            {usage.wordsUsed.toLocaleString()} / {usage.limit.toLocaleString()}
          </span>
          {usage.isApproachingLimit && (
            <span className="text-xs text-warning">
              {t("usage.wordsRemaining", {
                count: usage.wordsRemaining,
                remaining: usage.wordsRemaining.toLocaleString(),
              })}
            </span>
          )}
          {!usage.isApproachingLimit && !usage.isOverLimit && (
            <span className="text-xs text-muted-foreground">{t("usage.rollingLimit")}</span>
          )}
        </div>
      </div>

      {usage.isOverLimit ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/90"
            onClick={() => usage.openCheckout()}
          >
            {t("usage.upgradeToPro")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              useSettingsStore.getState().setCloudTranscriptionMode("byok");
              window.location.reload();
            }}
          >
            {t("usage.useYourOwnKey")}
          </Button>
        </div>
      ) : usage.isApproachingLimit ? (
        <Button
          size="sm"
          className="bg-primary hover:bg-primary/90"
          onClick={() => usage.openCheckout()}
        >
          {t("usage.upgradeToPro")}
        </Button>
      ) : (
        <a
          href="#"
          className="text-primary hover:text-primary/80 text-sm inline-block"
          onClick={(e) => {
            e.preventDefault();
            usage.openCheckout();
          }}
        >
          {t("usage.upgradeUnlimited")}
        </a>
      )}
    </div>
  );
}
