import { Check, CloudUpload, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";

export default function LeaderboardSyncRow({
  canEnable,
  enabled,
  error,
  onDisable,
  onEnable,
  ready,
  updating,
}: {
  canEnable: boolean;
  enabled: boolean;
  error: boolean;
  onDisable: () => void;
  onEnable: () => void;
  ready: boolean;
  updating: boolean;
}) {
  const { t } = useTranslation();
  const disabled = !ready || updating || (!enabled && !canEnable);
  const hint = error
    ? t("insights.leaderboard.activationError")
    : !canEnable && ready
      ? t("insights.leaderboard.syncPolicyBlocked")
      : t("insights.leaderboard.syncRowHint");

  return (
    <div className="mt-6 flex w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/20 p-3 text-left">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <CloudUpload size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{t("insights.leaderboard.syncRowLabel")}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t("insights.leaderboard.syncRowLabel")}
        disabled={disabled}
        onClick={enabled ? onDisable : onEnable}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60",
          enabled ? "bg-primary" : "bg-muted-foreground/25"
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background shadow-sm transition-transform",
            enabled && "translate-x-4"
          )}
        >
          {!ready || updating ? (
            <Loader2 size={9} className="animate-spin text-muted-foreground" />
          ) : enabled ? (
            <Check size={9} className="text-primary" />
          ) : null}
        </span>
      </button>
    </div>
  );
}
