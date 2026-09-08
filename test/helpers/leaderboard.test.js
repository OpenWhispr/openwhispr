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

test("leaderboard surfaces fail closed on unknown participation before scope state", async () => {
  const { resolveLeaderboardSurface } = await load();
  const access = {
    state: "create",
    scopes: [],
    domain: null,
    colleagueCount: 0,
    invitation: null,
    joinableWorkspace: null,
  };
  const scope = {
    key: "workspace:one",
    kind: "workspace",
    id: "one",
    name: "One",
    memberCount: 1,
    state: "invite",
    role: "owner",
  };
  const surface = (overrides = {}) =>
    resolveLeaderboardSurface({
      access,
      selectedScope: null,
      participating: false,
      participationReady: true,
      participationError: null,
      ...overrides,
    });

  assert.equal(surface(), "create");
  assert.equal(surface({ access: { ...access, state: "accept_invite" } }), "accept_invite");
  assert.equal(surface({ access: { ...access, state: "request_join" } }), "request_join");
  assert.equal(
    surface({ selectedScope: scope, participationReady: false }),
    "participation_loading"
  );
  assert.equal(
    surface({ selectedScope: scope, participationReady: false, participationError: "read" }),
    "participation_error"
  );
  assert.equal(
    surface({ selectedScope: { ...scope, state: "ready" }, participationReady: false }),
    "participation_loading"
  );
  assert.equal(
    surface({
      selectedScope: { ...scope, state: "ready" },
      participationReady: false,
      participationError: "read",
    }),
    "participation_error"
  );
  assert.equal(surface({ selectedScope: { ...scope, state: "ready" } }), "sync");
  assert.equal(
    surface({ selectedScope: { ...scope, state: "ready" }, participating: true }),
    "board"
  );
});

test("leaderboard request identity changes with every ranking control", async () => {
  const { leaderboardRequestKey } = await load();
  const current = leaderboardRequestKey("workspace:one", "total_words", "week", null, 0);
  assert.equal(current, leaderboardRequestKey("workspace:one", "total_words", "week", null, 0));
  for (const changed of [
    leaderboardRequestKey("workspace:two", "total_words", "week", null, 0),
    leaderboardRequestKey("workspace:one", "desktop_words", "week", null, 0),
    leaderboardRequestKey("workspace:one", "total_words", "all", null, 0),
    leaderboardRequestKey("workspace:one", "total_words", "week", "2026-08-24", 0),
    leaderboardRequestKey("workspace:one", "total_words", "week", null, 1),
  ]) {
    assert.notEqual(changed, current);
  }
});

test("workspace defaults are readable and derived only from the company domain", async () => {
  const { domainToWorkspaceName } = await load();
  assert.equal(domainToWorkspaceName("acme.com"), "Acme");
  assert.equal(domainToWorkspaceName("north-star.example.co.uk"), "North Star");
  assert.equal(domainToWorkspaceName("WWW.EXAMPLE.COM"), "Example");
  assert.equal(domainToWorkspaceName(null), "");
});

test("scope selection defaults to a membership and leaves domain-only users in the funnel", async () => {
  const { resolveLeaderboardScopeKey } = await load();
  const domain = {
    key: "domain:acme.com",
    kind: "domain",
    id: "acme.com",
    name: "acme.com",
  };
  const workspace = {
    key: "workspace:one",
    kind: "workspace",
    id: "one",
    name: "One",
  };

  assert.equal(resolveLeaderboardScopeKey([domain], null), null);
  assert.equal(resolveLeaderboardScopeKey([domain, workspace], null), workspace.key);
  assert.equal(resolveLeaderboardScopeKey([workspace, domain], domain.key), domain.key);
  assert.equal(resolveLeaderboardScopeKey([domain, workspace], null, workspace.key), workspace.key);
  assert.equal(resolveLeaderboardScopeKey([workspace], "workspace:gone"), workspace.key);
});

test("the partial-participation strip appears only while a board has at most one participant", async () => {
  const { missingLeaderboardMembers, shouldShowLeaderboardEmptyStrip } = await load();
  assert.equal(missingLeaderboardMembers(5, 1), 4);
  assert.equal(missingLeaderboardMembers(2, 5), 0);
  assert.equal(shouldShowLeaderboardEmptyStrip(5, 1), true);
  assert.equal(shouldShowLeaderboardEmptyStrip(5, 0), true);
  assert.equal(shouldShowLeaderboardEmptyStrip(5, 2), false);
  assert.equal(shouldShowLeaderboardEmptyStrip(1, 1), false);
});

test("share-card names never expose an email address", async () => {
  const { leaderboardDisplayName } = await load();
  assert.equal(
    leaderboardDisplayName({ name: "  Sam Lee  ", email: "private@acme.com" }),
    "Sam Lee"
  );
  assert.equal(leaderboardDisplayName({ name: null, email: "jane.doe+work@acme.com" }), "Jane");
  assert.equal(leaderboardDisplayName({ name: "", email: "alex-smith@acme.com" }), "Alex");
  assert.equal(leaderboardDisplayName({ name: null, email: "@acme.com" }), "Member");
});
