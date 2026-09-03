import { Trophy, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const PREVIEW_ROWS = [92, 84, 76, 68, 61] as const;

type LeaderboardPreviewVariant = "locked" | "free" | "invite";

interface LeaderboardPreviewProps {
  actionDisabled?: boolean;
  actionIcon?: LucideIcon;
  actionLabel: string;
  badge?: string;
  className?: string;
  description: string;
  icon: LucideIcon;
  onAction: () => void;
  title: string;
  variant: LeaderboardPreviewVariant;
}

export default function LeaderboardPreview({
  actionIcon: ActionIcon,
  actionDisabled = false,
  actionLabel,
  badge,
  className,
  description,
  icon: Icon,
  onAction,
  title,
  variant,
}: LeaderboardPreviewProps) {
  const { t } = useTranslation();

  return (
    <section
      className={cn(
        "relative min-h-96 overflow-hidden rounded-2xl border border-border/50 bg-card/70 dark:border-white/8",
        className
      )}
      data-leaderboard-locked-preview={variant === "locked" ? "" : undefined}
      data-leaderboard-free-preview={variant === "free" ? "" : undefined}
      data-leaderboard-invite-preview={variant === "invite" ? "" : undefined}
    >
      <div className="pointer-events-none select-none opacity-35 blur-[1px]" aria-hidden="true">
        <div className="flex items-center gap-2 border-b border-border/40 px-5 py-4">
          <Trophy size={17} className="text-amber-500" />
          <div className="h-4 w-28 rounded bg-foreground/20" />
        </div>

        <div className="grid grid-cols-3 items-end gap-3 px-8 py-6">
          {[2, 1, 3].map((rank) => (
            <div
              key={rank}
              className={cn(
                "flex flex-col items-center rounded-xl border border-border/40 bg-background/40 px-3 py-4",
                rank === 1 && "py-6"
              )}
            >
              <div className="flex size-10 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                {rank}
              </div>
              <div className="mt-3 h-3 w-20 rounded bg-foreground/20" />
              <div className="mt-2 h-4 w-14 rounded bg-foreground/25" />
            </div>
          ))}
        </div>

        <div className="border-t border-border/40 px-5 py-3">
          <div className="mb-2 grid grid-cols-[3rem_1fr_6rem] gap-3 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>{t("insights.leaderboard.rank")}</span>
            <span>{t("insights.leaderboard.member")}</span>
            <span className="text-right">{t("insights.leaderboard.metrics.total_words")}</span>
          </div>
          {PREVIEW_ROWS.map((width, index) => (
            <div
              key={width}
              className="grid grid-cols-[3rem_1fr_6rem] items-center gap-3 border-t border-border/30 py-3"
            >
              <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
              <div className="flex items-center gap-2.5">
                <div className="size-7 rounded-full bg-muted" />
                <div className="h-3 rounded bg-foreground/20" style={{ width: `${width}px` }} />
              </div>
              <div className="ml-auto h-3 w-12 rounded bg-foreground/25" />
            </div>
          ))}
        </div>
      </div>

      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-background/20 via-background/60 to-background/90 p-6 backdrop-blur-[2px]">
        <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-background/95 p-6 text-center shadow-xl">
          <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon size={20} />
          </div>
          {badge && (
            <Badge variant="secondary" className="mt-4">
              {badge}
            </Badge>
          )}
          <h2 className={cn("text-base font-semibold", badge ? "mt-3" : "mt-4")}>{title}</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{description}</p>
          <Button className="mt-5 w-full" onClick={onAction} disabled={actionDisabled}>
            {ActionIcon && <ActionIcon size={14} />}
            {actionLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}
