import { Dialog, DialogContent } from "./ui/dialog";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUsage } from "../hooks/useUsage";
import { useSettingsStore } from "../stores/settingsStore";

interface UpgradePromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wordsUsed?: number;
  limit?: number;
}

export default function UpgradePrompt({
  open,
  onOpenChange,
  wordsUsed = 2000,
  limit = 2000,
}: UpgradePromptProps) {
  const { t } = useTranslation();
  const usage = useUsage();
  const isPastDue = usage?.isPastDue ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="text-center space-y-2 pt-2">
          <h2 className="text-xl font-semibold text-foreground">
            {isPastDue ? t("upgradePrompt.paymentFailed") : t("upgradePrompt.weeklyLimit")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {(isPastDue
              ? t("upgradePrompt.pastDueDescription", { limit: limit.toLocaleString() })
              : t("upgradePrompt.limitDescription", {
                  used: wordsUsed.toLocaleString(),
                  limit: limit.toLocaleString(),
                })
            )
              .split("\n")
              .map((line, i, arr) => (
                <span key={i}>
                  {line}
                  {i < arr.length - 1 && <br />}
                </span>
              ))}
          </p>
        </div>

        <div className="space-y-2 pt-2">
          {isPastDue ? (
            <OptionCard
              title={t("upgradePrompt.updatePayment")}
              description={t("upgradePrompt.updatePaymentDescription")}
              onClick={() => {
                usage?.openBillingPortal();
              }}
              highlighted
              disabled={usage?.checkoutLoading}
            />
          ) : (
            <OptionCard
              title={t("upgradePrompt.upgradeToPro")}
              description={t("upgradePrompt.upgradeDescription")}
              onClick={() => {
                usage?.openCheckout();
              }}
              highlighted
              disabled={usage?.checkoutLoading}
            />
          )}
          <OptionCard
            title={t("upgradePrompt.useApiKey")}
            description={t("upgradePrompt.useApiKeyDescription")}
            onClick={() => {
              useSettingsStore.getState().setCloudTranscriptionMode("byok");
              onOpenChange(false);
            }}
          />
          <OptionCard
            title={t("upgradePrompt.switchToLocal")}
            description={t("upgradePrompt.switchToLocalDescription")}
            onClick={() => {
              useSettingsStore.getState().setUseLocalWhisper(true);
              onOpenChange(false);
            }}
          />
        </div>

        <p className="text-xs text-muted-foreground/60 text-center">
          {t("upgradePrompt.rollingWeeklyLimit")}
        </p>
      </DialogContent>
    </Dialog>
  );
}

function OptionCard({
  title,
  description,
  onClick,
  highlighted = false,
  disabled = false,
}: {
  title: string;
  description: string;
  onClick: () => void;
  highlighted?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left p-4 rounded-lg border transition-shadow duration-150 hover:shadow-md flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        highlighted
          ? "bg-primary/5 dark:bg-primary/10 border-primary/20 dark:border-primary/15"
          : "bg-muted/50 dark:bg-surface-2 border-border dark:border-border-subtle hover:border-border-hover"
      }`}
    >
      <div>
        <div className="font-medium text-foreground">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />
    </button>
  );
}
