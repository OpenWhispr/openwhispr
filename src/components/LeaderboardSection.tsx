import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Globe2,
  Loader2,
  LocateFixed,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Share2,
  Users,
  UserPlus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ALL_TIME_METRICS,
  LEADERBOARD_PAGE_SIZE,
  LEADERBOARD_REFRESH_INTERVAL_MS,
  memberValue,
  normalizeLeaderboardSelection,
  pageCount,
  pageForRank,
  resolveLeaderboardSurface,
  selectionForRange,
  WEEKLY_METRICS,
} from "../helpers/leaderboard";
import { CloudApiError } from "../services/cloudApi";
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
import { cn } from "./lib/utils";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import InviteTeammateDialog from "./InviteTeammateDialog";
import MemberAvatar from "./MemberAvatar";
import LeaderboardRequestJoinPreview from "./LeaderboardRequestJoinPreview";
import LeaderboardPodium from "./LeaderboardPodium";
import LeaderboardSetupCard from "./LeaderboardSetupCard";
import LeaderboardShareDialog from "./LeaderboardShareDialog";
import LeaderboardSignInPreview from "./LeaderboardSignInPreview";
import LeaderboardSoloEmptyState from "./LeaderboardSoloEmptyState";
import LeaderboardSyncPreview from "./LeaderboardSyncPreview";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip } from "./ui/tooltip";
import { useToast } from "./ui/useToast";

interface LeaderboardSectionProps {
  accountId: string | null;
  isSignedIn: boolean;
  /** The account row says joined — what the roster and Leave hang on, not the device toggle. */
  participating: boolean;
  canJoin: boolean;
  participationReady: boolean;
  participationError: "read" | "write" | null;
  participationUpdating: boolean;
  onJoin: () => void;
  onLeave: () => Promise<boolean>;
  onRefreshParticipation: () => void;
  onSignIn: () => void;
  onInvite: () => void;
}

const ERROR_CARD_CHROME = "mt-8 rounded-2xl border border-border/50 bg-card/70 dark:border-white/8";

function LeaderboardRetryCard({
  className,
  message,
  onRetry,
}: {
  className?: string;
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex min-h-48 flex-col items-center justify-center gap-3 px-5 py-10 text-center",
        className
      )}
    >
      <p className="text-sm font-medium">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("insights.leaderboard.retry")}
      </Button>
    </div>
  );
}

