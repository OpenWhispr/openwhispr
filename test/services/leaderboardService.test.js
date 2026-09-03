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

// An opt-out the network never delivered has to reach the account eventually,
// and only ever in the leaving direction: the account preference is the one
// source of truth for who is on a leaderboard, so a device may take itself off
// but never put another account on.
test("a pending leave is retried for the account that asked and cleared once it lands", async (t) => {
  const requests = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { leaderboardLeavePendingUserId: "user_1" },
    window: {
      electronAPI: {
        cloudApiRequest: async (request) => {
          requests.push(request);
          return {
            success: true,
            data: { data: { configured: true, enabled: false, updatedAt: null } },
          };
        },
      },
    },
  });
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.equal(await LeaderboardService.flushPendingLeave(null), false);
  assert.equal(await LeaderboardService.flushPendingLeave("user_2"), false);
  assert.deepEqual(requests, [], "a leave another account recorded is never sent for this one");

  assert.equal(await LeaderboardService.flushPendingLeave("user_1"), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].path, "/api/analytics/participation");
  assert.deepEqual(requests[0].body, { enabled: false });
  assert.equal(storage.getItem("leaderboardLeavePendingUserId"), null);

  assert.equal(await LeaderboardService.flushPendingLeave("user_1"), false);
  assert.equal(requests.length, 1, "nothing is retried once the account has taken the leave");
});

test("a retry that fails keeps the leave pending for the next trigger", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { leaderboardLeavePendingUserId: "user_1" },
    window: {
      electronAPI: {
        cloudApiRequest: async () => ({ success: false, status: 0, error: "offline" }),
      },
    },
  });
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.equal(
    await LeaderboardService.flushPendingLeave("user_1"),
    true,
    "the caller has to know the account is still on the leaderboard the user left"
  );
  assert.equal(storage.getItem("leaderboardLeavePendingUserId"), "user_1");
});
