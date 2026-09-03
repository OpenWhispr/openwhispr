const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

function captureRequests(t, responseData) {
  const requests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async (request) => {
          requests.push(request);
          return { success: true, data: { data: responseData } };
        },
      },
    },
  });
  return requests;
}

test("participation uses the account endpoint for both reads and sync-controlled updates", async (t) => {
  const participation = { configured: true, enabled: true, updatedAt: null };
  const requests = captureRequests(t, participation);
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.deepEqual(await LeaderboardService.getParticipation(), participation);
  assert.deepEqual(await LeaderboardService.setParticipation(false), participation);
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/api/analytics/participation",
      body: undefined,
      public: undefined,
      expectedAuthGeneration: undefined,
    },
    {
      method: "PATCH",
      path: "/api/analytics/participation",
      body: { enabled: false },
      public: undefined,
      expectedAuthGeneration: undefined,
    },
  ]);
});

test("leaderboard access uses the authoritative production endpoint", async (t) => {
  const response = { state: "upgrade", scopes: [] };
  const requests = captureRequests(t, response);
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.deepEqual(await LeaderboardService.getAccess(), response);
  assert.equal(requests[0].path, "/api/leaderboard/access");
});

test("leaderboard requests carry scope, pagination, filters and no body data", async (t) => {
  const response = { members: [] };
  const requests = captureRequests(t, response);
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.deepEqual(
    await LeaderboardService.getLeaderboard(
      {
        key: "workspace:workspace/one",
        kind: "workspace",
        id: "workspace/one",
        name: "Workspace",
        plan: "pro",
        memberCount: 2,
        canShare: false,
        state: "ready",
        role: "member",
      },
      {
        metric: "mobile_words",
        range: "week",
        weekStart: "2026-08-31",
        timeZone: "Asia/Kolkata",
        page: 2,
      }
    ),
    response
  );
  assert.equal(requests[0].method, "GET");
  assert.equal(
    requests[0].path,
    "/api/workspaces/workspace%2Fone/leaderboard?metric=mobile_words&range=week&timeZone=Asia%2FKolkata&page=2&weekStart=2026-08-31"
  );
  assert.equal(requests[0].body, undefined);

  await LeaderboardService.getLeaderboard(
    {
      key: "domain:acme.test",
      kind: "domain",
      id: "acme.test",
      name: "acme.test",
      plan: "business",
      memberCount: 3,
      canShare: true,
      state: "ready",
      role: null,
    },
    {
      metric: "total_words",
      range: "all",
      timeZone: "UTC",
      page: 0,
    }
  );
  assert.equal(
    requests[1].path,
    "/api/leaderboard/domain?metric=total_words&range=all&timeZone=UTC&page=0"
  );
});
