const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/workspaceActionsCore.ts");

// `server` is what the API holds; an API call changes it, then `failures` decides whether its
// answer reaches the caller (`lost`: it happened but the client saw an error) or it was refused.
function makeHarness({ failures = {}, lost = {}, refreshFails = false } = {}) {
  const calls = [];
  const server = {
    workspaces: ["ws-1", "ws-2"],
    roles: { "user-1": "owner", "user-2": "admin" },
  };
  // Like useWorkspaceStore: a failed refresh never rejects; it flags `error` and keeps the old list.
  const list = { workspaces: [...server.workspaces], error: false };
  let members = { ...server.roles };
  const call = (name, args, apply) => {
    calls.push([name, ...args]);
    if (failures[name]) throw failures[name];
    apply();
    if (lost[name]) throw lost[name];
  };
  const deps = {
    api: {
      removeMember: async (workspaceId, userId) =>
        call("removeMember", [workspaceId, userId], () => {
          server.workspaces = server.workspaces.filter((id) => id !== workspaceId);
        }),
      remove: async (workspaceId) =>
        call("remove", [workspaceId], () => {
          server.workspaces = server.workspaces.filter((id) => id !== workspaceId);
        }),
      updateMemberRole: async (workspaceId, userId, role) =>
        call("updateMemberRole", [workspaceId, userId, role], () => {
          server.roles = { ...server.roles, "user-1": "admin", [userId]: role };
        }),
    },
    store: {
      forgetWorkspace: (id) => {
        calls.push(["forget", id]);
        list.workspaces = list.workspaces.filter((workspaceId) => workspaceId !== id);
      },
      refresh: async (options) => {
        call("refresh", [options], () => {
          if (refreshFails) list.error = true;
          else Object.assign(list, { workspaces: [...server.workspaces], error: false });
        });
      },
      refreshMembers: async (workspaceId) =>
        call("refreshMembers", [workspaceId], () => {
          members = { ...server.roles };
        }),
      listedWorkspaceIds: () => (list.error ? null : list.workspaces),
      memberRole: (userId) => members[userId] ?? null,
    },
    sync: { requestSyncAll: (reason) => calls.push(["requestSyncAll", reason]) },
    notifyUsageChanged: () => calls.push(["usageChanged"]),
  };
  return { calls, deps, list };
}

const names = (calls) => calls.map(([name]) => name);
const FRESH = { fresh: true };

test("leave calls the API, forgets the workspace, then reads a fresh list", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness();
  await createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1");
  assert.deepEqual(calls, [
    ["removeMember", "ws-1", "user-1"],
    ["forget", "ws-1"],
    ["refresh", FRESH],
    ["usageChanged"],
    ["requestSyncAll", "manual"],
  ]);
});

test("leave succeeds even when the workspace refresh fails", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness({ failures: { refresh: new Error("offline") } });
  await createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1");
  assert.deepEqual(calls.at(-1), ["requestSyncAll", "manual"]);
  assert.ok(calls.some(([name]) => name === "refresh"));
});

test("a left workspace is gone from the list even when the refresh fails", async () => {
  const { createWorkspaceActions } = await load();
  const { deps, list } = makeHarness({ refreshFails: true });
  await createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1");
  assert.equal(list.error, true);
  assert.deepEqual(list.workspaces, ["ws-2"]);
});

test("a deleted workspace is gone from the list even when the refresh fails", async () => {
  const { createWorkspaceActions } = await load();
  const { deps, list } = makeHarness({ refreshFails: true });
  await createWorkspaceActions(deps).deleteWorkspace("ws-1");
  assert.equal(list.error, true);
  assert.deepEqual(list.workspaces, ["ws-2"]);
});

