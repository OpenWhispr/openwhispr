const test = require("node:test");
const assert = require("node:assert/strict");

const loadManager = () => import("../../../src/helpers/connectors/connectorManager.js");
const loadPending = () => import("../../../src/helpers/connectors/pendingActions.js");

const silentLogger = { info() {}, warn() {}, error() {} };

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeLog({ failInsert = false, failTransition = false, failFinal = false } = {}) {
  const rows = new Map();
  let reconciled = 0;
  return {
    rows,
    reconciledCount: () => reconciled,
    insert: (row) => {
      if (failInsert) throw new Error("disk full");
      rows.set(row.id, { ...row });
    },
    // Mirrors updateConnectorActionState: a guarded update only moves a row
    // still in fromState and reports how many rows changed.
    update: (id, patch, fromState) => {
      const row = rows.get(id);
      if (!row) return 0;
      if (fromState !== undefined && row.state !== fromState) return 0;
      if (fromState !== undefined && failTransition) throw new Error("disk full");
      if (fromState === undefined && failFinal) throw new Error("disk full");
      rows.set(id, { ...row, ...patch });
      return 1;
    },
    listRecent: (connector, limit) =>
      [...rows.values()].filter((row) => row.connector === connector).slice(0, limit),
    reconcileInterrupted: () => {
      reconciled += 1;
      return { unknown: 0, cancelled: 0 };
    },
  };
}

function fakeConnector(overrides = {}) {
  const calls = { prepare: [], commit: [], runDirect: [] };
  let binding = { accountId: "U1", workspaceId: "T1", generation: 1 };
  const connector = {
    id: "fake",
    actions: { post: { kind: "approval" }, draft: { kind: "direct" } },
    async getStatus() {
      return { connected: true, accountLabel: "chad" };
    },
    async getBinding() {
      return binding;
    },
    async prepare(action, args) {
      calls.prepare.push({ action, args });
      return {
        status: "ready",
        payload: { channel: "C1", text: args.text },
        preview: { verbKey: "default", destinationLabel: "#eng", accountLabel: "chad", body: args.text },
      };
    },
    async commit(action, payload, edits) {
      calls.commit.push({ action, payload, edits });
      return { state: "sent", url: "https://example.test/p/1" };
    },
    async runDirect(action, args, runtime) {
      calls.runDirect.push({ action, args, runtime });
      return { state: "sent", destinationLabel: "gabe@example.test" };
    },
    ...overrides,
  };
  return {
    connector,
    calls,
    setBinding: (next) => {
      binding = next;
    },
  };
}

async function setup(connectorOverrides, logOptions) {
  const [{ createConnectorManager }, { createPendingActions }] = await Promise.all([
    loadManager(),
    loadPending(),
  ]);
  const fake = fakeConnector(connectorOverrides);
  const log = fakeLog(logOptions);
  const manager = createConnectorManager({
    connectors: [fake.connector],
    pendingActions: createPendingActions(),
    actionLog: log,
    logger: silentLogger,
  });
  return { manager, fake, log };
}

test("creating the manager reconciles interrupted rows", async () => {
  const { log } = await setup();
  assert.equal(log.reconciledCount(), 1);
});

test("prepare then commit sends once and records every state", async () => {
  const { manager, fake, log } = await setup();

  const prepared = await manager.prepare("fake", "post", { text: "hello" }, "allowed");
  assert.equal(prepared.status, "ready");
  assert.equal(log.rows.get(prepared.actionId).state, "pending");

  const result = await manager.commit(prepared.actionId, { body: "hello!" }, "allowed");

  assert.deepEqual(result, { state: "sent", url: "https://example.test/p/1" });
  assert.deepEqual(fake.calls.commit[0].edits, { body: "hello!" });
  assert.equal(log.rows.get(prepared.actionId).state, "sent");
  assert.equal(log.rows.get(prepared.actionId).resultUrl, "https://example.test/p/1");
});

test("a second commit while the first is in flight never sends twice", async () => {
  const gate = deferred();
  const { manager, fake } = await setup({
    async commit(action, payload, edits) {
      fake.calls.commit.push({ action, payload, edits });
      await gate.promise;
      return { state: "sent" };
    },
  });
  const { actionId } = await manager.prepare("fake", "post", { text: "hi" }, "allowed");

  const first = manager.commit(actionId, {}, "allowed");
  const second = await manager.commit(actionId, {}, "allowed");
  gate.resolve();

  assert.deepEqual(second, { state: "not_sent", reason: "not_pending" });
  assert.deepEqual(await first, { state: "sent" });
  assert.equal(fake.calls.commit.length, 1);
});

