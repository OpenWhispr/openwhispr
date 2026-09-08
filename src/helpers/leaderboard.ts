import type {
  LeaderboardAccess,
  LeaderboardAccessScope,
  LeaderboardMember,
  LeaderboardMetric,
  LeaderboardRange,
} from "../types/electron";

// Fallbacks only: a loaded leaderboard carries the page size and refresh window
// the server actually used, and those win over these.
export const LEADERBOARD_PAGE_SIZE = 20;
export const LEADERBOARD_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const LEADERBOARD_SHARE_MEMBER_LIMIT = 3;

// Which metrics a week can rank is one fact: the weekly ones are what the
// picker offers under "This week", and the lifetime ones are what forces a
// selection over to "All time".
export const WEEKLY_METRICS: LeaderboardMetric[] = ["total_words", "desktop_words", "mobile_words"];
const LIFETIME_METRICS: LeaderboardMetric[] = ["words_per_minute", "current_daily_streak"];
export const ALL_TIME_METRICS: LeaderboardMetric[] = [...WEEKLY_METRICS, ...LIFETIME_METRICS];

export type LeaderboardSurface =
  | "accept_invite"
  | "request_join"
  | "create"
  | "invite"
  | "participation_loading"
  | "participation_error"
  | "sync"
  | "board";

export function resolveLeaderboardSurface({
  access,
  selectedScope,
  participating,
  participationReady,
  participationError,
}: {
  access: LeaderboardAccess;
  selectedScope: LeaderboardAccessScope | null;
  participating: boolean;
  participationReady: boolean;
  participationError: "read" | "write" | null;
}): LeaderboardSurface {
  if (access.state === "accept_invite" || access.state === "request_join") return access.state;
  if (!selectedScope) {
    return "create";
  }
  if (!participationReady) {
    return participationError === "read" ? "participation_error" : "participation_loading";
  }
  if (selectedScope.state === "invite") return "invite";
  return participating ? "board" : "sync";
}

export function leaderboardRequestKey(
  scopeKey: string | null,
  metric: LeaderboardMetric,
  range: LeaderboardRange,
  weekStart: string | null,
  page: number
): string {
  return JSON.stringify([scopeKey, metric, range, weekStart, page]);
}

export function domainToWorkspaceName(domain: string | null): string {
  if (!domain) return "";
  const label =
    domain
      .trim()
      .toLowerCase()
      .replace(/^www\./, "")
      .split(".")[0] ?? "";
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function resolveLeaderboardScopeKey(
  scopes: LeaderboardAccessScope[],
  currentScopeKey: string | null,
  preferredScopeKey?: string
): string | null {
  if (preferredScopeKey && scopes.some((scope) => scope.key === preferredScopeKey)) {
    return preferredScopeKey;
  }
  if (currentScopeKey && scopes.some((scope) => scope.key === currentScopeKey)) {
    return currentScopeKey;
  }
  return (
    scopes.find((scope) => scope.kind === "workspace")?.key ??
    scopes.find((scope) => scope.state === "ready")?.key ??
    null
  );
}

export function missingLeaderboardMembers(memberCount: number, participantCount: number): number {
  return Math.max(0, memberCount - participantCount);
}

export function shouldShowLeaderboardEmptyStrip(
  memberCount: number,
  participantCount: number
): boolean {
  return participantCount <= 1 && missingLeaderboardMembers(memberCount, participantCount) > 0;
}

export function shouldShowLeaderboardJumpToMe(memberCount: number): boolean {
  return memberCount >= 10;
}

export function leaderboardDisplayName(member: Pick<LeaderboardMember, "name" | "email">): string {
  const name = member.name?.trim();
  if (name) return name;
  const localPart = member.email.split("@")[0] ?? "";
  const firstToken = localPart.split(/[._+-]+/).find(Boolean) ?? "";
  return firstToken ? `${firstToken.charAt(0).toUpperCase()}${firstToken.slice(1)}` : "Member";
}

export function normalizeLeaderboardSelection(
  metric: LeaderboardMetric,
  range: LeaderboardRange
): { metric: LeaderboardMetric; range: LeaderboardRange } {
  if (LIFETIME_METRICS.includes(metric)) {
    return { metric, range: "all" };
  }
  return { metric, range };
}

export function selectionForRange(
  metric: LeaderboardMetric,
  range: LeaderboardRange
): { metric: LeaderboardMetric; range: LeaderboardRange } {
  if (range === "week" && LIFETIME_METRICS.includes(metric)) {
    return { metric: "total_words", range };
  }
  return { metric, range };
}

export function memberValue(member: LeaderboardMember, metric: LeaderboardMetric): number | null {
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

export function pageForRank(
  rank: number,
  memberCount: number,
  pageSize: number = LEADERBOARD_PAGE_SIZE
): number {
  if (memberCount <= 0) return 0;
  const clampedRank = Math.max(1, Math.min(memberCount, Math.trunc(rank) || 1));
  return Math.floor((clampedRank - 1) / pageSize);
}

export function pageCount(memberCount: number, pageSize: number = LEADERBOARD_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(memberCount / pageSize));
}
