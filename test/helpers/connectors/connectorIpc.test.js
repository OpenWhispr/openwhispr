const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/connectorIpc.js");

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler) };
}

function fakeManager() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return { ok: name };
  };
  return {
    calls,
    status: record("status"),
    prepare: record("prepare"),
    commit: record("commit"),
    cancel: record("cancel"),
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
  assert.deepEqual(manager.calls[1].args, ["slack", "send_message", { text: "hi" }, "allowed"]);
  assert.deepEqual(manager.calls[2].args, ["action-1", { body: "hi!" }, "allowed"]);
  assert.deepEqual(manager.calls[4].args, [
    "email",
    "draft",
    { to: ["a@b.co"] },
    "allowed",
    { webContents: "renderer-1" },
  ]);
  assert.equal(policyCalls.length, 3);
});

test("malformed arguments never reach the manager", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const manager = fakeManager();
  registerConnectorIpc({ ipcMain, manager, getPolicyState: async () => "allowed" });

  const prepared = await ipcMain.handlers.get("connector-prepare")({}, 42, "send_message", null);
  const committed = await ipcMain.handlers.get("connector-commit")({}, null, {});

  assert.deepEqual(prepared, { status: "unavailable", reason: "invalid_request" });
  assert.deepEqual(committed, { state: "not_sent", reason: "invalid_request" });
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

test("contact lookup trims the query and never needs policy", async () => {
  const { registerConnectorIpc } = await load();
  const ipcMain = fakeIpcMain();
  const queries = [];
  registerConnectorIpc({
    ipcMain,
    manager: fakeManager(),
    getPolicyState: async () => {
      throw new Error("must not be called");
    },
    findContacts: (query) => {
      queries.push(query);
      return [{ name: "Gabe", email: "gabe@example.com", lastMet: null }];
    },
  });
  const handler = ipcMain.handlers.get("connector-find-contacts");
  assert.deepEqual(await handler({}, "  Gabe "), {
    contacts: [{ name: "Gabe", email: "gabe@example.com", lastMet: null }],
  });
  assert.deepEqual(await handler({}, 42), { contacts: [] });
  assert.deepEqual(queries, ["Gabe"]);
});
