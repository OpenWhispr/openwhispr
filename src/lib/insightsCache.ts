import type { AnalyticsSummary, Leaderboard, LeaderboardAccess } from "../types/electron";
import type { LeaderboardWeekStartsCacheEntry } from "../helpers/leaderboard";

// The last Insights answers for the signed-in account, kept while the app runs
// so reopening Insights paints at once instead of waiting on the cloud. Memory
// only: boards carry coworkers' names and addresses, and a different account
// starts from nothing.
const INSIGHTS_CACHE_FRESH_MS = 60_000;
const MAX_CACHED_LEADERBOARDS = 30;

interface CachedInsight<T> {
  value: T;
  fetchedAt: number;
}

interface AccountInsights {
  accountId: string;
  summary: CachedInsight<AnalyticsSummary> | null;
  access: CachedInsight<LeaderboardAccess> | null;
  leaderboards: Map<string, CachedInsight<Leaderboard>>;
  weekStarts: Map<string, LeaderboardWeekStartsCacheEntry>;
}

let current: AccountInsights | null = null;

function forAccount(accountId: string): AccountInsights {
  if (current?.accountId !== accountId) {
    current = {
      accountId,
      summary: null,
      access: null,
      leaderboards: new Map(),
      weekStarts: new Map(),
    };
  }
  return current;
}

const cached = <T>(value: T): CachedInsight<T> => ({ value, fetchedAt: Date.now() });

export function isInsightFresh(
  entry: CachedInsight<unknown> | null | undefined,
  now: number = Date.now()
): boolean {
  return entry != null && now - entry.fetchedAt < INSIGHTS_CACHE_FRESH_MS;
}

export function readCachedInsightsSummary(accountId: string) {
  return forAccount(accountId).summary;
}

export function cacheInsightsSummary(accountId: string, summary: AnalyticsSummary): void {
  forAccount(accountId).summary = cached(summary);
}

export function readCachedLeaderboardAccess(accountId: string) {
  return forAccount(accountId).access;
}

export function cacheLeaderboardAccess(accountId: string, access: LeaderboardAccess): void {
  forAccount(accountId).access = cached(access);
}

export function readCachedLeaderboard(accountId: string, requestKey: string) {
  return forAccount(accountId).leaderboards.get(requestKey);
}

export function cacheLeaderboard(
  accountId: string,
  requestKey: string,
  leaderboard: Leaderboard
): void {
  const { leaderboards } = forAccount(accountId);
  // Re-inserting moves the key to the end, so the first key is the oldest write.
  leaderboards.delete(requestKey);
  leaderboards.set(requestKey, cached(leaderboard));
  if (leaderboards.size > MAX_CACHED_LEADERBOARDS) {
    leaderboards.delete(leaderboards.keys().next().value!);
  }
}

export function cachedLeaderboardWeekStarts(accountId: string) {
  return forAccount(accountId).weekStarts;
}

/** Joining or leaving changes every roster, and a refused board says the access answer moved. */
export function clearCachedLeaderboards(): void {
  if (!current) return;
  current.access = null;
  current.leaderboards.clear();
  current.weekStarts.clear();
}

export function clearInsightsCache(): void {
  current = null;
}
