import type { LeaderboardMember, LeaderboardMetric, LeaderboardRange } from "../types/electron";

// Fallbacks only: a loaded leaderboard carries the page size and refresh window
// the server actually used, and those win over these.
export const LEADERBOARD_PAGE_SIZE = 20;
export const LEADERBOARD_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// Which metrics a week can rank is one fact: the weekly ones are what the
// picker offers under "This week", and the lifetime ones are what forces a
// selection over to "All time".
export const WEEKLY_METRICS: LeaderboardMetric[] = ["total_words", "desktop_words", "mobile_words"];
const LIFETIME_METRICS: LeaderboardMetric[] = ["words_per_minute", "current_daily_streak"];
export const ALL_TIME_METRICS: LeaderboardMetric[] = [...WEEKLY_METRICS, ...LIFETIME_METRICS];

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
