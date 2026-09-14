import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { Skeleton } from "./ui/skeleton";

// Mirrors LeaderboardPodium, where first place sits in the middle and stands taller.
const PODIUM_CARD_CLASSES = [
  "sm:min-h-40",
  "sm:min-h-44 sm:-translate-y-1",
  "sm:min-h-40",
] as const;

const ROW_WIDTHS = [
  ["w-32", "w-44"],
  ["w-24", "w-36"],
  ["w-36", "w-48"],
  ["w-28", "w-40"],
  ["w-40", "w-44"],
] as const;

/** The podium and ranked rows, for a board whose header is already on screen. */
export function LeaderboardBoardSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status">
      <span className="sr-only">{t("controlPanel.loading")}</span>
      <div className="px-5 pb-5 pt-4">
        <div className="mb-4 flex h-4 items-center justify-between gap-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          {PODIUM_CARD_CLASSES.map((cardClass, index) => (
            <div
              key={index}
              className={cn(
                "relative flex min-h-36 flex-col items-center justify-center rounded-xl border border-border/70 px-4 py-4 dark:border-white/10",
                cardClass
              )}
            >
              <Skeleton className="absolute left-3 top-3 h-6 w-9" />
              <Skeleton className="size-11 rounded-full" />
              <Skeleton className="mt-3 h-3.5 w-24" />
              <Skeleton className="mt-2.5 h-6 w-16" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex h-12 items-center justify-between border-y border-border/70 bg-muted/10 px-5">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-8 w-48 rounded-lg" />
      </div>
      {ROW_WIDTHS.map(([nameWidth, detailWidth]) => (
        <div
          key={nameWidth}
          className="flex items-center gap-8 border-b border-border/70 px-5 py-3 last:border-0"
        >
          <Skeleton className="size-6 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <div className="space-y-2.5">
              <Skeleton className={cn("h-3.5", nameWidth)} />
              <Skeleton className={cn("h-3", detailWidth)} />
            </div>
          </div>
          <Skeleton className="h-3.5 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A whole leaderboard card, for while the board it will show is still unknown. */
export default function LeaderboardSkeleton() {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border/70 bg-card/70 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="space-y-2.5 py-0.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-44 rounded-lg" />
          <Skeleton className="size-8" />
        </div>
      </div>
      <LeaderboardBoardSkeleton />
    </section>
  );
}
