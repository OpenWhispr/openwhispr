const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/connectorIpc.js");

const SCOPE = { accountId: "account-a", authGeneration: 3 };
const ALLOWED = { policyState: "allowed", accountId: "account-a" };

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler) };
}

function fakeManager() {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push({ name, args });
      return { ok: name };
    };
  return {
    calls,
    status: record("status"),
    prepare: record("prepare"),
    commit: record("commit"),
    cancel: (...args) => {
      calls.push({ name: "cancel", args });
      return { cancelled: false };
    },
    runDirect: record("runDirect"),
    recentActions: record("recentActions"),
  };
}

test("each channel reaches the manager, with policy only where something can leave", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const manager = fakeManager();
  const policyCalls = [];
  registerConnectorIpc({
    ipcMain,
    manager,
    getPolicyState: async (event) => {
      policyCalls.push(event);
      return "allowed";
    },
    getAccountScope: () => SCOPE,
  });
  const event = { sender: "renderer-1" };
  const h = (channel) => ipcMain.handlers.get(channel);

  await h("connector-status")(event);
  await h("connector-prepare")(event, "slack", "send_message", { text: "hi" });
  await h("connector-commit")(event, "action-1", { body: "hi!" });
  await h("connector-cancel")(event, "action-1", "cancelled_by_user");
  await h("connector-run-direct")(event, "email", "draft", { to: ["a@b.co"] });
  await h("connector-recent-actions")(event, "email", 5);

  assert.deepEqual(
    manager.calls.map((call) => call.name),
    ["status", "prepare", "commit", "cancel", "runDirect", "recentActions"]
  );
  assert.deepEqual(manager.calls[1].args, ["slack", "send_message", { text: "hi" }, ALLOWED]);
  assert.deepEqual(manager.calls[2].args, ["action-1", { body: "hi!" }, ALLOWED]);
  const [connectorId, action, args, auth, runtime] = manager.calls[4].args;
  assert.deepEqual(
    [connectorId, action, args, auth],
    ["email", "draft", { to: ["a@b.co"] }, ALLOWED]
  );
  assert.equal(runtime.webContents, "renderer-1");
  assert.equal(runtime.signal.aborted, false);
  assert.deepEqual(manager.calls[5].args, ["email", 5, "account-a"]);
  assert.equal(policyCalls.length, 3);
});

test("a cancel that lands while a direct run waits on policy stops it", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const manager = fakeManager();
  const policyWaits = [];
  registerConnectorIpc({
    ipcMain,
    manager,
    getPolicyState: () => new Promise((resolve) => policyWaits.push(resolve)),
    getAccountScope: () => SCOPE,
  });
  const h = (channel) => ipcMain.handlers.get(channel);

  const cancelledRun = h("connector-run-direct")({}, "email", "draft", { to: ["a@b.co"] }, "run-1");
  assert.deepEqual(await h("connector-cancel")({}, "run-1", "cancelled_by_user"), {
    cancelled: true,
  });
  policyWaits.shift()("allowed");
  assert.deepEqual(await cancelledRun, { state: "not_sent", reason: "cancelled" });

  // Once the run finishes it is no longer tracked, so a later cancel with the
  // same id is only an ordinary (pending approval) cancel.
  const run = h("connector-run-direct")({}, "email", "draft", { to: ["a@b.co"] }, "run-2");
  policyWaits.shift()("allowed");
  await run;
  assert.deepEqual(await h("connector-cancel")({}, "run-2", "cancelled_by_user"), {
    cancelled: false,
  });

  assert.deepEqual(
    manager.calls.map((call) => call.name),
    ["cancel", "runDirect", "cancel"]
  );
});

test("malformed arguments never reach the manager", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const manager = fakeManager();
  registerConnectorIpc({
    ipcMain,
    manager,
    getPolicyState: async () => "allowed",
    getAccountScope: () => SCOPE,
  });
  const h = (channel) => ipcMain.handlers.get(channel);

  const prepared = await h("connector-prepare")({}, 42, "send_message", null);
  const committed = await h("connector-commit")({}, null, {});

  assert.deepEqual(prepared, { status: "unavailable", reason: "invalid_request" });
  assert.deepEqual(committed, { state: "not_sent", reason: "invalid_request" });
  for (const [connectorId, action, args] of [
    ["email", "draft", ["a@b.co"]],
    ["email", "draft", null],
    ["email", "", {}],
    [7, "draft", {}],
  ]) {
    assert.deepEqual(await h("connector-run-direct")({}, connectorId, action, args, "run-1"), {
      state: "unavailable",
      reason: "invalid_request",
    });
  }
  assert.equal(manager.calls.length, 0);
});

