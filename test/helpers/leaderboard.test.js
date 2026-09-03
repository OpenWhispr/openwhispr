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

test("configured account participation wins over a new device default", async () => {
  const { reconcileLeaderboardParticipation } = await load();
  assert.deepEqual(
    reconcileLeaderboardParticipation(
      { configured: true, enabled: true, updatedAt: "2026-09-03T00:00:00.000Z" },
      false
    ),
    { enabled: true, publish: null }
  );
  assert.deepEqual(
    reconcileLeaderboardParticipation({ configured: false, enabled: false, updatedAt: null }, true),
    { enabled: true, publish: true }
  );
});
