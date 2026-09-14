import { useTranslation } from "react-i18next";
import { Clock3 } from "./icons";
import { cn } from "./lib/utils";
import { LeaderboardPodiumSkeleton } from "./LeaderboardPodium";
import { Skeleton } from "./ui/skeleton";

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
      <LeaderboardPodiumSkeleton title={t("insights.leaderboard.topPerformers")} />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/10">
            <tr className="border-y border-border/70 text-start text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="w-16 px-5 py-2.5 font-medium">
                {t("insights.leaderboard.rank")}
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t("insights.leaderboard.member")}
              </th>
              <th scope="col" className="w-56 px-5 py-2 font-medium">
                <Skeleton className="ml-auto h-8 w-48 rounded-lg" />
              </th>
            </tr>
          </thead>
          <tbody>
            {ROW_WIDTHS.map(([nameWidth, detailWidth]) => (
              <tr key={nameWidth} className="border-b border-border/70 last:border-0">
                <td className="px-5 py-3">
                  <Skeleton className="size-6" />
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2.5">
                    <Skeleton className="size-5 shrink-0 rounded-full" />
                    <div>
                      <p>
                        <Skeleton className={cn("inline-block h-3.5 align-middle", nameWidth)} />
                      </p>
                      <p className="text-[11px]">
                        <Skeleton className={cn("inline-block h-2.5 align-middle", detailWidth)} />
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <Skeleton className="ml-auto h-3.5 w-12" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A whole leaderboard card, for while the board it will show is still unknown. */
export default function LeaderboardSkeleton() {
  const { t } = useTranslation();
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border/70 bg-card/70 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="size-9 shrink-0 rounded-lg" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">
              <Skeleton className="inline-block h-3.5 w-36 align-middle" />
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <Skeleton className="h-2.5 w-18" />
              <span aria-hidden="true" className="size-0.5 rounded-full bg-muted-foreground/50" />
              <span className="flex items-center gap-1">
                <Clock3 size={11} />
                {t("insights.leaderboard.refreshCadence")}
              </span>
            </div>
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
