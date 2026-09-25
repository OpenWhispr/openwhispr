import type { ReactNode } from "react";
import { Crown, Medal } from "./icons";
import type { LeaderboardMember } from "../types/electron";
import { cn } from "./lib/utils";
import MemberAvatar from "./MemberAvatar";
import { Skeleton } from "./ui/skeleton";

const PODIUM_PLACEMENTS = [
  {
    memberIndex: 0,
    cardClass: "border-amber-400/25 bg-amber-400/5 sm:min-h-44 sm:-translate-y-1",
    rankClass: "bg-amber-400/12 text-amber-600 dark:text-amber-400",
    iconClass: "text-amber-500",
    Icon: Crown,
  },
  {
    memberIndex: 1,
    cardClass: "border-slate-400/30 bg-slate-400/5 sm:min-h-40 dark:border-slate-300/20",
    rankClass: "bg-slate-400/12 text-slate-600 dark:text-slate-300",
    iconClass: "text-slate-500 dark:text-slate-300",
    Icon: Medal,
  },
  {
    memberIndex: 2,
    cardClass: "border-orange-500/25 bg-orange-500/5 sm:min-h-40",
    rankClass: "bg-orange-400/10 text-orange-600 dark:text-orange-400",
    iconClass: "text-orange-500/80",
    Icon: Medal,
  },
] as const;

function PodiumFrame({
  children,
  detail,
  placeCount,
  title,
}: {
  children: ReactNode;
  detail: ReactNode;
  placeCount: number;
  title: string;
}) {
  return (
    <div className="px-5 pb-5 pt-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <Medal size={14} className="text-amber-500" />
          {title}
        </div>
        <p className="text-[11px] text-muted-foreground">{detail}</p>
      </div>

      <div
        className={cn(
          "grid grid-cols-1 items-end gap-3",
          placeCount === 1 && "mx-auto max-w-md",
          placeCount === 2 && "mx-auto max-w-3xl sm:grid-cols-2",
          placeCount >= 3 && "sm:grid-cols-3"
        )}
      >
        {children}
      </div>
    </div>
  );
}

function PodiumPlace({
  children,
  placeCount,
  placement: { cardClass, rankClass, iconClass, Icon },
  rank,
}: {
  children: ReactNode;
  placeCount: number;
  placement: (typeof PODIUM_PLACEMENTS)[number];
  rank: number;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-36 flex-col items-center justify-center rounded-xl border px-4 py-4 text-center",
        placeCount >= 3 && rank === 1 && "sm:order-2",
        placeCount >= 3 && rank === 2 && "sm:order-1",
        placeCount >= 3 && rank === 3 && "sm:order-3",
        cardClass
      )}
    >
      <div
        className={cn(
          "absolute left-3 top-3 flex h-6 min-w-6 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] font-semibold tabular-nums",
          rankClass
        )}
      >
        <Icon size={11} className={iconClass} />
        {rank}
      </div>
      {children}
    </div>
  );
}

/** The podium's title and placements, with the members, metric and period still to come. */
export function LeaderboardPodiumSkeleton({ title }: { title: string }) {
  return (
    <PodiumFrame
      detail={<Skeleton className="inline-block h-2.5 w-28 align-middle" />}
      placeCount={PODIUM_PLACEMENTS.length}
      title={title}
    >
      {PODIUM_PLACEMENTS.map((placement) => (
        <PodiumPlace
          key={placement.memberIndex}
          placeCount={PODIUM_PLACEMENTS.length}
          placement={placement}
          rank={placement.memberIndex + 1}
        >
          <Skeleton className="size-11 rounded-full" />
          <p className="mt-3 text-sm font-medium">
            <Skeleton className="inline-block h-3.5 w-24 align-middle" />
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            <Skeleton className="inline-block h-6 w-16 align-middle" />
          </p>
        </PodiumPlace>
      ))}
    </PodiumFrame>
  );
}

export default function LeaderboardPodium({
  formatValue,
  memberLabel,
  members,
  metricLabel,
  periodLabel,
  title,
}: {
  formatValue: (member: LeaderboardMember) => string;
  memberLabel: (member: LeaderboardMember) => string;
  members: LeaderboardMember[];
  metricLabel: string;
  periodLabel: string;
  title: string;
}) {
  if (members.length === 0) return null;
  const placeCount = Math.min(members.length, PODIUM_PLACEMENTS.length);

  return (
    <PodiumFrame detail={`${metricLabel} · ${periodLabel}`} placeCount={placeCount} title={title}>
      {PODIUM_PLACEMENTS.slice(0, placeCount).map((placement) => {
        const member = members[placement.memberIndex];
        return (
          <PodiumPlace
            key={member.userId}
            placeCount={placeCount}
            placement={placement}
            rank={member.rank}
          >
            <div className="rounded-full ring-4 ring-background/70">
              <MemberAvatar
                name={member.name}
                email={member.email}
                image={member.image}
                size="lg"
              />
            </div>
            <p className="mt-3 max-w-full truncate text-sm font-medium">{memberLabel(member)}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
              {formatValue(member)}
            </p>
          </PodiumPlace>
        );
      })}
    </PodiumFrame>
  );
}