test("a blocked or unavailable policy refuses prepare, commit and runDirect", async () => {
  const { manager, fake, log } = await setup();

  assert.deepEqual(await manager.prepare("fake", "post", { text: "x" }, "blocked"), {
    status: "unavailable",
    reason: "policy_blocked",
  });
  assert.equal(fake.calls.prepare.length, 0);

  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  assert.deepEqual(await manager.commit(actionId, {}, "unavailable"), {
    state: "not_sent",
    reason: "policy_unavailable",
  });
  assert.equal(fake.calls.commit.length, 0);
  assert.equal(log.rows.get(actionId).state, "cancelled");

  assert.deepEqual(await manager.runDirect("fake", "draft", {}, "unavailable", {}), {
    state: "unavailable",
    reason: "policy_unavailable",
  });
});

test("a connection change between prepare and commit refuses the send", async () => {
  const { manager, fake, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");

  fake.setBinding({ accountId: "U2", workspaceId: "T1", generation: 2 });

  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "not_sent",
    reason: "connection_changed",
  });
  assert.equal(fake.calls.commit.length, 0);
  assert.equal(log.rows.get(actionId).errorCode, "connection_changed");
});

test("a connector that throws during commit is recorded as unknown", async () => {
  const { manager, log } = await setup({
    async commit() {
      throw new Error("socket closed");
    },
  });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), { state: "unknown" });
  assert.equal(log.rows.get(actionId).state, "unknown");
});

test("clarification and prepare failures create no pending action", async () => {
  const { manager, log } = await setup({
    async prepare() {
      return { status: "needs_clarification", message: "Which #eng?", candidates: ["#eng-web", "#eng-ios"] };
    },
  });
  const result = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  assert.equal(result.status, "needs_clarification");
  assert.equal(log.rows.size, 0);
});

test("cancel withdraws only pending actions and records the reason", async () => {
  const { manager, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");

  assert.deepEqual(manager.cancel(actionId, "conversation_ended"), { cancelled: true });
  assert.equal(log.rows.get(actionId).state, "cancelled");
  assert.equal(log.rows.get(actionId).errorCode, "conversation_ended");
  assert.deepEqual(manager.cancel(actionId, "cancelled_by_user"), { cancelled: false });

  const expiring = await manager.prepare("fake", "post", { text: "y" }, "allowed");
  manager.cancel(expiring.actionId, "expired");
  assert.equal(log.rows.get(expiring.actionId).state, "expired");
});

test("runDirect runs direct actions with the runtime and logs a receipt", async () => {
  const { manager, fake, log } = await setup();
  const runtime = { webContents: "sender" };

  const result = await manager.runDirect("fake", "draft", { to: ["a@b.co"] }, "allowed", runtime);

  assert.deepEqual(result, { state: "sent", destinationLabel: "gabe@example.test" });
  assert.equal(fake.calls.runDirect[0].runtime, runtime);
  const [row] = [...log.rows.values()];
  assert.equal(row.kind, "direct");
  assert.equal(row.state, "sent");
});

test("an action is only reachable through its own kind", async () => {
  const { manager } = await setup();
  assert.deepEqual(await manager.runDirect("fake", "post", {}, "allowed", {}), {
    state: "unavailable",
    reason: "unknown_action",
  });
  assert.deepEqual(await manager.prepare("fake", "draft", {}, "allowed"), {
    status: "unavailable",
    reason: "unknown_action",
  });
  assert.deepEqual(await manager.prepare("nope", "post", {}, "allowed"), {
    status: "unavailable",
    reason: "unknown_connector",
  });
});

test("edits are reduced to string title and body", async () => {
  const { manager, fake } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  await manager.commit(actionId, { body: "b", title: 5, channel: "C999" }, "allowed");
  assert.deepEqual(fake.calls.commit[0].edits, { body: "b" });
});

test("invalidate cancels pending actions for that connector", async () => {
  const { manager, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  assert.deepEqual(manager.invalidate("fake"), [actionId]);
  assert.equal(log.rows.get(actionId).errorCode, "connection_changed");
});

test("a pending row that can't be written means no card and no pending action", async () => {
  const { manager, log } = await setup({}, { failInsert: true });
  const result = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "receipt_unavailable");
  assert.equal(log.rows.size, 0);
});

test("the send never starts unless committing was durably recorded", async () => {
  const { manager, fake } = await setup({}, { failTransition: true });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");

  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "not_sent",
    reason: "receipt_unavailable",
  });
  assert.equal(fake.calls.commit.length, 0);
  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), { state: "not_sent", reason: "not_found" });
});

