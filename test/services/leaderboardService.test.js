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

const pendingKey = (userId) => `leaderboardLeavePending:${encodeURIComponent(userId)}`;
const pendingUserIds = (storage) =>
  ["user_1", "user_2"].filter((userId) => storage.getItem(pendingKey(userId)) === "true");

async function validateAuthContext(userId = "user_1", authGeneration = 7, reset = true) {
  const auth = require("../../src/lib/authRequestContext.ts");
  if (reset) auth.resetAuthRequestContextForTests();
  const token = `token-${userId}-${authGeneration}`;
  global.window.location ??= { origin: "https://desktop.openwhispr.test" };
  global.window.electronAPI.authGetTokenState = async () => ({ token, generation: authGeneration });
  await auth.handleAuthRequestSuccess({
    data: { user: { id: userId } },
    response: new Response("{}", { status: 200 }),
    request: {
      url: "https://auth.openwhispr.test/api/auth/get-session",
      headers: new Headers({ Authorization: `Bearer ${token}` }),
      openWhisprAuthGeneration: authGeneration,
    },
  });
  assert.equal(auth.commitValidatedAuthContext(authGeneration, userId), true);
  return { userId, authGeneration };
}

test("participation uses the account endpoint for reads, joins, and leaves", async (t) => {
  const participation = { configured: true, enabled: true, updatedAt: null };
  const requests = captureRequests(t, participation);
  const context = await validateAuthContext();
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.deepEqual(await LeaderboardService.getParticipation(context), participation);
  assert.deepEqual(await LeaderboardService.joinParticipation(context), participation);
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/api/analytics/participation",
      body: undefined,
      public: false,
      expectedAuthGeneration: 7,
    },
    {
      method: "PATCH",
      path: "/api/analytics/participation",
      body: { enabled: true },
      public: false,
      expectedAuthGeneration: 7,
    },
  ]);
});

test("leaderboard access uses the authoritative production endpoint", async (t) => {
  const response = {
    state: "create",
    scopes: [],
    domain: null,
    colleagueCount: 0,
    invitation: null,
    joinableWorkspace: null,
  };
  const requests = captureRequests(t, response);
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.deepEqual(await LeaderboardService.getAccess(), response);
  assert.equal(requests[0].path, "/api/leaderboard/access");
});

test("a pre-leaderboard API preserves legacy Insights sync as unconfigured", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async () => ({ success: false, status: 404, error: "Not found" }),
      },
    },
  });
  const context = await validateAuthContext();
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.deepEqual(await LeaderboardService.getParticipation(context), {
    configured: false,
    enabled: false,
    updatedAt: null,
  });
});

test("leaderboard services reject malformed success payloads", async (t) => {
  captureRequests(t, { state: "ready" });
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  await assert.rejects(LeaderboardService.getAccess(), /Malformed leaderboard access/);
});

test("leaderboard requests carry scope, pagination, filters and no body data", async (t) => {
  const response = {
    scope: {
      key: "workspace:workspace/one",
      kind: "workspace",
      id: "workspace/one",
      name: "Workspace",
    },
    viewerUserId: "user_1",
    metric: "mobile_words",
    range: "week",
    weekStart: "2026-08-31",
    availableWeekStarts: ["2026-08-31"],
    leaders: [],
    members: [],
    totalMembers: 0,
    viewerRank: null,
    page: 0,
    pageSize: 20,
    generatedAt: "2026-09-09T00:00:00.000Z",
    refreshAfterSeconds: 3600,
  };
  const requests = captureRequests(t, response);
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.deepEqual(
    await LeaderboardService.getLeaderboard(
      {
        key: "workspace:workspace/one",
        kind: "workspace",
        id: "workspace/one",
        name: "Workspace",
        memberCount: 2,
        state: "ready",
        role: "member",
      },
      {
        metric: "mobile_words",
        range: "week",
        weekStart: "2026-08-31",
        page: 2,
      }
    ),
    response
  );
  assert.equal(requests[0].method, "GET");
  assert.equal(
    requests[0].path,
    "/api/workspaces/workspace%2Fone/leaderboard?metric=mobile_words&range=week&page=2&weekStart=2026-08-31"
  );
  assert.equal(requests[0].body, undefined);

  await LeaderboardService.getLeaderboard(
    {
      key: "domain:acme.test",
      kind: "domain",
      id: "acme.test",
      name: "acme.test",
      memberCount: 3,
      state: "ready",
      role: null,
    },
    {
      metric: "total_words",
      range: "all",
      includeWeekStarts: false,
      page: 0,
    }
  );
  assert.equal(
    requests[1].path,
    "/api/leaderboard/domain?metric=total_words&range=all&page=0&includeWeekStarts=false"
  );
});

// An opt-out the network never delivered has to reach the account eventually,
// and only ever in the leaving direction: the account preference is the one
// source of truth for who is on a leaderboard, so a device may take itself off
// but never put another account on.
test("a pending leave is retried for the account that asked and cleared once it lands", async (t) => {
  const requests = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { [pendingKey("user_1")]: "true", [pendingKey("user_2")]: "true" },
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
  const user1 = await validateAuthContext();
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  const user3 = { userId: "user_3", authGeneration: user1.authGeneration };
  await assert.rejects(LeaderboardService.flushPendingLeave(user3), {
    code: "AUTH_CONTEXT_CHANGED",
  });
  assert.deepEqual(requests, [], "a leave another account recorded is never sent for this one");

  assert.equal(await LeaderboardService.flushPendingLeave(user1), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].path, "/api/analytics/participation");
  assert.deepEqual(requests[0].body, { enabled: false });
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_2"],
    "one account taking its leave must not discard another account's"
  );

  assert.equal(await LeaderboardService.flushPendingLeave(user1), false);
  assert.equal(requests.length, 1, "nothing is retried once the account has taken the leave");
});

