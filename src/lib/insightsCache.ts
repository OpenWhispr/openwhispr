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
let insightsCacheVersion = 0;
let leaderboardCacheVersion = 0;
type CacheInvalidation = "all" | "leaderboards";
const invalidationListeners = new Set<(scope: CacheInvalidation) => void>();

export function subscribeToInsightsCacheInvalidation(listener: (scope: CacheInvalidation) => void) {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

function forAccount(accountId: string): AccountInsights {
  if (current?.accountId !== accountId) {
    insightsCacheVersion += 1;
    leaderboardCacheVersion += 1;
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

export function getInsightsCacheVersion(accountId: string): number {
  forAccount(accountId);
  return insightsCacheVersion;
}

export function isInsightsCacheCurrent(accountId: string, version: number): boolean {
  return current?.accountId === accountId && insightsCacheVersion === version;
}

export function getLeaderboardCacheVersion(accountId: string): number {
  forAccount(accountId);
  return leaderboardCacheVersion;
}

export function isLeaderboardCacheCurrent(accountId: string, version: number): boolean {
  return current?.accountId === accountId && leaderboardCacheVersion === version;
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

/**
 * For Refresh, a refused board, and anything that can move a roster or the
 * boards the account sees: joining or leaving the leaderboard, creating,
 * joining, leaving or deleting a workspace, and a join request.
 */
export function clearCachedLeaderboards({
  revalidate = true,
}: { revalidate?: boolean } = {}): void {
  leaderboardCacheVersion += 1;
  if (current) {
    current.access = null;
    current.leaderboards.clear();
    current.weekStarts.clear();
  }
  // A refusal already chooses its recovery UI; external changes need a new read.
  if (revalidate) invalidationListeners.forEach((listener) => listener("leaderboards"));
}

export function clearInsightsCache(): void {
  insightsCacheVersion += 1;
  leaderboardCacheVersion += 1;
  current = null;
  invalidationListeners.forEach((listener) => listener("all"));
}
