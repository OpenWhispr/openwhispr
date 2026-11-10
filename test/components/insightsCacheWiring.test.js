const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (relativePath) => readFileSync(join(__dirname, "../..", relativePath), "utf8");

// Reopening Insights paints what this session already fetched. What it must
// never do is hide a newer answer the user asked for, or keep a board a gate
// has since refused.
test("the leaderboard paints a kept board first and never keeps one a gate refused", () => {
  const section = read("src/components/LeaderboardSection.tsx");
  const load = section.slice(section.indexOf("const load = useCallback"));

  assert.ok(
    load.indexOf("readCachedLeaderboard(accountId, selectedRequestKey)") <
      load.indexOf("LeaderboardService.getLeaderboard("),
    "a kept board is shown before the request goes out"
  );
  assert.ok(
    load.includes("if (isInsightFresh(cachedBoard)) {") &&
      load.indexOf("setLoading(false);", load.indexOf("if (isInsightFresh(cachedBoard)) {")) <
        load.indexOf("LeaderboardService.getLeaderboard("),
    "a fresh kept board settles the spinner of the load it retired"
  );
  assert.ok(load.includes("cacheLeaderboard(accountId, responseRequestKey, nextLeaderboard)"));
  assert.ok(
    load.includes(
      "loadError.status >= 400 && loadError.status < 500)\n        clearCachedLeaderboards();"
    ),
    "a refused board clears every kept board and access answer"
  );
  assert.ok(
    section.includes("clearCachedLeaderboards();\n                  void load();"),
    "Refresh asks the cloud rather than the kept board"
  );
  assert.ok(section.includes("cacheLeaderboardAccess(accountId, response);"));
  // A session that validates after mount skips the read, so the kept answer has
  // to reach the screen there, or the Sign-in card set by the first pass stays up.
  const skip = section.slice(section.indexOf("if (cached && isInsightFresh(cached)) {"));
  assert.ok(skip.indexOf("setAccess(cached.value);") < skip.indexOf("return;"));
  assert.ok(skip.indexOf("setAccessError(null);") < skip.indexOf("return;"));
});

test("joining, leaving or deleting a workspace drops the kept leaderboards", () => {
  assert.ok(read("src/services/workspaceActions.ts").includes("clearCachedLeaderboards();"));
  assert.ok(read("src/services/membershipActions.ts").includes("clearCachedLeaderboards();"));
  assert.ok(read("src/stores/workspaceStore.ts").includes("clearCachedLeaderboards();"));
  const section = read("src/components/LeaderboardSection.tsx");
  const requestJoin = section.slice(section.indexOf("const requestJoin = async"));
  assert.ok(
    requestJoin.indexOf("clearCachedLeaderboards();") <
      requestJoin.indexOf("setAccess((current) =>"),
    "a join request changes the access answer a reopened Insights would show"
  );
});

test("Your usage skips only a check for remote changes while its summary is fresh", () => {
  const view = read("src/components/InsightsView.tsx");

  assert.ok(
    view.includes(
      "if (!dataChanged && accountId && isInsightFresh(readCachedInsightsSummary(accountId)))"
    ),
    "a dictation always reloads; focus and the interval wait out a fresh summary"
  );
  assert.ok(view.includes("if (accountId) cacheInsightsSummary(accountId, account);"));
});
