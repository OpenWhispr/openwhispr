import { Crown, Medal } from "lucide-react";
import type { LeaderboardMember } from "../types/electron";
import { cn } from "./lib/utils";
import MemberAvatar from "./MemberAvatar";

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

export default function LeaderboardPodium({
  formatValue,
  members,
  metricLabel,
  periodLabel,
  title,
}: {
  formatValue: (member: LeaderboardMember) => string;
  members: LeaderboardMember[];
  metricLabel: string;
  periodLabel: string;
  title: string;
}) {
  if (members.length === 0) return null;
  const placements = PODIUM_PLACEMENTS.slice(0, Math.min(members.length, 3));

  return (
    <div className="px-5 pb-5 pt-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <Medal size={14} className="text-amber-500" />
          {title}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {metricLabel} · {periodLabel}
        </p>
      </div>

      <div
        className={cn(
          "grid grid-cols-1 items-end gap-3",
          members.length === 1 && "mx-auto max-w-md",
          members.length === 2 && "mx-auto max-w-3xl sm:grid-cols-2",
          members.length >= 3 && "sm:grid-cols-3"
        )}
      >
        {placements.map(({ memberIndex, cardClass, rankClass, iconClass, Icon }) => {
          const member = members[memberIndex];
          if (!member) return null;

          return (
            <div
              key={member.userId}
              className={cn(
                "relative flex min-h-36 flex-col items-center justify-center rounded-xl border px-4 py-4 text-center",
                members.length >= 3 && member.rank === 1 && "sm:order-2",
                members.length >= 3 && member.rank === 2 && "sm:order-1",
                members.length >= 3 && member.rank === 3 && "sm:order-3",
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
                {member.rank}
              </div>

              <div className="rounded-full ring-4 ring-background/70">
                <MemberAvatar
                  name={member.name}
                  email={member.email}
                  image={member.image}
                  size="lg"
                />
              </div>
              <p className="mt-3 max-w-full truncate text-sm font-medium">
                {member.name || member.email}
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                {formatValue(member)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