test("the policy resolver allows signed-out users and maps snapshots", async () => {
  const { createConnectorPolicyResolver } = await load();
  const signedOut = createConnectorPolicyResolver({
    getAuthHeader: async () => ({}),
    getPolicy: async () => {
      throw new Error("must not be called");
    },
    getAuthGeneration: () => 1,
  });
  assert.equal(await signedOut({}), "allowed");

  const blocked = createConnectorPolicyResolver({
    getAuthHeader: async () => ({ Authorization: "Bearer t" }),
    getPolicy: async () => ({
      success: true,
      managed: true,
      policy: { features: { connectorsEnabled: false } },
    }),
    getAuthGeneration: () => 1,
  });
  assert.equal(await blocked({}), "blocked");
});

test("a policy lookup that hangs or throws fails closed", async () => {
  const { createConnectorPolicyResolver } = await load();
  const hanging = createConnectorPolicyResolver({
    getAuthHeader: async () => ({ Authorization: "Bearer t" }),
    getPolicy: () => new Promise(() => {}),
    getAuthGeneration: () => 1,
    timeoutMs: 20,
  });
  const started = Date.now();
  assert.equal(await hanging({}), "unavailable");
  assert.ok(Date.now() - started < 1000);

  const throwing = createConnectorPolicyResolver({
    getAuthHeader: async () => ({ Cookie: "session=1" }),
    getPolicy: async () => {
      throw new Error("offline");
    },
    getAuthGeneration: () => 1,
  });
  assert.equal(await throwing({}), "unavailable");

  const throttled = createConnectorPolicyResolver({
    getAuthHeader: async () => ({ Authorization: "Bearer t" }),
    getPolicy: async () => ({ success: false, status: "error", code: "POLICY_RETRY_THROTTLED" }),
    getAuthGeneration: () => 1,
  });
  assert.equal(await throttled({}), "unavailable");
});

test("a slow refresh falls back to the verdict already held for the account", async () => {
  const { createConnectorPolicyResolver } = await load();
  const peeked = [];
  const slowRefresh = (held) =>
    createConnectorPolicyResolver({
      getAuthHeader: async () => ({ Authorization: "Bearer t" }),
      getPolicy: () => new Promise(() => {}),
      peekPolicy: (request) => {
        peeked.push(request);
        return held;
      },
      getAuthGeneration: () => 7,
      timeoutMs: 20,
    });

  assert.equal(await slowRefresh({ success: true, managed: false, policy: null })({}), "allowed");
  assert.equal(
    await slowRefresh({
      success: true,
      managed: true,
      policy: { features: { connectorsEnabled: false } },
    })({}),
    "blocked"
  );
  // Nothing held yet (the session's first lookup): still fails closed.
  assert.equal(await slowRefresh(null)({}), "unavailable");
  assert.deepEqual(peeked[0], {
    expectedAuthGeneration: 7,
    authHeaders: { Authorization: "Bearer t" },
  });
});

test("the auth generation is read before the header lookup", async () => {
  const { createConnectorPolicyResolver } = await load();
  let generation = 4;
  const requests = [];
  const resolver = createConnectorPolicyResolver({
    getAuthHeader: async () => {
      // A sign-in lands while the cookie lookup is in flight.
      generation = 5;
      return { Cookie: "session=old" };
    },
    getPolicy: async (request) => {
      requests.push(request);
      return { success: false, status: "error", code: "AUTH_CONTEXT_CHANGED" };
    },
    getAuthGeneration: () => generation,
  });

  assert.equal(await resolver({}), "unavailable");
  assert.equal(requests[0].expectedAuthGeneration, 4);
});

test("the deadline covers the auth-header lookup too", async () => {
  const { createConnectorPolicyResolver } = await load();
  const hangingAuth = createConnectorPolicyResolver({
    getAuthHeader: () => new Promise(() => {}),
    getPolicy: async () => {
      throw new Error("must not be called");
    },
    getAuthGeneration: () => 1,
    timeoutMs: 20,
  });
  const started = Date.now();
  assert.equal(await hangingAuth({}), "unavailable");
  assert.ok(Date.now() - started < 1000);

  const throwingAuth = createConnectorPolicyResolver({
    getAuthHeader: async () => {
      throw new Error("window destroyed");
    },
    getPolicy: async () => ({ success: true, managed: false, policy: null }),
    getAuthGeneration: () => {
      throw new Error("token store unavailable");
    },
  });
  assert.equal(await throwingAuth({}), "unavailable");
});

test("contact lookup trims the query and returns nothing the org policy doesn't allow", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const queries = [];
  const policies = ["allowed", "blocked", "unavailable"];
  registerConnectorIpc({
    ipcMain,
    manager: fakeManager(),
    getPolicyState: async () => policies.shift(),
    getAccountScope: () => SCOPE,
    findContacts: (query) => {
      queries.push(query);
      return {
        contacts: [{ name: "Gabe", email: "gabe@example.com", lastMet: null }],
        hasMore: false,
      };
    },
  });
  const handler = ipcMain.handlers.get("connector-find-contacts");
  assert.deepEqual(await handler({}, "  Gabe "), {
    contacts: [{ name: "Gabe", email: "gabe@example.com", lastMet: null }],
    hasMore: false,
  });
  assert.deepEqual(await handler({}, "Gabe"), {
    contacts: [],
    unavailableReason: "policy_blocked",
  });
  assert.deepEqual(await handler({}, "Gabe"), {
    contacts: [],
    unavailableReason: "policy_unavailable",
  });
  // Malformed or oversized queries never reach the policy lookup or the search.
  assert.deepEqual(await handler({}, 42), { contacts: [] });
  assert.deepEqual(await handler({}, "a".repeat(201)), { contacts: [] });
  assert.deepEqual(queries, ["Gabe"]);
  assert.equal(policies.length, 0);
});

