import { Building2, Clock3, Globe2, UserPlus, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import LeaderboardSyncRow from "./LeaderboardSyncRow";

export default function LeaderboardSoloEmptyState({
  scopeKind,
  scopeName,
  onInvite,
  pendingInvites,
  sync,
}: {
  scopeKind: "workspace" | "domain";
  scopeName: string;
  onInvite: () => void;
  pendingInvites: string[];
  sync: {
    canEnable: boolean;
    enabled: boolean;
    error: boolean;
    onEnable: () => void;
    ready: boolean;
    updating: boolean;
  };
}) {
  const { t } = useTranslation();
  const ScopeIcon = scopeKind === "workspace" ? Building2 : Globe2;

  return (
    <div
      data-leaderboard-state="invite"
      className="relative isolate flex min-h-96 items-center justify-center overflow-hidden px-6 py-12 text-center"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 size-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl"
      />

      <div className="relative flex max-w-lg flex-col items-center">
        <div aria-hidden="true" className="flex items-center">
          <div className="flex size-11 items-center justify-center rounded-full border border-dashed border-border/70 bg-muted/30 text-muted-foreground/45">
            <UserRound size={18} />
          </div>
          <div className="w-9 border-t border-dashed border-border/70" />
          <div className="flex size-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
            <UserPlus size={24} />
          </div>
          <div className="w-9 border-t border-dashed border-border/70" />
          <div className="flex size-11 items-center justify-center rounded-full border border-dashed border-border/70 bg-muted/30 text-muted-foreground/45">
            <UserRound size={18} />
          </div>
        </div>

        <div className="mt-6 inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/30 px-3 py-1 text-[11px] font-medium text-muted-foreground">
          <ScopeIcon size={12} />
          <span>{scopeName}</span>
        </div>

        <h3 className="mt-4 text-xl font-semibold tracking-tight">
          {t("insights.leaderboard.soloTitle")}
        </h3>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          {t("insights.leaderboard.soloDescription", { scope: scopeName })}
        </p>

        <Button size="lg" className="mt-6" onClick={onInvite}>
          <UserPlus size={16} />
          {t("insights.leaderboard.inviteCta")}
        </Button>
        <p className="mt-3 text-[11px] text-muted-foreground/75">
          {t("insights.leaderboard.soloHint")}
        </p>
        {pendingInvites.length > 0 && (
          <div className="mt-4 flex max-w-full items-start gap-2 rounded-lg border border-border/50 bg-muted/25 px-3 py-2 text-left text-[11px] text-muted-foreground">
            <Clock3 size={13} className="mt-0.5 shrink-0" />
            <p className="min-w-0 break-words">
              {t("insights.leaderboard.invitedList", { emails: pendingInvites.join(", ") })}
            </p>
          </div>
        )}
        <LeaderboardSyncRow {...sync} />
      </div>
    </div>
  );
}