test("a retry that fails keeps the leave pending for the next trigger", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { [pendingKey("user_1")]: "true", [pendingKey("user_2")]: "true" },
    window: {
      electronAPI: {
        cloudApiRequest: async () => ({ success: false, status: 0, error: "offline" }),
      },
    },
  });
  const context = await validateAuthContext();
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  assert.equal(
    await LeaderboardService.flushPendingLeave(context),
    true,
    "the caller has to know the account is still on the leaderboard the user left"
  );
  assert.deepEqual(pendingUserIds(storage), ["user_1", "user_2"]);
});

test("an explicit join stays newer than a pending leave already in flight", async (t) => {
  const requests = [];
  let serverEnabled = true;
  let releasePendingLeave;
  let markLeaveStarted;
  const pendingLeaveStarted = new Promise((resolve) => {
    markLeaveStarted = resolve;
  });
  const pendingLeaveResponse = new Promise((resolve) => {
    releasePendingLeave = resolve;
  });
  t.after(() => releasePendingLeave());
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { [pendingKey("user_1")]: "true" },
    window: {
      electronAPI: {
        cloudApiRequest: async (request) => {
          requests.push(request);
          if (request.method === "PATCH") {
            if (request.body.enabled === false) {
              markLeaveStarted();
              await pendingLeaveResponse;
            }
            serverEnabled = request.body.enabled;
          }
          return {
            success: true,
            data: {
              data: { configured: true, enabled: serverEnabled, updatedAt: null },
            },
          };
        },
      },
    },
  });
  const context = await validateAuthContext();
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  const flush = LeaderboardService.flushPendingLeave(context);
  await pendingLeaveStarted;
  const join = LeaderboardService.joinParticipation(context);
  const reconciliation = flush.then(() => LeaderboardService.getParticipation(context));
  await Promise.resolve();
  assert.deepEqual(
    requests.map((request) => request.body),
    [{ enabled: false }],
    "the newer join must wait rather than race the in-flight leave"
  );

  releasePendingLeave();
  const [, joined, reconciled] = await Promise.all([flush, join, reconciliation]);
  assert.deepEqual(
    requests.map(({ method, body }) => ({ method, body })),
    [
      { method: "PATCH", body: { enabled: false } },
      { method: "PATCH", body: { enabled: true } },
      { method: "GET", body: undefined },
    ]
  );
  assert.equal(joined.enabled, true);
  assert.equal(reconciled.enabled, true);
  assert.equal(serverEnabled, true);
  assert.deepEqual(pendingUserIds(storage), []);
});

test("a queued participation write cannot adopt a replacement account's auth", async (t) => {
  const requests = [];
  let releasePendingLeave;
  let markLeaveStarted;
  const pendingLeaveStarted = new Promise((resolve) => {
    markLeaveStarted = resolve;
  });
  const pendingLeaveResponse = new Promise((resolve) => {
    releasePendingLeave = resolve;
  });
  t.after(() => releasePendingLeave());
  installBrowserGlobals(t, {
    initialStorage: { [pendingKey("user_1")]: "true" },
    window: {
      electronAPI: {
        cloudApiRequest: async (request) => {
          requests.push(request);
          markLeaveStarted();
          await pendingLeaveResponse;
          return {
            success: true,
            data: { data: { configured: true, enabled: false, updatedAt: null } },
          };
        },
      },
    },
  });
  const user1 = await validateAuthContext();
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  const flush = LeaderboardService.flushPendingLeave(user1);
  await pendingLeaveStarted;
  const staleJoin = LeaderboardService.joinParticipation(user1);
  await validateAuthContext("user_2", 8, false);
  releasePendingLeave();

  assert.equal(await flush, false);
  await assert.rejects(staleJoin, { code: "AUTH_CONTEXT_CHANGED" });
  assert.deepEqual(
    requests.map(({ method, body, expectedAuthGeneration }) => ({
      method,
      body,
      expectedAuthGeneration,
    })),
    [{ method: "PATCH", body: { enabled: false }, expectedAuthGeneration: 7 }],
    "the queued user_1 join must be rejected before it can use user_2's credential"
  );
});

test("a leave queued across an auth switch remains pending for its original account", async (t) => {
  const requests = [];
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readResponse = new Promise((resolve) => {
    releaseRead = resolve;
  });
  t.after(() => releaseRead());
  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async (request) => {
          requests.push(request);
          markReadStarted();
          await readResponse;
          return {
            success: true,
            data: { data: { configured: true, enabled: true, updatedAt: null } },
          };
        },
      },
    },
  });
  const user1 = await validateAuthContext();
  const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

  const read = LeaderboardService.getParticipation(user1);
  await readStarted;
  const staleLeave = LeaderboardService.leaveParticipation(user1);
  assert.deepEqual(pendingUserIds(storage), ["user_1"]);
  await validateAuthContext("user_2", 8, false);
  releaseRead();

  await read;
  await assert.rejects(staleLeave, { code: "AUTH_CONTEXT_CHANGED" });
  assert.deepEqual(
    requests.map(({ method, body, expectedAuthGeneration }) => ({
      method,
      body,
      expectedAuthGeneration,
    })),
    [{ method: "GET", body: undefined, expectedAuthGeneration: 7 }],
    "the queued user_1 leave must not be sent with user_2's credential"
  );
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_1"],
    "the fenced leave must retry when user_1 has a validated credential again"
  );
});
