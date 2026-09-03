import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Loader2,
  LocateFixed,
  RefreshCw,
  Share2,
  Trophy,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  LEADERBOARD_PAGE_SIZE,
  LEADERBOARD_REFRESH_INTERVAL_MS,
  normalizeLeaderboardSelection,
  pageCount,
  pageForRank,
  selectionForRange,
} from "../helpers/leaderboard";
import { LeaderboardService } from "../services/LeaderboardService";
import { WorkspacesService } from "../services/WorkspacesService";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type {
  Leaderboard,
  LeaderboardAccess,
  LeaderboardMember,
  LeaderboardMetric,
  LeaderboardRange,
} from "../types/electron";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import InviteTeammateDialog from "./InviteTeammateDialog";
import MemberAvatar from "./MemberAvatar";
import LeaderboardCreateTeamPreview from "./LeaderboardCreateTeamPreview";
import LeaderboardFreePreview from "./LeaderboardFreePreview";
import LeaderboardInvitePreview from "./LeaderboardInvitePreview";
import LeaderboardRequestJoinPreview from "./LeaderboardRequestJoinPreview";
import LeaderboardShareDialog from "./LeaderboardShareDialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip } from "./ui/tooltip";
import { useToast } from "./ui/useToast";

const WEEKLY_METRICS: LeaderboardMetric[] = ["total_words", "desktop_words", "mobile_words"];
const ALL_TIME_METRICS: LeaderboardMetric[] = [
  ...WEEKLY_METRICS,
  "words_per_minute",
  "current_daily_streak",
];

interface LeaderboardSectionProps {
  accountId: string | null;
  isSignedIn: boolean;
  syncActive: boolean;
  syncCanBeEnabled: boolean;
  participationReady: boolean;
  participationError: boolean;
  onEnableSync: () => void;
  onUpgrade: () => void;
}

function memberValue(member: LeaderboardMember, metric: LeaderboardMetric): number | null {
  switch (metric) {
    case "words_per_minute":
      return member.averageWpm;
    case "current_daily_streak":
      return member.currentStreakDays;
    case "desktop_words":
      return member.desktopWords;
    case "mobile_words":
      return member.mobileWords;
    case "total_words":
      return member.totalWords;
  }
}

