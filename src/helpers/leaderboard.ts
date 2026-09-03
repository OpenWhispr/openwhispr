import type {
  AnalyticsParticipation,
  LeaderboardMetric,
  LeaderboardRange,
} from "../types/electron";

export const LEADERBOARD_PAGE_SIZE = 20;
export const LEADERBOARD_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function normalizeLeaderboardSelection(
  metric: LeaderboardMetric,
  range: LeaderboardRange
): { metric: LeaderboardMetric; range: LeaderboardRange } {
  if (metric === "words_per_minute" || metric === "current_daily_streak") {
    return { metric, range: "all" };
  }
  return { metric, range };
}

export function selectionForRange(
  metric: LeaderboardMetric,
  range: LeaderboardRange
): { metric: LeaderboardMetric; range: LeaderboardRange } {
  if (range === "week" && (metric === "words_per_minute" || metric === "current_daily_streak")) {
    return { metric: "total_words", range };
  }
  return { metric, range };
}

export function pageForRank(rank: number, memberCount: number): number {
  if (memberCount <= 0) return 0;
  const clampedRank = Math.max(1, Math.min(memberCount, Math.trunc(rank) || 1));
  return Math.floor((clampedRank - 1) / LEADERBOARD_PAGE_SIZE);
}

export function pageCount(memberCount: number): number {
  return Math.max(1, Math.ceil(memberCount / LEADERBOARD_PAGE_SIZE));
}

export function reconcileLeaderboardParticipation(
  participation: AnalyticsParticipation,
  localSyncEnabled: boolean
): { enabled: boolean; publish: boolean | null } {
  if (participation.configured) {
    return { enabled: participation.enabled, publish: null };
  }
  return {
    enabled: localSyncEnabled,
    publish: localSyncEnabled ? true : null,
  };
}
