const test = require("node:test");
const assert = require("node:assert/strict");

const cache = require("../../src/lib/insightsCache.ts");

const summary = (totalWords) => ({ totalWords });
const board = (id) => ({ scope: { key: id } });

test.beforeEach(() => cache.clearInsightsCache());

test("another account never sees the previous account's answers", () => {
  cache.cacheInsightsSummary("account-1", summary(10));
  cache.cacheLeaderboardAccess("account-1", { state: "ready" });
  cache.cacheLeaderboard("account-1", "board", board("workspace:1"));

  assert.equal(cache.readCachedInsightsSummary("account-2"), null);
  assert.equal(cache.readCachedLeaderboardAccess("account-2"), null);
  assert.equal(cache.readCachedLeaderboard("account-2", "board"), undefined);
  // Reading as the next account dropped the first one's answers for good.
  assert.equal(cache.readCachedInsightsSummary("account-1"), null);
});

test("an answer is fresh for a minute after it was fetched", () => {
  cache.cacheInsightsSummary("account-1", summary(10));
  const entry = cache.readCachedInsightsSummary("account-1");

  assert.deepEqual(entry.value, summary(10));
  assert.equal(cache.isInsightFresh(entry, entry.fetchedAt + 59_999), true);
  assert.equal(cache.isInsightFresh(entry, entry.fetchedAt + 60_000), false);
  assert.equal(cache.isInsightFresh(undefined), false);
});

test("the oldest board is dropped past the cap, and rewriting a board keeps it", () => {
  for (let index = 0; index < 30; index += 1) {
    cache.cacheLeaderboard("account-1", `board-${index}`, board(String(index)));
  }
  cache.cacheLeaderboard("account-1", "board-0", board("0-again"));
  cache.cacheLeaderboard("account-1", "board-30", board("30"));

  assert.equal(cache.readCachedLeaderboard("account-1", "board-1"), undefined);
  assert.deepEqual(cache.readCachedLeaderboard("account-1", "board-0").value, board("0-again"));
  assert.deepEqual(cache.readCachedLeaderboard("account-1", "board-30").value, board("30"));
});

test("clearing leaderboards keeps the usage summary", () => {
  cache.cacheInsightsSummary("account-1", summary(10));
  cache.cacheLeaderboardAccess("account-1", { state: "ready" });
  cache.cacheLeaderboard("account-1", "board", board("workspace:1"));
  cache.cachedLeaderboardWeekStarts("account-1").set("workspace:1", {
    values: ["2026-11-09"],
    expiresAt: Number.MAX_SAFE_INTEGER,
  });

  cache.clearCachedLeaderboards();

  assert.equal(cache.readCachedLeaderboardAccess("account-1"), null);
  assert.equal(cache.readCachedLeaderboard("account-1", "board"), undefined);
  assert.equal(cache.cachedLeaderboardWeekStarts("account-1").size, 0);
  assert.deepEqual(cache.readCachedInsightsSummary("account-1").value, summary(10));
});