export default function LeaderboardSection({
  accountId,
  isSignedIn,
  syncActive,
  syncCanBeEnabled,
  participationReady,
  participationError,
  onEnableSync,
  onUpgrade,
}: LeaderboardSectionProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const loaded = useWorkspaceStore((state) => state.loaded);
  const refresh = useWorkspaceStore((state) => state.refresh);
  const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);
  const [access, setAccess] = useState<LeaderboardAccess | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState(false);
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [metric, setMetric] = useState<LeaderboardMetric>("total_words");
  const [range, setRange] = useState<LeaderboardRange>("week");
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [requestingJoin, setRequestingJoin] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [inviteWorkspace, setInviteWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [page, setPage] = useState(0);
  const [editingRank, setEditingRank] = useState(false);
  const [rankInput, setRankInput] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const pendingScrollRankRef = useRef<number | null>(null);
  const accessRequestIdRef = useRef(0);
  const lastLoadedAtRef = useRef(0);
  const requestIdRef = useRef(0);
  const scopes = useMemo(() => access?.scopes ?? [], [access]);
  const selectedScope = scopes.find((scope) => scope.key === scopeKey);

  const loadAccess = useCallback(async () => {
    const requestId = ++accessRequestIdRef.current;
    if (!accountId) {
      setAccess(null);
      setAccessLoading(false);
      setAccessError(false);
      return;
    }
    setAccessLoading(true);
    setAccessError(false);
    try {
      const response = await LeaderboardService.getAccess();
      if (requestId !== accessRequestIdRef.current) return;
      setAccess(response);
      setScopeKey((current) =>
        current && response.scopes.some((scope) => scope.key === current)
          ? current
          : (response.scopes[0]?.key ?? null)
      );
    } catch (loadError) {
      if (requestId !== accessRequestIdRef.current) return;
      console.error("Loading leaderboard access failed:", loadError);
      setAccessError(true);
    } finally {
      if (requestId === accessRequestIdRef.current) setAccessLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (isSignedIn && !loaded) void refresh();
  }, [isSignedIn, loaded, refresh]);

  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);

  useEffect(() => {
    requestIdRef.current += 1;
    setLeaderboard((current) => (current?.scope.key === scopeKey ? current : null));
    setWeekStart(null);
    setPage(0);
  }, [scopeKey]);

  useEffect(() => {
    if (!syncActive) requestIdRef.current += 1;
  }, [syncActive]);

  const load = useCallback(async () => {
    if (!selectedScope || selectedScope.state !== "ready" || !syncActive || !participationReady)
      return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(false);
    try {
      const response = await LeaderboardService.getLeaderboard(selectedScope, {
        metric,
        range,
        weekStart,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        page,
      });
      if (requestId !== requestIdRef.current) return;
      setLeaderboard(response);
      if (response.page !== page) setPage(response.page);
      lastLoadedAtRef.current = Date.now();
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      console.error("Loading leaderboard failed:", loadError);
      setError(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [metric, page, participationReady, range, selectedScope, syncActive, weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedScope || selectedScope.state !== "ready" || !syncActive || !participationReady)
      return;
    const refreshIfStale = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastLoadedAtRef.current >= LEADERBOARD_REFRESH_INTERVAL_MS
      ) {
        void load();
      }
    };
    const interval = window.setInterval(refreshIfStale, LEADERBOARD_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [load, participationReady, selectedScope, syncActive]);

  const pages = pageCount(leaderboard?.totalMembers ?? 0);
  useEffect(() => setPage((current) => Math.min(current, pages - 1)), [pages]);

  const visibleMembers = useMemo(() => leaderboard?.members ?? [], [leaderboard]);

  useEffect(() => {
    const rank = pendingScrollRankRef.current;
    if (rank == null || !visibleMembers.some((member) => member.rank === rank)) return;
    pendingScrollRankRef.current = null;
    requestAnimationFrame(() =>
      document.getElementById(`leaderboard-rank-${rank}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      })
    );
  }, [visibleMembers]);

  const requestJoin = async () => {
    const target = access?.joinableWorkspace;
    if (!target || target.requestState === "pending" || requestingJoin) return;
    setRequestingJoin(true);
    try {
      await WorkspacesService.requestJoin(target.id);
      setAccess((current) =>
        current?.joinableWorkspace
          ? {
              ...current,
              joinableWorkspace: { ...current.joinableWorkspace, requestState: "pending" },
            }
          : current
      );
      toast({
        title: t("workspaces.join.requestedTitle"),
        description: t("workspaces.join.requestedDescription", { workspace: target.name }),
      });
    } catch (requestError) {
      toast({
        title: t("workspaces.join.requestErrorTitle"),
        description:
          requestError instanceof Error ? requestError.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setRequestingJoin(false);
    }
  };

  const dialogs = (
    <>
      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={(workspaceId) => {
          const created = useWorkspaceStore
            .getState()
            .workspaces.find((workspace) => workspace.id === workspaceId);
          setInviteWorkspace({ id: workspaceId, name: created?.name ?? t("common.unknown") });
          void loadAccess();
        }}
      />
      {inviteWorkspace && (
        <InviteTeammateDialog
          open
          onOpenChange={(open) => {
            if (!open) setInviteWorkspace(null);
          }}
          workspaceId={inviteWorkspace.id}
          workspaceName={inviteWorkspace.name}
          onInvited={() => void loadAccess()}
        />
      )}
    </>
  );

  const scopeSelect =
    scopes.length > 1 ? (
      <Select value={selectedScope?.key} onValueChange={setScopeKey}>
        <SelectTrigger className="h-8 w-44 rounded-lg text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {scopes.map((scope) => (
            <SelectItem key={scope.key} value={scope.key}>
              {scope.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  if (!isSignedIn) return null;
  if (accessLoading && !access) {
    return (
      <section className="mt-8 flex min-h-48 items-center justify-center rounded-2xl border border-border/50 bg-card/70 text-muted-foreground dark:border-white/8">
        <Loader2 size={18} className="animate-spin" />
      </section>
    );
  }
  if (accessError && !access) {
    return (
      <section className="mt-8 flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card/70 px-5 py-10 text-center dark:border-white/8">
        <p className="text-sm font-medium">{t("insights.leaderboard.accessError")}</p>
        <Button variant="outline" size="sm" onClick={() => void loadAccess()}>
          {t("insights.leaderboard.retry")}
        </Button>
      </section>
    );
  }
  if (!access) return null;

  if (selectedScope?.state === "invite") {
    return (
      <>
        <div className="mt-8 space-y-3">
          {scopeSelect && <div className="flex justify-end">{scopeSelect}</div>}
          <LeaderboardInvitePreview
            onInvite={() => {
              if (selectedScope.kind === "workspace") {
                setActiveWorkspaceId(selectedScope.id);
                setInviteWorkspace({ id: selectedScope.id, name: selectedScope.name });
              } else {
                setCreateWorkspaceOpen(true);
              }
            }}
          />
        </div>
        {dialogs}
      </>
    );
  }
  if (access.state === "request_join" && access.joinableWorkspace) {
    return (
      <LeaderboardRequestJoinPreview
        className="mt-8"
        workspaceName={access.joinableWorkspace.name}
        pending={access.joinableWorkspace.requestState === "pending"}
        requesting={requestingJoin}
        onRequest={() => void requestJoin()}
      />
    );
  }
  if (access.state === "create_team" && access.domain) {
    return (
      <>
        <LeaderboardCreateTeamPreview
          className="mt-8"
          domain={access.domain}
          onCreate={() => setCreateWorkspaceOpen(true)}
        />
        {dialogs}
      </>
    );
  }
  if (access.state === "invite" && !selectedScope) {
    return (
      <>
        <LeaderboardInvitePreview className="mt-8" onInvite={() => setCreateWorkspaceOpen(true)} />
        {dialogs}
      </>
    );
  }
  if (access.state === "upgrade" || !selectedScope) {
    return <LeaderboardFreePreview className="mt-8" onUpgrade={onUpgrade} />;
  }

  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" });
  const formatWeek = (value: string) => {
    const start = new Date(`${value}T12:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return `${date.format(start)} – ${date.format(end)}`;
  };
  const activeWeekStart = weekStart ?? leaderboard?.weekStart;
  const periodLabel =
    range === "all"
      ? t("insights.leaderboard.allTime")
      : activeWeekStart
        ? formatWeek(activeWeekStart)
        : t("insights.leaderboard.thisWeek");
  const formatValue = (member: LeaderboardMember) => {
    const value = memberValue(member, metric);
    if (value == null) return "—";
    if (metric === "words_per_minute") {
      return t("insights.leaderboard.wpmValue", { count: number.format(value) });
    }
    if (metric === "current_daily_streak") {
      return t("insights.leaderboard.dayValue", { count: number.format(value) });
    }
    return number.format(value);
  };
  const jumpToRank = (rank: number) => {
    if (!leaderboard?.totalMembers) return;
    const resolvedRank = Math.max(1, Math.min(leaderboard.totalMembers, Math.trunc(rank) || 1));
    pendingScrollRankRef.current = resolvedRank;
    setPage(pageForRank(resolvedRank, leaderboard.totalMembers));
  };
  const podiumOrder = leaderboard?.leaders.length === 1 ? [0] : [1, 0, 2];

  if (!syncActive || !participationReady) {
    return (
      <section className="mt-8 rounded-2xl border border-primary/20 bg-primary/5 p-6">
        <div className="flex items-start justify-between gap-5">
          <div className="flex gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {participationReady ? (
                <Trophy size={18} />
              ) : (
                <Loader2 size={18} className="animate-spin" />
              )}
            </div>
            <p className="max-w-2xl pt-0.5 text-xs leading-relaxed text-muted-foreground">
              {participationError
                ? t("insights.leaderboard.activationError")
                : participationReady
                  ? t("insights.leaderboard.activationDescription")
                  : t("insights.leaderboard.checkingParticipation")}
            </p>
          </div>
          {participationReady && (
            <Button size="sm" onClick={onEnableSync} disabled={!syncCanBeEnabled}>
              <Cloud size={14} />
              {t("insights.leaderboard.join")}
            </Button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-border/50 bg-card/70 dark:border-white/8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/40 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Trophy size={17} className="text-amber-500" />
            <h2 className="text-base font-semibold">{selectedScope.name}</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {scopeSelect}
          {leaderboard?.canShare && (
            <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
              <Share2 size={14} />
              {t("insights.leaderboard.share")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t("insights.leaderboard.refresh")}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {error && !leaderboard ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
          <p className="text-sm font-medium">{t("insights.leaderboard.error")}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("insights.leaderboard.retry")}
          </Button>
        </div>
      ) : !leaderboard ? (
        <div className="flex min-h-48 items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : (
        <>
          {leaderboard.leaders.length > 0 && (
            <div className="grid grid-cols-1 items-end gap-3 px-5 pb-5 pt-6 sm:grid-cols-3">
              {podiumOrder.map((memberIndex) => {
                const member = leaderboard.leaders[memberIndex];
                if (!member) return <div key={memberIndex} />;
                const winner = member.rank === 1;
                return (
                  <div
                    key={member.userId}
                    className={`flex flex-col items-center rounded-xl border px-3 py-4 text-center ${
                      winner
                        ? "order-first border-amber-400/30 bg-amber-400/8 sm:order-none sm:py-6"
                        : "border-border/40 bg-background/35"
                    }`}
                  >
                    <div className="relative">
                      <MemberAvatar name={member.name} email={member.email} image={member.image} />
                      <span className="absolute -bottom-2 left-1/2 flex size-5 -translate-x-1/2 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">
                        {member.rank}
                      </span>
                    </div>
                    <p className="mt-4 max-w-full truncate text-sm font-medium">
                      {member.name || member.email}
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums">{formatValue(member)}</p>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-5 py-3">
            <div className="flex rounded-lg bg-muted/60 p-0.5">
              {(["week", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    range === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => {
                    const next = selectionForRange(metric, value);
                    setMetric(next.metric);
                    setRange(next.range);
                    setWeekStart(null);
                    setPage(0);
                  }}
                >
                  {t(`insights.leaderboard.${value === "week" ? "thisWeek" : "allTime"}`)}
                </button>
              ))}
            </div>
            {range === "week" && (
              <Select
                value={weekStart ?? leaderboard.weekStart ?? undefined}
                onValueChange={(value) => {
                  setWeekStart(value);
                  setPage(0);
                }}
              >
                <SelectTrigger className="h-8 w-44 rounded-lg text-xs">
                  <SelectValue placeholder={t("insights.leaderboard.history")} />
                </SelectTrigger>
                <SelectContent>
                  {leaderboard.availableWeekStarts.map((value, index) => (
                    <SelectItem key={value} value={value}>
                      {index === 0
                        ? `${t("insights.leaderboard.thisWeek")} · ${formatWeek(value)}`
                        : formatWeek(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-y border-border/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-16 px-5 py-2.5 font-medium">{t("insights.leaderboard.rank")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("insights.leaderboard.member")}</th>
                  <th className="w-56 px-5 py-2 text-right font-medium">
                    <Select
                      value={metric}
                      onValueChange={(value: LeaderboardMetric) => {
                        const next = normalizeLeaderboardSelection(value, range);
                        setMetric(next.metric);
                        setRange(next.range);
                        setWeekStart(next.range === "week" ? weekStart : null);
                        setPage(0);
                      }}
                    >
                      <SelectTrigger className="ml-auto h-7 w-48 rounded-md border-0 bg-transparent px-2 text-[11px] uppercase tracking-wide shadow-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(range === "week" ? WEEKLY_METRICS : ALL_TIME_METRICS).map((value) => (
                          <SelectItem key={value} value={value}>
                            {t(`insights.leaderboard.metrics.${value}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleMembers.map((member) => {
                  const isViewer = member.userId === leaderboard.viewerUserId;
                  return (
                    <tr
                      id={`leaderboard-rank-${member.rank}`}
                      key={member.userId}
                      className={`border-b border-border/30 last:border-0 ${isViewer ? "bg-primary/5" : ""}`}
                    >
                      <td className="px-5 py-3 font-medium tabular-nums text-muted-foreground">
                        {member.rank}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <MemberAvatar
                            name={member.name}
                            email={member.email}
                            image={member.image}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {member.name || member.email}
                              {isViewer && (
                                <span className="ml-1 text-xs font-normal text-primary">
                                  {t("insights.leaderboard.you")}
                                </span>
                              )}
                            </p>
                            {member.name && (
                              <p className="truncate text-[11px] text-muted-foreground">
                                {member.email}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right font-semibold tabular-nums">
                        {formatValue(member)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-5 py-3">
            <Tooltip
              content={
                leaderboard.viewerRank !== null
                  ? t("insights.leaderboard.jumpToMe")
                  : t("insights.leaderboard.jumpUnavailable")
              }
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={leaderboard.viewerRank === null}
                onClick={() =>
                  leaderboard.viewerRank !== null && jumpToRank(leaderboard.viewerRank)
                }
              >
                <LocateFixed size={14} />
                {t("insights.leaderboard.jumpToMe")}
              </Button>
            </Tooltip>

            {leaderboard.totalMembers > LEADERBOARD_PAGE_SIZE && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={page === 0}
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  aria-label={t("insights.leaderboard.previous")}
                >
                  <ChevronLeft size={15} />
                </Button>
                {editingRank ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      jumpToRank(Number(rankInput));
                      setEditingRank(false);
                    }}
                  >
                    <Input
                      autoFocus
                      type="number"
                      min={1}
                      max={leaderboard.totalMembers}
                      value={rankInput}
                      onChange={(event) => setRankInput(event.target.value)}
                      onBlur={() => setEditingRank(false)}
                      className="h-7 w-24 text-center text-xs"
                      aria-label={t("insights.leaderboard.jumpToRank")}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      setRankInput(String(page * LEADERBOARD_PAGE_SIZE + 1));
                      setEditingRank(true);
                    }}
                    title={t("insights.leaderboard.jumpToRank")}
                  >
                    {page * LEADERBOARD_PAGE_SIZE + 1}–
                    {Math.min((page + 1) * LEADERBOARD_PAGE_SIZE, leaderboard.totalMembers)} /{" "}
                    {leaderboard.totalMembers}
                  </button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={page >= pages - 1}
                  onClick={() => setPage((current) => Math.min(pages - 1, current + 1))}
                  aria-label={t("insights.leaderboard.next")}
                >
                  <ChevronRight size={15} />
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {leaderboard && (
        <LeaderboardShareDialog
          leaderboard={leaderboard}
          metric={metric}
          periodLabel={periodLabel}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </section>
  );
}
