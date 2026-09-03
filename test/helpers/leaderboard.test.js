const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/leaderboard.ts");

test("lifetime metrics force all time and weekly selection hides them", async () => {
  const { normalizeLeaderboardSelection, selectionForRange } = await load();
  assert.deepEqual(normalizeLeaderboardSelection("words_per_minute", "week"), {
    metric: "words_per_minute",
    range: "all",
  });
  assert.deepEqual(selectionForRange("current_daily_streak", "week"), {
    metric: "total_words",
    range: "week",
  });
  assert.deepEqual(normalizeLeaderboardSelection("mobile_words", "week"), {
    metric: "mobile_words",
    range: "week",
  });
});

// The picker's two tiers and the rules that move a selection between them are
// one fact, so a metric offered under "This week" must survive that range.
test("the metric tiers agree with the selection rules", async () => {
  const { ALL_TIME_METRICS, WEEKLY_METRICS, normalizeLeaderboardSelection, selectionForRange } =
    await load();
  assert.deepEqual(WEEKLY_METRICS, ["total_words", "desktop_words", "mobile_words"]);
  assert.deepEqual(ALL_TIME_METRICS, [
    ...WEEKLY_METRICS,
    "words_per_minute",
    "current_daily_streak",
  ]);
  for (const metric of WEEKLY_METRICS) {
    assert.deepEqual(normalizeLeaderboardSelection(metric, "week"), { metric, range: "week" });
    assert.deepEqual(selectionForRange(metric, "week"), { metric, range: "week" });
  }
  for (const metric of ALL_TIME_METRICS.filter((value) => !WEEKLY_METRICS.includes(value))) {
    assert.equal(normalizeLeaderboardSelection(metric, "week").range, "all");
    assert.equal(selectionForRange(metric, "week").metric, "total_words");
  }
});

test("rank jumps and pagination clamp safely at 20 rows per page", async () => {
  const { LEADERBOARD_PAGE_SIZE, pageCount, pageForRank } = await load();
  assert.equal(LEADERBOARD_PAGE_SIZE, 20);
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(20), 1);
  assert.equal(pageCount(21), 2);
  assert.equal(pageForRank(1, 55), 0);
  assert.equal(pageForRank(20, 55), 0);
  assert.equal(pageForRank(21, 55), 1);
  assert.equal(pageForRank(10_000, 55), 2);
});

// The response carries the page size the server actually used, so a server that
// pages differently must not send jump-to-rank to the wrong page.
test("pagination follows the page size the response reports", async () => {
  const { pageCount, pageForRank } = await load();
  assert.equal(pageCount(55, 10), 6);
  assert.equal(pageForRank(21, 55, 10), 2);
  assert.equal(pageForRank(55, 55, 50), 1);
});