test("an action runs under the account bound to its credential, or none if it changed", async () => {
  const { registerConnectorIpc } = await load();
  const cases = [
    // A stable scope.
    [SCOPE, SCOPE, "account-a"],
    // Signed out, or signed in but not yet scoped (the null-scope gap).
    [null, null, null],
    // A sign-in lands during the policy wait.
    [null, SCOPE, null],
    // A → B: another account's credential arrives during the wait.
    [SCOPE, { accountId: "account-b", authGeneration: 4 }, null],
    // Same account, rotated credential.
    [SCOPE, { ...SCOPE, authGeneration: 4 }, null],
  ];
  for (const [before, after, accountId] of cases) {
    const ipcMain = fakeIpcMain();
    const manager = fakeManager();
    let scope = before;
    registerConnectorIpc({
      ipcMain,
      manager,
      getPolicyState: async () => {
        scope = after;
        return "allowed";
      },
      getAccountScope: () => scope,
    });
    await ipcMain.handlers.get("connector-run-direct")({}, "email", "draft", {});
    assert.deepEqual(manager.calls[0].args[3], { policyState: "allowed", accountId });
  }
});

test("recent actions are read for the account bound to the credential", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const manager = fakeManager();
  let scope = null;
  registerConnectorIpc({
    ipcMain,
    manager,
    getPolicyState: async () => "allowed",
    getAccountScope: () => scope,
  });
  const recent = ipcMain.handlers.get("connector-recent-actions");
  await recent({}, "email", 5);
  scope = SCOPE;
  await recent({}, "email", 5);
  assert.deepEqual(
    manager.calls.map((call) => call.args),
    [
      ["email", 5, null],
      ["email", 5, "account-a"],
    ]
  );
});

test("a cancel after policy resolves still reaches the running action's signal", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const gate = [];
  let runtimeSeen = null;
  const manager = {
    ...fakeManager(),
    runDirect: (connectorId, action, args, auth, runtime) => {
      runtimeSeen = runtime;
      return new Promise((resolve) => gate.push(resolve));
    },
  };
  registerConnectorIpc({
    ipcMain,
    manager,
    getPolicyState: async () => "allowed",
    getAccountScope: () => SCOPE,
  });
  const h = (channel) => ipcMain.handlers.get(channel);

  const run = h("connector-run-direct")({}, "email", "draft", {}, "run-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeSeen.signal.aborted, false);
  assert.deepEqual(await h("connector-cancel")({}, "run-1", "cancelled_by_user"), {
    cancelled: true,
  });
  assert.equal(runtimeSeen.signal.aborted, true);
  gate.shift()({ state: "not_sent", reason: "cancelled" });
  assert.deepEqual(await run, { state: "not_sent", reason: "cancelled" });
});

test("a run id can't hijack a live run or swallow an approval's cancel", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const manager = fakeManager();
  const policyWaits = [];
  registerConnectorIpc({
    ipcMain,
    manager,
    getPolicyState: () => new Promise((resolve) => policyWaits.push(resolve)),
    getAccountScope: () => SCOPE,
  });
  const h = (channel) => ipcMain.handlers.get(channel);

  const first = h("connector-run-direct")({}, "email", "draft", {}, "action-1");
  assert.deepEqual(await h("connector-run-direct")({}, "email", "draft", {}, "action-1"), {
    state: "unavailable",
    reason: "invalid_request",
  });

  // "action-1" is also a pending approval's id: its cancel still reaches main.
  await h("connector-cancel")({}, "action-1", "cancelled_by_user");
  assert.deepEqual(manager.calls[0], { name: "cancel", args: ["action-1", "cancelled_by_user"] });

  policyWaits.shift()("allowed");
  assert.deepEqual(await first, { state: "not_sent", reason: "cancelled" });
  assert.equal(policyWaits.length, 0);
});

test("a held verdict that throws on the deadline fallback fails closed", async () => {
  const { createConnectorPolicyResolver } = await load();
  const resolver = createConnectorPolicyResolver({
    getAuthHeader: async () => ({ Authorization: "Bearer t" }),
    getPolicy: () => new Promise(() => {}),
    peekPolicy: () => {
      throw new Error("cache corrupted");
    },
    getAuthGeneration: () => 1,
    timeoutMs: 20,
  });
  assert.equal(await resolver({}), "unavailable");
});
