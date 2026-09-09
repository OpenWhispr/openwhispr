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
  domainToWorkspaceName,
  missingLeaderboardMembers,
  memberValue,
  leaderboardRequestKey,
  mergeLeaderboardWeekStarts,
  normalizeLeaderboardSelection,
  pageCount,
  pageForRank,
  resolveLeaderboardScopeKey,
  resolveLeaderboardSurface,
  shouldFetchLeaderboardWeekStarts,
  shouldShowLeaderboardEmptyStrip,
  shouldShowLeaderboardJumpToMe,
  selectionForRange,
  WEEKLY_METRICS,
  type LeaderboardWeekStartsCacheEntry,
} from "../helpers/leaderboard";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { CloudApiError } from "../services/cloudApi";
import { LeaderboardService } from "../services/LeaderboardService";
import { InvitationsService } from "../services/InvitationsService";
import { WorkspacesService } from "../services/WorkspacesService";
import { afterWorkspaceJoined } from "../services/membershipActions";
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
import LeaderboardAcceptInvitePreview from "./LeaderboardAcceptInvitePreview";
import LeaderboardEmptyStrip from "./LeaderboardEmptyStrip";
import LeaderboardPodium from "./LeaderboardPodium";
import LeaderboardSetupCard from "./LeaderboardSetupCard";
import LeaderboardShareDialog from "./LeaderboardShareDialog";
import LeaderboardSignInPreview from "./LeaderboardSignInPreview";
import LeaderboardSoloEmptyState from "./LeaderboardSoloEmptyState";
import LeaderboardWorkspaceNudge from "./LeaderboardWorkspaceNudge";
import LeaderboardJoinPreview from "./LeaderboardJoinPreview";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip } from "./ui/tooltip";
import { useToast } from "./ui/useToast";

interface LeaderboardSectionProps {
  accountId: string | null;
  authGeneration: number | null;
  isSignedIn: boolean;
  /** The account row says joined — what the roster and Leave hang on, not the device toggle. */
  participating: boolean;
  cloudAccessAllowed: boolean;
  canJoin: boolean;
  participationReady: boolean;
  participationError: "read" | "write" | null;
  participationUpdating: boolean;
  /** Removes the account from every leaderboard without changing this device's Sync setting. */
  onLeave: () => Promise<boolean>;
  onJoin: () => Promise<boolean>;
  onRefreshParticipation: () => void;
  onSignIn: () => void;
  onSsoSignIn: () => void;
  ssoActionDisabled: boolean;
  ssoRecoveryError: string | null;
  ssoStarting: boolean;
}

const ERROR_CARD_CHROME = "mt-6 rounded-2xl border border-border/50 bg-card/70 dark:border-white/8";