test("a refused leave only reads the list again", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("server said no");
  const { calls, deps, list } = makeHarness({ failures: { removeMember: failure } });
  await assert.rejects(createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1"), failure);
  assert.deepEqual(calls, [
    ["removeMember", "ws-1", "user-1"],
    ["refresh", FRESH],
  ]);
  assert.deepEqual(list.workspaces, ["ws-1", "ws-2"]);
});

test("a leave whose answer was lost counts as done, so Try again isn't refused", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps, list } = makeHarness({ lost: { removeMember: new Error("timed out") } });
  await createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1");
  assert.deepEqual(list.workspaces, ["ws-2"]);
  assert.deepEqual(calls.at(-1), ["requestSyncAll", "manual"]);
});

test("a failed leave stays failed when the check can't read the list", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("offline");
  const { calls, deps } = makeHarness({ failures: { removeMember: failure }, refreshFails: true });
  await assert.rejects(createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1"), failure);
  assert.equal(names(calls).includes("forget"), false);
});

test("delete follows the same order", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness();
  await createWorkspaceActions(deps).deleteWorkspace("ws-1");
  assert.deepEqual(calls, [
    ["remove", "ws-1"],
    ["forget", "ws-1"],
    ["refresh", FRESH],
    ["usageChanged"],
    ["requestSyncAll", "manual"],
  ]);
});

test("a refused delete only reads the list again", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("server said no");
  const { calls, deps } = makeHarness({ failures: { remove: failure } });
  await assert.rejects(createWorkspaceActions(deps).deleteWorkspace("ws-1"), failure);
  assert.deepEqual(names(calls), ["remove", "refresh"]);
});

test("a delete whose answer was lost counts as done", async () => {
  const { createWorkspaceActions } = await load();
  const { deps, list } = makeHarness({ lost: { remove: new Error("timed out") } });
  await createWorkspaceActions(deps).deleteWorkspace("ws-1");
  assert.deepEqual(list.workspaces, ["ws-2"]);
});

test("delete succeeds even when the workspace refresh fails", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness({ failures: { refresh: new Error("offline") } });
  await createWorkspaceActions(deps).deleteWorkspace("ws-1");
  assert.deepEqual(calls.at(-1), ["requestSyncAll", "manual"]);
});

test("transfer refreshes workspaces and members, and requests no sync", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness();
  await createWorkspaceActions(deps).transferOwnership("ws-1", "user-2");
  assert.deepEqual(calls, [
    ["updateMemberRole", "ws-1", "user-2", "owner"],
    ["refresh", FRESH],
    ["refreshMembers", "ws-1"],
  ]);
});

test("transfer succeeds even when the refreshes fail", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness({
    failures: { refresh: new Error("offline"), refreshMembers: new Error("offline") },
  });
  await createWorkspaceActions(deps).transferOwnership("ws-1", "user-2");
  assert.deepEqual(names(calls), ["updateMemberRole", "refresh", "refreshMembers"]);
});

test("a refused transfer only reads the members again", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("server said no");
  const { calls, deps } = makeHarness({ failures: { updateMemberRole: failure } });
  await assert.rejects(createWorkspaceActions(deps).transferOwnership("ws-1", "user-2"), failure);
  assert.deepEqual(calls, [
    ["updateMemberRole", "ws-1", "user-2", "owner"],
    ["refreshMembers", "ws-1"],
  ]);
});

test("a transfer whose answer was lost counts as done once the roster shows the new owner", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness({ lost: { updateMemberRole: new Error("timed out") } });
  await createWorkspaceActions(deps).transferOwnership("ws-1", "user-2");
  assert.deepEqual(names(calls), [
    "updateMemberRole",
    "refreshMembers",
    "refresh",
    "refreshMembers",
  ]);
});

test("a failed transfer stays failed when the roster can't be read", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("offline");
  const { deps } = makeHarness({
    failures: { updateMemberRole: failure, refreshMembers: new Error("offline") },
  });
  await assert.rejects(createWorkspaceActions(deps).transferOwnership("ws-1", "user-2"), failure);
});