test("a failed final write still reports the real outcome and leaves the row committing", async () => {
  const { manager, log } = await setup({}, { failFinal: true });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");

  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "sent",
    url: "https://example.test/p/1",
  });
  // Reconciliation turns this into "unknown" on the next launch: conservative, never "cancelled".
  assert.equal(log.rows.get(actionId).state, "committing");
});

test("a direct action is recorded as committing before it runs", async () => {
  let statesSeenByConnector = null;
  let logRef = null;
  const { manager, log } = await setup({
    async runDirect() {
      statesSeenByConnector = [...logRef.rows.values()].map((row) => row.state);
      return { state: "sent", destinationLabel: "a@b.co" };
    },
  });
  logRef = log;

  await manager.runDirect("fake", "draft", {}, "allowed", {});

  assert.deepEqual(statesSeenByConnector, ["committing"]);
  const [row] = [...log.rows.values()];
  assert.equal(row.state, "sent");
  assert.equal(row.destinationLabel, "a@b.co");
});

test("a direct action whose record can't be written never runs", async () => {
  const { manager, fake } = await setup({}, { failInsert: true });
  assert.deepEqual(await manager.runDirect("fake", "draft", {}, "allowed", {}), {
    state: "unavailable",
    reason: "receipt_unavailable",
  });
  assert.equal(fake.calls.runDirect.length, 0);
});

test("a gated getBinding during second commit never overwrites a sent receipt", async () => {
  const gate = deferred();
  const bindingCalls = [];
  const { manager, fake, log } = await setup({
    async getBinding() {
      bindingCalls.push(1);
      if (bindingCalls.length >= 3) {
        // Second commit's getBinding is call 3; gate it.
        await gate.promise;
      }
      return { accountId: "U1", workspaceId: "T1", generation: 1 };
    },
  });

  // First prepare and commit should succeed.
  const { actionId } = await manager.prepare("fake", "post", { text: "hello" }, "allowed");
  const firstCommit = manager.commit(actionId, {}, "allowed");

  // Let the first commit complete and record "sent".
  const firstResult = await firstCommit;
  assert.equal(firstResult.state, "sent");
  const rowAfterFirstCommit = log.rows.get(actionId);
  assert.equal(rowAfterFirstCommit.state, "sent");
  assert.equal(rowAfterFirstCommit.resultUrl, "https://example.test/p/1");

  // Second commit's getBinding will be gated.
  const secondCommit = manager.commit(actionId, {}, "allowed");

  // Release the gate and let the second commit complete.
  gate.resolve();
  const secondResult = await secondCommit;

  // Second commit should return not_found without attempting send.
  assert.deepEqual(secondResult, { state: "not_sent", reason: "not_found" });
  // Connector.commit should have run only once (from the first commit).
  assert.equal(fake.calls.commit.length, 1);
  // Row should still be "sent" with its URL, never overwritten to "cancelled".
  const rowAfterSecondCommit = log.rows.get(actionId);
  assert.equal(rowAfterSecondCommit.state, "sent");
  assert.equal(rowAfterSecondCommit.resultUrl, "https://example.test/p/1");
});

test("commit never overwrites a receipt with not_found via policy refusal guard", async () => {
  // Verify that policy refusal can't overwrite a non-pending row.
  // This would only happen if a row was manually set to sent then commit tried with policy block.
  // In practice this is prevented by the fromState="pending" guard.
  const { manager, fake, log } = await setup();

  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  assert.equal(log.rows.get(actionId).state, "pending");

  // Manually change the row state to "sent" (simulating a first commit that succeeded)
  log.rows.set(actionId, { ...log.rows.get(actionId), state: "sent" });

  // Now try commit with policy unavailable - should not overwrite the sent state
  const result = await manager.commit(actionId, {}, "unavailable");

  // Should return not_sent with policy_unavailable reason
  assert.equal(result.state, "not_sent");
  assert.equal(result.reason, "policy_unavailable");

  // Row should still be "sent" because the update was guarded by fromState="pending"
  const row = log.rows.get(actionId);
  assert.equal(row.state, "sent");
});