function LeaderboardRetryCard({
  actionLabel,
  actionDisabled = false,
  className,
  message,
  onRetry,
}: {
  actionLabel?: string;
  actionDisabled?: boolean;
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
      <Button variant="outline" size="sm" onClick={onRetry} disabled={actionDisabled}>
        {actionLabel ?? t("insights.leaderboard.retry")}
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
  authGeneration,
  isSignedIn,
  participating,
  cloudAccessAllowed,
  canJoin,
  participationReady,
  participationError,
  participationUpdating,
  onJoin,
  onLeave,
  onRefreshParticipation,
  onSignIn,
  onSsoSignIn,
  ssoActionDisabled,
  ssoRecoveryError,
  ssoStarting,
}: LeaderboardSectionProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const loaded = useWorkspaceStore((state) => state.loaded);
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [access, setAccess] = useState<LeaderboardAccess | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState<"auth" | "generic" | null>(null);
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [metric, setMetric] = useState<LeaderboardMetric>("total_words");
  const [range, setRange] = useState<LeaderboardRange>("week");
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loadedRequestKey, setLoadedRequestKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{
    kind: "auth" | "generic" | "policy" | "sso";
    requestKey: string;
  } | null>(null);
  const [requestingJoin, setRequestingJoin] = useState(false);
  const [joiningInvitation, setJoiningInvitation] = useState(false);
  const [pendingInvites, setPendingInvites] = useState<string[]>([]);
  const [pendingInviteRevision, setPendingInviteRevision] = useState(0);
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
  const participationRecoveryAttemptedRef = useRef(false);
  const skipAutomaticLoadRef = useRef<{
    authGeneration: number | null;
    requestKey: string;
  } | null>(null);
  const weekStartsCacheRef = useRef(new Map<string, LeaderboardWeekStartsCacheEntry>());
  const scopes = useMemo(() => access?.scopes ?? [], [access]);
  const selectedScope = scopes.find((scope) => scope.key === scopeKey);
  const selectedRequestKey = leaderboardRequestKey(
    selectedScope?.key ?? null,
    metric,
    range,
    weekStart,
    page
  );
  const visibleLeaderboard = loadedRequestKey === selectedRequestKey ? leaderboard : null;
  const visibleFailure = failure?.requestKey === selectedRequestKey ? failure.kind : null;
  const boardParticipantCount = visibleLeaderboard?.totalMembers ?? null;

  const loadAccess = useCallback(
    async (preferredScopeKey?: string) => {
      const requestId = ++accessRequestIdRef.current;
      if (!accountId) {
        setAccess(null);
        setAccessLoading(false);
        setAccessError(null);
        return;
      }
      if (authGeneration == null || getValidatedAuthGeneration() !== authGeneration) {
        setAccessLoading(true);
        setAccessError(null);
        return;
      }
      setAccessLoading(true);
      setAccessError(null);
      try {
        const response = await LeaderboardService.getAccess();
        if (requestId !== accessRequestIdRef.current) return;
        setAccess(response);
        setScopeKey((current) =>
          resolveLeaderboardScopeKey(response.scopes, current, preferredScopeKey)
        );
      } catch (loadError) {
        if (requestId !== accessRequestIdRef.current) return;
        console.error("Loading leaderboard access failed:", loadError);
        const requiresAccount =
          loadError instanceof CloudApiError &&
          (loadError.code === "ACCOUNT_REQUIRED" || loadError.status === 401);
        setAccessError(requiresAccount ? "auth" : "generic");
      } finally {
        if (requestId === accessRequestIdRef.current) setAccessLoading(false);
      }
    },
    [accountId, authGeneration]
  );

  useEffect(() => {
    const canListInvites =
      selectedScope?.kind === "workspace" &&
      selectedScope.state === "invite" &&
      (selectedScope.role === "owner" || selectedScope.role === "admin");
    if (!canListInvites) {
      setPendingInvites([]);
      return;
    }

    let cancelled = false;
    InvitationsService.list(selectedScope.id)
      .then((invitations) => {
        if (cancelled) return;
        const now = Date.now();
        setPendingInvites(
          invitations
            .filter(
              (invitation) =>
                !invitation.accepted_at &&
                !invitation.revoked_at &&
                new Date(invitation.expires_at).getTime() > now
            )
            .map((invitation) => invitation.email)
        );
      })
      .catch(() => {
        if (!cancelled) setPendingInvites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingInviteRevision, selectedScope]);

  useEffect(() => {
    if (isSignedIn && !loaded) void refresh();
  }, [isSignedIn, loaded, refresh]);

  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);

  useEffect(() => {
    requestIdRef.current += 1;
    participationRecoveryAttemptedRef.current = false;
    skipAutomaticLoadRef.current = null;
    setLeaderboard((current) => (current?.scope.key === scopeKey ? current : null));
    setWeekStart(null);
    setPage(0);
  }, [scopeKey]);

  useEffect(() => {
    if (!participating) {
      requestIdRef.current += 1;
      participationRecoveryAttemptedRef.current = false;
    }
  }, [participating]);

  useEffect(() => {
    participationRecoveryAttemptedRef.current = false;
    skipAutomaticLoadRef.current = null;
  }, [authGeneration]);

  useEffect(() => {
    if (cloudAccessAllowed) return;
    requestIdRef.current += 1;
    setLeaderboard(null);
    setLoadedRequestKey(null);
  }, [cloudAccessAllowed]);

  const load = useCallback(async () => {
    if (
      !cloudAccessAllowed ||
      !selectedScope ||
      selectedScope.state !== "ready" ||
      !participating ||
      !participationReady
    )
      return;
    const requestId = ++requestIdRef.current;
    const cachedWeekStarts = weekStartsCacheRef.current.get(selectedScope.key);
    const includeWeekStarts = shouldFetchLeaderboardWeekStarts(cachedWeekStarts);
    setLoading(true);
    setFailure(null);
    try {
      const response = await LeaderboardService.getLeaderboard(selectedScope, {
        metric,
        range,
        weekStart,
        includeWeekStarts,
        page,
      });
      if (requestId !== requestIdRef.current) return;
      const nextLeaderboard = includeWeekStarts
        ? response
        : {
            ...response,
            availableWeekStarts: mergeLeaderboardWeekStarts(
              response.availableWeekStarts,
              cachedWeekStarts?.values ?? []
            ),
          };
      if (includeWeekStarts) {
        weekStartsCacheRef.current.set(selectedScope.key, {
          values: response.availableWeekStarts,
          expiresAt: Date.now() + Math.max(60_000, response.refreshAfterSeconds * 1000),
        });
      }
      participationRecoveryAttemptedRef.current = false;
      const responseRequestKey = leaderboardRequestKey(
        selectedScope.key,
        metric,
        range,
        weekStart,
        response.page
      );
      setLeaderboard(nextLeaderboard);
      setLoadedRequestKey(responseRequestKey);
      if (response.page !== page) {
        skipAutomaticLoadRef.current = { authGeneration, requestKey: responseRequestKey };
        setPage(response.page);
      }
      lastLoadedAtRef.current = Date.now();
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      console.error("Loading leaderboard failed:", loadError);
      // A 403 names the gate that moved under us, and retrying the same call
      // can never clear it. Re-read exactly that gate so the surface settles on
      // the card that matches reality instead of a dead "Try again".
      const code = loadError instanceof CloudApiError ? loadError.code : undefined;
      if (code === "SSO_REQUIRED") {
        setLeaderboard(null);
        setLoadedRequestKey(null);
        setFailure({ kind: "sso", requestKey: selectedRequestKey });
        return;
      }
      if (code === "LEADERBOARD_PARTICIPATION_REQUIRED") {
        setLeaderboard(null);
        setLoadedRequestKey(null);
        if (participationRecoveryAttemptedRef.current) {
          setFailure({ kind: "generic", requestKey: selectedRequestKey });
          return;
        }
        participationRecoveryAttemptedRef.current = true;
        onRefreshParticipation();
        return;
      }
      if (code === "LEADERBOARD_DOMAIN_REQUIRED") {
        setLeaderboard(null);
        void loadAccess();
        return;
      }
      if (code === "POLICY_CLOUD_BACKUP_BLOCKED" || code === "POLICY_UNRESOLVABLE") {
        setLeaderboard(null);
        setLoadedRequestKey(null);
        setFailure({ kind: "policy", requestKey: selectedRequestKey });
        return;
      }
      if (
        code === "ACCOUNT_REQUIRED" ||
        code === "AUTH_EXPIRED" ||
        (loadError instanceof CloudApiError && loadError.status === 401)
      ) {
        setLeaderboard(null);
        setLoadedRequestKey(null);
        setFailure({ kind: "auth", requestKey: selectedRequestKey });
        return;
      }
      if (
        selectedScope.kind === "workspace" &&
        loadError instanceof CloudApiError &&
        loadError.status === 404
      ) {
        setLeaderboard(null);
        setAccess(null);
        void loadAccess();
        return;
      }
      setFailure({ kind: "generic", requestKey: selectedRequestKey });
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [
    authGeneration,
    cloudAccessAllowed,
    loadAccess,
    metric,
    onRefreshParticipation,
    page,
    participating,
    participationReady,
    range,
    selectedScope,
    selectedRequestKey,
    weekStart,
  ]);

  useEffect(() => {
    if (authGeneration == null) return;
    const skippedLoad = skipAutomaticLoadRef.current;
    skipAutomaticLoadRef.current = null;
    if (
      skippedLoad?.authGeneration === authGeneration &&
      skippedLoad.requestKey === selectedRequestKey
    )
      return;
    void load();
  }, [authGeneration, load, selectedRequestKey]);

  // The server owns how big a page is and how long a snapshot stays fresh; the
  // constants are only what to assume before the first response arrives.
  const pageSize = leaderboard?.pageSize ?? LEADERBOARD_PAGE_SIZE;
  const refreshIntervalMs = leaderboard
    ? Math.max(60_000, leaderboard.refreshAfterSeconds * 1000)
    : LEADERBOARD_REFRESH_INTERVAL_MS;

  useEffect(() => {
    if (
      !cloudAccessAllowed ||
      !selectedScope ||
      selectedScope.state !== "ready" ||
      !participating ||
      !participationReady
    )
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
  }, [
    cloudAccessAllowed,
    load,
    participating,
    participationReady,
    refreshIntervalMs,
    selectedScope,
  ]);

  const pages = pageCount(leaderboard?.totalMembers ?? 0, pageSize);
  useEffect(() => setPage((current) => Math.min(current, pages - 1)), [pages]);

  const visibleMembers = useMemo(() => visibleLeaderboard?.members ?? [], [visibleLeaderboard]);
  const isSoloScope = selectedScope?.state === "invite";
  const showJumpToMe = shouldShowLeaderboardJumpToMe(visibleLeaderboard?.totalMembers ?? 0);

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

  const acceptInvitation = async () => {
    const invitation = access?.invitation;
    if (!invitation || joiningInvitation) return;
    setJoiningInvitation(true);
    try {
      await WorkspacesService.join(invitation.workspaceId);
      await afterWorkspaceJoined();
      await loadAccess(`workspace:${invitation.workspaceId}`);
      toast({
        title: t("insights.leaderboard.inviteAcceptedTitle"),
        description: t("insights.leaderboard.inviteAcceptedDescription", {
          workspace: invitation.workspaceName,
        }),
      });
    } catch (joinError) {
      toast({
        title: t("insights.leaderboard.inviteAcceptError"),
        description: joinError instanceof Error ? joinError.message : t("common.unknownError"),
        variant: "destructive",
      });
      void loadAccess();
    } finally {
      setJoiningInvitation(false);
    }
  };

  const dialogs = (
    <>
      <CreateWorkspaceDialog
        defaultName={domainToWorkspaceName(access?.domain ?? null)}
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
          onInvited={() => {
            setPendingInviteRevision((current) => current + 1);
            void loadAccess();
          }}
        />
      )}
    </>
  );

  const showScopeSelect = scopes.length > 1 || (scopes.length === 1 && !selectedScope);
  const scopeOptions = scopes.map((scope) => (
    <SelectItem key={scope.key} value={scope.key}>
      {scope.name}
    </SelectItem>
  ));
  const scopeSelect = showScopeSelect ? (
    <Select value={selectedScope?.key} onValueChange={setScopeKey}>
      <SelectTrigger className="h-8 w-44 rounded-lg text-xs">
        <SelectValue placeholder={t("insights.leaderboard.chooseBoard")} />
      </SelectTrigger>
      <SelectContent>{scopeOptions}</SelectContent>
    </Select>
  ) : null;
  const funnelScopeSelect = scopeSelect ? (
    <div className="mt-6 flex justify-end">{scopeSelect}</div>
  ) : null;
  const funnelCardClassName = funnelScopeSelect ? "mt-4" : "mt-6";

  if (!isSignedIn) return <LeaderboardSignInPreview className="mt-6" onSignIn={onSignIn} />;
  if (accessLoading && !access) {
    return (
      <section className="mt-6 flex min-h-48 items-center justify-center rounded-2xl border border-border/50 bg-card/70 text-muted-foreground dark:border-white/8">
        <Loader2 size={18} className="animate-spin" />
      </section>
    );
  }
  if (accessError && !access) {
    return (
      <LeaderboardRetryCard
        className={ERROR_CARD_CHROME}
        actionLabel={accessError === "auth" ? t("auth.passwordForm.signInLink") : undefined}
        message={
          accessError === "auth"
            ? t("insights.leaderboard.signInDescription")
            : t("insights.leaderboard.accessError")
        }
        onRetry={accessError === "auth" ? onSignIn : () => void loadAccess()}
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
      <>
        {funnelScopeSelect}
        <LeaderboardRequestJoinPreview
          className={funnelCardClassName}
          memberCount={access.joinableWorkspace.memberCount}
          workspaceName={access.joinableWorkspace.name}
          pending={access.joinableWorkspace.requestState === "pending"}
          requesting={requestingJoin}
          onRequest={() => void requestJoin()}
        />
      </>
    );
  }
  if (surface === "accept_invite" && access.invitation) {
    return (
      <>
        {funnelScopeSelect}
        <LeaderboardAcceptInvitePreview
          className={funnelCardClassName}
          inviterName={access.invitation.inviterName}
          joining={joiningInvitation}
          onAccept={() => void acceptInvitation()}
          workspaceName={access.invitation.workspaceName}
        />
      </>
    );
  }
  if (!selectedScope) {
    return (
      <>
        {funnelScopeSelect}
        <LeaderboardSetupCard
          className={funnelCardClassName}
          colleagueCount={access.colleagueCount}
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
      <section className="mt-6 flex min-h-48 items-center justify-center rounded-2xl border border-border/50 bg-card/70 text-muted-foreground dark:border-white/8">
        <Loader2 size={18} className="animate-spin" />
      </section>
    );
  }
  if (surface === "join") {
    return (
      <LeaderboardJoinPreview
        canJoin={canJoin}
        error={participationError === "write"}
        onJoin={onJoin}
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
  const activeWeekStart = weekStart ?? visibleLeaderboard?.weekStart;
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
    if (!visibleLeaderboard?.totalMembers) return;
    const resolvedRank = Math.max(
      1,
      Math.min(visibleLeaderboard.totalMembers, Math.trunc(rank) || 1)
    );
    const targetPage = pageForRank(resolvedRank, visibleLeaderboard.totalMembers, pageSize);
    // Staying on the page renders nothing new, so the row is already there and
    // the effect that scrolls after a page load never runs.
    if (targetPage === page) {
      scrollToRank(resolvedRank);
      return;
    }
    pendingScrollRankRef.current = resolvedRank;
    setPage(targetPage);
  };
  const domainNeedsWorkspace =
    selectedScope.kind === "domain" && !scopes.some((scope) => scope.kind === "workspace");
  const inviteableWorkspace =
    selectedScope.kind === "workspace" &&
    (selectedScope.role === "owner" || selectedScope.role === "admin")
      ? selectedScope
      : selectedScope.kind === "domain"
        ? scopes.find(
            (scope) =>
              scope.kind === "workspace" && (scope.role === "owner" || scope.role === "admin")
          )
        : undefined;
  const canGrowLeaderboard = domainNeedsWorkspace || Boolean(inviteableWorkspace);
  const openLeaderboardGrowthAction = () => {
    if (domainNeedsWorkspace) {
      setCreateWorkspaceOpen(true);
      return;
    }
    if (inviteableWorkspace) {
      setInviteWorkspace({ id: inviteableWorkspace.id, name: inviteableWorkspace.name });
    }
  };
  const leaveLeaderboards = () => {
    void onLeave().then((left) => {
      if (!left) toast({ title: t("insights.leaderboard.leavePending") });
    });
  };
  const workspaceNudge =
    selectedScope.state === "ready" && access.state === "accept_invite" && access.invitation ? (
      <LeaderboardWorkspaceNudge
        kind="accept_invite"
        loading={joiningInvitation}
        onAction={() => void acceptInvitation()}
        pending={false}
        workspaceName={access.invitation.workspaceName}
      />
    ) : selectedScope.state === "ready" &&
      access.state === "request_join" &&
      access.joinableWorkspace ? (
      <LeaderboardWorkspaceNudge
        kind="request_join"
        loading={requestingJoin}
        onAction={() => void requestJoin()}
        pending={access.joinableWorkspace.requestState === "pending"}
        workspaceName={access.joinableWorkspace.name}
      />
    ) : null;

  return (
    <section
      data-leaderboard-state="board"
      className="mt-6 overflow-hidden rounded-2xl border border-border/50 bg-card/70 dark:border-white/8"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/40 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
            {selectedScope.kind === "workspace" ? <Building2 size={16} /> : <Globe2 size={16} />}
          </div>
          <div className="min-w-0">
            {showScopeSelect ? (
              <Select value={selectedScope.key} onValueChange={setScopeKey}>
                <SelectTrigger
                  className="h-auto w-auto max-w-full gap-1 rounded-md border-0 bg-transparent p-0 text-sm font-semibold shadow-none hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring dark:border-0"
                  aria-label={t("insights.leaderboard.chooseBoard")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>{scopeOptions}</SelectContent>
              </Select>
            ) : (
              <h2 className="truncate text-sm font-semibold">{selectedScope.name}</h2>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {boardParticipantCount != null && (
                <>
                  <span className="flex items-center gap-1">
                    <Users size={11} />
                    {t("workspaces.join.memberCount", { count: boardParticipantCount })}
                  </span>
                  <span
                    aria-hidden="true"
                    className="size-0.5 rounded-full bg-muted-foreground/50"
                  />
                </>
              )}
              <span className="flex items-center gap-1">
                <Clock3 size={11} />
                {t("insights.leaderboard.refreshCadence")}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {visibleLeaderboard && (
            <Select
              value={range === "all" ? "all" : activeWeekStart}
              onValueChange={(value) => {
                const nextRange: LeaderboardRange = value === "all" ? "all" : "week";
                const next = selectionForRange(metric, nextRange);
                setMetric(next.metric);
                setRange(next.range);
                setWeekStart(nextRange === "week" ? value : null);
                setPage(0);
              }}
            >
              <SelectTrigger className="h-8 w-44 rounded-lg border border-border/40 bg-background/30 px-2.5 text-xs font-medium shadow-none hover:bg-muted/40">
                <CalendarDays size={13} className="text-muted-foreground" />
                <SelectValue>
                  {range === "all"
                    ? t("insights.leaderboard.allTime")
                    : activeWeekStart
                      ? formatWeek(activeWeekStart)
                      : t("insights.leaderboard.thisWeek")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("insights.leaderboard.allTime")}</SelectItem>
                {visibleLeaderboard.availableWeekStarts.map((value, index) => (
                  <SelectItem key={value} value={value}>
                    {index === 0
                      ? `${t("insights.leaderboard.thisWeek")} · ${formatWeek(value)}`
                      : formatWeek(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
              {!isSoloScope && canGrowLeaderboard && (
                <DropdownMenuItem className="gap-2 text-xs" onSelect={openLeaderboardGrowthAction}>
                  {domainNeedsWorkspace ? <Building2 size={13} /> : <UserPlus size={13} />}
                  {t(
                    domainNeedsWorkspace
                      ? "settingsPage.workspace.empty.create"
                      : "insights.leaderboard.inviteCta"
                  )}
                </DropdownMenuItem>
              )}
              {visibleLeaderboard && (
                <DropdownMenuItem className="gap-2 text-xs" onSelect={() => setShareOpen(true)}>
                  <Share2 size={13} />
                  {t("insights.leaderboard.share")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="gap-2 text-xs"
                disabled={loading || !cloudAccessAllowed}
                onSelect={() => void load()}
              >
                <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
                {t("insights.leaderboard.refresh")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Participation remains undoable without changing this device's Sync setting. */}
              <DropdownMenuItem
                disabled={participationUpdating}
                className="gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
                onSelect={leaveLeaderboards}
              >
                <LogOut size={13} />
                {t("insights.leaderboard.leave")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {workspaceNudge}

      {surface === "board" && !cloudAccessAllowed ? (
        <div className="flex min-h-48 items-center justify-center px-5 py-10 text-center">
          <p className="text-sm font-medium">{t("insights.leaderboard.joinPolicyBlocked")}</p>
        </div>
      ) : isSoloScope ? (
        <LeaderboardSoloEmptyState
          scopeKind={selectedScope.kind}
          scopeName={selectedScope.name}
          onInvite={openLeaderboardGrowthAction}
          pendingInvites={pendingInvites}
        />
      ) : visibleFailure === "policy" && !visibleLeaderboard ? (
        <div className="flex min-h-48 items-center justify-center px-5 py-10 text-center">
          <p className="text-sm font-medium">{t("insights.leaderboard.joinPolicyBlocked")}</p>
        </div>
      ) : visibleFailure && !visibleLeaderboard ? (
        <LeaderboardRetryCard
          actionDisabled={visibleFailure === "sso" && ssoActionDisabled}
          actionLabel={
            visibleFailure === "sso"
              ? t(ssoStarting ? "auth.social.completeInBrowser" : "auth.sso.continueWithSSO")
              : visibleFailure === "auth"
                ? t("auth.passwordForm.signInLink")
                : undefined
          }
          message={
            visibleFailure === "sso"
              ? (ssoRecoveryError ?? t("auth.sso.companySignInTitle"))
              : visibleFailure === "auth"
                ? t("insights.leaderboard.signInDescription")
                : t("insights.leaderboard.error")
          }
          onRetry={
            visibleFailure === "sso"
              ? onSsoSignIn
              : visibleFailure === "auth"
                ? onSignIn
                : () => void load()
          }
        />
      ) : !visibleLeaderboard ? (
        <div className="flex min-h-48 items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : (
        <>
          {shouldShowLeaderboardEmptyStrip(
            selectedScope.memberCount,
            visibleLeaderboard.totalMembers
          ) && (
            <LeaderboardEmptyStrip
              missingCount={missingLeaderboardMembers(
                selectedScope.memberCount,
                visibleLeaderboard.totalMembers
              )}
            />
          )}
          <LeaderboardPodium
            members={visibleLeaderboard.leaders}
            formatValue={formatValue}
            metricLabel={t(`insights.leaderboard.metrics.${metric}`)}
            periodLabel={periodLabel}
            title={t("insights.leaderboard.topPerformers")}
          />

          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-muted/10">
                <tr className="border-y border-border/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="w-16 px-5 py-2.5 font-medium">
                    {t("insights.leaderboard.rank")}
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    {t("insights.leaderboard.member")}
                  </th>
                  <th scope="col" className="w-56 px-5 py-2 text-right font-medium">
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
                  const isViewer = member.userId === visibleLeaderboard.viewerUserId;
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

          {(showJumpToMe || visibleLeaderboard.totalMembers > pageSize) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 bg-muted/10 px-5 py-3">
              {showJumpToMe && (
                <Tooltip
                  content={
                    visibleLeaderboard.viewerRank !== null
                      ? t("insights.leaderboard.jumpToMe")
                      : t("insights.leaderboard.jumpUnavailable")
                  }
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={visibleLeaderboard.viewerRank === null}
                    onClick={() =>
                      visibleLeaderboard.viewerRank !== null &&
                      jumpToRank(visibleLeaderboard.viewerRank)
                    }
                  >
                    <LocateFixed size={14} />
                    {visibleLeaderboard.viewerRank !== null &&
                      `#${visibleLeaderboard.viewerRank} · `}
                    {t("insights.leaderboard.jumpToMe")}
                  </Button>
                </Tooltip>
              )}

              {visibleLeaderboard.totalMembers > pageSize && (
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
                        max={visibleLeaderboard.totalMembers}
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
                      {Math.min((page + 1) * pageSize, visibleLeaderboard.totalMembers)} /{" "}
                      {visibleLeaderboard.totalMembers}
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
          )}
        </>
      )}

      {visibleLeaderboard && (
        <LeaderboardShareDialog
          leaderboard={visibleLeaderboard}
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