function scrollToRank(rank: number) {
  requestAnimationFrame(() =>
    document.getElementById(`leaderboard-rank-${rank}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    })
  );
}

export default function LeaderboardSection({
  accountId,
  isSignedIn,
  participating,
  canJoin,
  participationReady,
  participationError,
  participationUpdating,
  onJoin,
  onLeave,
  onRefreshParticipation,
  onSignIn,
  onInvite,
}: LeaderboardSectionProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const loaded = useWorkspaceStore((state) => state.loaded);
  const refresh = useWorkspaceStore((state) => state.refresh);
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
    if (!participating) requestIdRef.current += 1;
  }, [participating]);

  const load = useCallback(async () => {
    if (!selectedScope || selectedScope.state !== "ready" || !participating || !participationReady)
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
      // A 403 names the gate that moved under us, and retrying the same call
      // can never clear it. Re-read exactly that gate so the surface settles on
      // the card that matches reality instead of a dead "Try again".
      const code = loadError instanceof CloudApiError ? loadError.code : undefined;
      if (code === "LEADERBOARD_SYNC_REQUIRED") {
        setLeaderboard(null);
        onRefreshParticipation();
        return;
      }
      if (code === "LEADERBOARD_DOMAIN_REQUIRED") {
        setLeaderboard(null);
        void loadAccess();
        return;
      }
      setError(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [
    loadAccess,
    metric,
    onRefreshParticipation,
    page,
    participating,
    participationReady,
    range,
    selectedScope,
    weekStart,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  // The server owns how big a page is and how long a snapshot stays fresh; the
  // constants are only what to assume before the first response arrives.
  const pageSize = leaderboard?.pageSize ?? LEADERBOARD_PAGE_SIZE;
  const refreshIntervalMs = leaderboard
    ? leaderboard.refreshAfterSeconds * 1000
    : LEADERBOARD_REFRESH_INTERVAL_MS;

  useEffect(() => {
    if (!selectedScope || selectedScope.state !== "ready" || !participating || !participationReady)
      return;
    const refreshIfStale = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastLoadedAtRef.current >= refreshIntervalMs
      ) {
        void load();
      }
    };
    const interval = window.setInterval(refreshIfStale, refreshIntervalMs);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [load, participating, participationReady, refreshIntervalMs, selectedScope]);

  const pages = pageCount(leaderboard?.totalMembers ?? 0, pageSize);
  useEffect(() => setPage((current) => Math.min(current, pages - 1)), [pages]);

  const visibleMembers = useMemo(() => leaderboard?.members ?? [], [leaderboard]);
  const isSoloScope = selectedScope?.state === "invite";

  useEffect(() => {
    const rank = pendingScrollRankRef.current;
    if (rank == null || !visibleMembers.some((member) => member.rank === rank)) return;
    pendingScrollRankRef.current = null;
    scrollToRank(rank);
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

  if (!isSignedIn) return <LeaderboardSignInPreview className="mt-8" onSignIn={onSignIn} />;
  if (accessLoading && !access) {
    return (
      <section className="mt-8 flex min-h-48 items-center justify-center rounded-2xl border border-border/50 bg-card/70 text-muted-foreground dark:border-white/8">
        <Loader2 size={18} className="animate-spin" />
      </section>
    );
  }
  if (accessError && !access) {
    return (
      <LeaderboardRetryCard
        className={ERROR_CARD_CHROME}
        message={t("insights.leaderboard.accessError")}
        onRetry={() => void loadAccess()}
      />
    );
  }
  if (!access) return null;

  const surface = resolveLeaderboardSurface({
    access,
    selectedScope: selectedScope ?? null,
    participating,
    participationReady,
    participationError,
  });

  if (surface === "request_join" && access.joinableWorkspace) {
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
  if (!selectedScope) {
    return (
      <>
        <LeaderboardSetupCard
          className="mt-8"
          domain={access.domain}
          onCreate={() => setCreateWorkspaceOpen(true)}
        />
        {dialogs}
      </>
    );
  }

  if (surface === "participation_error") {
    return (
      <LeaderboardRetryCard
        className={ERROR_CARD_CHROME}
        message={t("insights.leaderboard.activationError")}
        onRetry={onRefreshParticipation}
      />
    );
  }
  if (surface === "participation_loading") {
    return (
      <section className="mt-8 flex min-h-48 items-center justify-center rounded-2xl border border-border/50 bg-card/70 text-muted-foreground dark:border-white/8">
        <Loader2 size={18} className="animate-spin" />
      </section>
    );
  }
  if (surface === "sync") {
    return (
      <LeaderboardSyncPreview
        canEnable={canJoin}
        error={participationError === "write"}
        onEnable={onJoin}
        scopeName={selectedScope.name}
        updating={participationUpdating}
      />
    );
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
      return t("insights.leaderboard.wpmValue", { count: value });
    }
    if (metric === "current_daily_streak") {
      return t("insights.leaderboard.dayValue", { count: value });
    }
    return number.format(value);
  };
  const jumpToRank = (rank: number) => {
    if (!leaderboard?.totalMembers) return;
    const resolvedRank = Math.max(1, Math.min(leaderboard.totalMembers, Math.trunc(rank) || 1));
    const targetPage = pageForRank(resolvedRank, leaderboard.totalMembers, pageSize);
    // Staying on the page renders nothing new, so the row is already there and
    // the effect that scrolls after a page load never runs.
    if (targetPage === page) {
      scrollToRank(resolvedRank);
      return;
    }
    pendingScrollRankRef.current = resolvedRank;
    setPage(targetPage);
  };
  const inviteToLeaderboard = () => {
    if (
      selectedScope.kind === "workspace" &&
      (selectedScope.role === "owner" || selectedScope.role === "admin")
    ) {
      setInviteWorkspace({ id: selectedScope.id, name: selectedScope.name });
      return;
    }
    onInvite();
  };

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-border/50 bg-card/70 dark:border-white/8">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/40 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
            {selectedScope.kind === "workspace" ? <Building2 size={16} /> : <Globe2 size={16} />}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{selectedScope.name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users size={11} />
                {t("workspaces.join.memberCount", { count: selectedScope.memberCount })}
              </span>
              <span aria-hidden="true" className="size-0.5 rounded-full bg-muted-foreground/50" />
              <span className="flex items-center gap-1">
                <Clock3 size={11} />
                {t("insights.leaderboard.refreshCadence")}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {scopeSelect}
          {!isSoloScope && (
            <Button size="sm" onClick={inviteToLeaderboard}>
              <UserPlus size={14} />
              {t("insights.leaderboard.inviteCta")}
            </Button>
          )}
          {!isSoloScope && leaderboard?.canShare && (
            <Button variant="outline-flat" size="sm" onClick={() => setShareOpen(true)}>
              <Share2 size={14} />
              {t("insights.leaderboard.share")}
            </Button>
          )}
          <Button
            variant="outline-flat"
            size="icon"
            className="size-8"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t("insights.leaderboard.refresh")}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={t("insights.leaderboard.moreActions")}
              >
                <MoreHorizontal size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              {/* The mirror of Join: publishing a name and an email must stay
                  undoable from the surface that publishes it. */}
              <DropdownMenuItem
                disabled={participationUpdating}
                className="gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
                onSelect={() =>
                  void onLeave().then((left) => {
                    if (!left) toast({ title: t("insights.leaderboard.leavePending") });
                  })
                }
              >
                <LogOut size={13} />
                {t("insights.leaderboard.leave")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {isSoloScope ? (
        <LeaderboardSoloEmptyState
          scopeKind={selectedScope.kind}
          scopeName={selectedScope.name}
          onInvite={inviteToLeaderboard}
          sync={{
            canEnable: canJoin,
            enabled: participating,
            error: participationError === "read" || participationError === "write",
            onEnable: onJoin,
            ready: participationReady,
            updating: participationUpdating,
          }}
        />
      ) : error && !leaderboard ? (
        <LeaderboardRetryCard
          message={t("insights.leaderboard.error")}
          onRetry={() => void load()}
        />
      ) : !leaderboard ? (
        <div className="flex min-h-48 items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : (
        <>
          <LeaderboardPodium
            members={leaderboard.leaders}
            formatValue={formatValue}
            metricLabel={t(`insights.leaderboard.metrics.${metric}`)}
            periodLabel={periodLabel}
            title={t("insights.leaderboard.topPerformers")}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 bg-muted/10 px-5 py-3">
            <div className="flex rounded-lg border border-border/40 bg-muted/40 p-0.5">
              {(["week", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={range === value}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30 ${
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
                  <CalendarDays size={13} className="text-muted-foreground" />
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
              <thead className="bg-muted/10">
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
                      <SelectTrigger className="ml-auto h-8 w-48 rounded-lg border border-border/40 bg-background/30 px-2.5 text-xs font-medium normal-case tracking-normal shadow-none hover:bg-muted/40">
                        <ArrowUpDown size={12} className="text-muted-foreground" />
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
                      className={cn(
                        "border-b border-border/30 transition-colors last:border-0 hover:bg-muted/20",
                        isViewer && "bg-primary/5 hover:bg-primary/7"
                      )}
                    >
                      <td className="px-5 py-3 tabular-nums">
                        <span
                          className={cn(
                            "inline-flex size-6 items-center justify-center rounded-md text-xs font-medium text-muted-foreground",
                            member.rank === 1 &&
                              "bg-amber-400/12 font-semibold text-amber-600 dark:text-amber-400",
                            member.rank === 2 && "bg-foreground/6 text-foreground/70",
                            member.rank === 3 &&
                              "bg-orange-400/10 text-orange-600 dark:text-orange-400"
                          )}
                        >
                          {member.rank}
                        </span>
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

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 bg-muted/10 px-5 py-3">
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

            {leaderboard.totalMembers > pageSize && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
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
                      setRankInput(String(page * pageSize + 1));
                      setEditingRank(true);
                    }}
                    title={t("insights.leaderboard.jumpToRank")}
                  >
                    {page * pageSize + 1}–
                    {Math.min((page + 1) * pageSize, leaderboard.totalMembers)} /{" "}
                    {leaderboard.totalMembers}
                  </button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
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
      {dialogs}
    </section>
  );
}
