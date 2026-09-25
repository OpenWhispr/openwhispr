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
        preview: {
          verbKey: "default",
          destinationLabel: "#eng",
          accountLabel: "chad",
          body: args.text,
        },
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

async function setup(connectorOverrides, logOptions, pendingOptions) {
  const [{ createConnectorManager }, { createPendingActions }] = await Promise.all([
    loadManager(),
    loadPending(),
  ]);
  const fake = fakeConnector(connectorOverrides);
  const log = fakeLog(logOptions);
  const manager = createConnectorManager({
    connectors: [fake.connector],
    pendingActions: createPendingActions(pendingOptions),
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

test("a connector commit resolving undefined is recorded as unknown and never orphans the entry", async () => {
  const { manager, log } = await setup({
    async commit() {
      return undefined;
    },
  });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");

  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), { state: "unknown" });
  assert.equal(log.rows.get(actionId).state, "unknown");
  // The entry must not be orphaned in "committing": a second commit finds no pending action.
  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "not_sent",
    reason: "not_found",
  });
});

test("a connector commit resolving an unrecognized state is recorded as unknown", async () => {
  const { manager, log } = await setup({
    async commit() {
      return { state: "banana" };
    },
  });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");

  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), { state: "unknown" });
  assert.equal(log.rows.get(actionId).state, "unknown");
});

test("a runDirect that throws or resolves malformed is recorded as unknown, never failed", async () => {
  // Either may come after the side effect, so "failed" would invite a duplicate retry.
  for (const [runDirect, errorCode] of [
    [async () => undefined, "invalid_result"],
    [async () => ({ state: "banana" }), "invalid_result"],
    [
      async () => {
        throw new Error("clipboard unavailable");
      },
      "direct_failed",
    ],
  ]) {
    const { manager, log } = await setup({ runDirect });

    const result = await manager.runDirect("fake", "draft", {}, "allowed", {});

    assert.equal(result.state, "unknown");
    assert.equal(result.errorCode, errorCode);
    assert.match(result.message, /may have gone through/);
    const [row] = [...log.rows.values()];
    assert.equal(row.state, "unknown");
  }
});

test("clarification and prepare failures create no pending action", async () => {
  const { manager, log } = await setup({
    async prepare() {
      return {
        status: "needs_clarification",
        message: "Which #eng?",
        candidates: ["#eng-web", "#eng-ios"],
      };
    },
  });
  const result = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  assert.equal(result.status, "needs_clarification");
  assert.equal(log.rows.size, 0);
});

test("prepare passes on only the fields each connector result defines", async () => {
  const cases = [
    [
      undefined,
      { status: "failed", errorCode: "invalid_result", message: "Couldn't prepare that action." },
    ],
    [
      { status: "sent", body: "secret text" },
      { status: "failed", errorCode: "invalid_result", message: "Couldn't prepare that action." },
    ],
    [
      { status: "ready", payload: { text: "x" } },
      { status: "failed", errorCode: "invalid_result", message: "Couldn't prepare that action." },
    ],
    [
      {
        status: "needs_clarification",
        message: "Which #eng?",
        candidates: ["#eng-web", 7],
        body: "secret text",
      },
      { status: "needs_clarification", message: "Which #eng?", candidates: ["#eng-web"] },
    ],
    [
      {
        status: "failed",
        errorCode: "channel_archived",
        message: "That channel is archived.",
        body: "secret text",
      },
      { status: "failed", errorCode: "channel_archived", message: "That channel is archived." },
    ],
  ];
  for (const [prepared, expected] of cases) {
    const { manager, log } = await setup({ prepare: async () => prepared });
    assert.deepEqual(await manager.prepare("fake", "post", { text: "x" }, "allowed"), expected);
    assert.equal(log.rows.size, 0);
  }

  const { manager } = await setup({
    async prepare() {
      throw new Error("token=abc123 rejected");
    },
  });
  assert.deepEqual(await manager.prepare("fake", "post", { text: "x" }, "allowed"), {
    status: "failed",
    errorCode: "prepare_failed",
    message: "Couldn't prepare that action.",
  });
});

test("a connector lookup that throws never hands its error to the renderer", async () => {
  const leaky = new Error("token=abc123 rejected");
  const bindingThrows = await setup({
    async getBinding() {
      throw leaky;
    },
    async getStatus() {
      throw leaky;
    },
  });
  assert.deepEqual(await bindingThrows.manager.prepare("fake", "post", { text: "x" }, "allowed"), {
    status: "unavailable",
    reason: "not_connected",
  });
  assert.deepEqual(await bindingThrows.manager.status(), [
    { id: "fake", connected: false, accountLabel: null },
  ]);

  const { manager, fake, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  fake.connector.getBinding = async () => {
    throw leaky;
  };
  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "not_sent",
    reason: "connection_changed",
  });
  assert.equal(fake.calls.commit.length, 0);
  assert.equal(log.rows.get(actionId).state, "cancelled");
});

test("expired pending actions are swept and recorded as expired on the next call", async () => {
  const { PENDING_TTL_MS } = await loadPending();
  let clock = 1_000;
  const { manager, log } = await setup({}, {}, { now: () => clock });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");

  clock += PENDING_TTL_MS + 1;
  manager.recentActions("fake");

  assert.equal(log.rows.get(actionId).state, "expired");
  assert.equal(log.rows.get(actionId).errorCode, "expired");
  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "not_sent",
    reason: "not_found",
  });
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
  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "not_sent",
    reason: "not_found",
  });
});

test("the send never starts when the committing write moves no row", async () => {
  const { manager, fake, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, "allowed");
  log.rows.delete(actionId);

  assert.deepEqual(await manager.commit(actionId, {}, "allowed"), {
    state: "not_sent",
    reason: "receipt_unavailable",
  });
  assert.equal(fake.calls.commit.length, 0);
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

test("concurrent commits where second loses the race never overwrites sent receipt", async () => {
  const gate = deferred();
  let bindingCalls = 0;
  const { manager, fake, log } = await setup({
    async getBinding() {
      bindingCalls += 1;
      if (bindingCalls === 3) await gate.promise;
      return { accountId: "U1", workspaceId: "T1", generation: 1 };
    },
  });

  const { actionId } = await manager.prepare("fake", "post", { text: "hello" }, "allowed");

  // Start both commits concurrently (no await between them)
  const first = manager.commit(actionId, {}, "allowed");
  const second = manager.commit(actionId, {}, "allowed");

  // First commit should complete as sent
  assert.deepEqual(await first, { state: "sent", url: "https://example.test/p/1" });

  // Now release the gate for second commit's getBinding
  gate.resolve();

  // Second commit should fail with not_found without overwriting the receipt
  assert.deepEqual(await second, { state: "not_sent", reason: "not_found" });
  assert.equal(fake.calls.commit.length, 1);

  const row = log.rows.get(actionId);
  assert.equal(row.state, "sent");
  assert.equal(row.resultUrl, "https://example.test/p/1");
});

test("invalidate during a gated commit cancels the action without overwriting it", async () => {
  const gate = deferred();
  let bindingCalls = 0;
  const { manager, fake, log } = await setup({
    async getBinding() {
      bindingCalls += 1;
      if (bindingCalls === 2) await gate.promise;
      return { accountId: "U1", workspaceId: "T1", generation: 1 };
    },
  });

  const { actionId } = await manager.prepare("fake", "post", { text: "hello" }, "allowed");

  // Start commit (will be gated at call 2)
  const committing = manager.commit(actionId, {}, "allowed");

  // While commit is awaiting getBinding, invalidate the connector
  assert.deepEqual(manager.invalidate("fake"), [actionId]);

  // Release the gate
  gate.resolve();

  // Commit should fail with not_found (entry was removed/cancelled by invalidate)
  assert.deepEqual(await committing, { state: "not_sent", reason: "not_found" });
  assert.equal(fake.calls.commit.length, 0);

  // Row should be cancelled with connection_changed from invalidate
  const row = log.rows.get(actionId);
  assert.equal(row.state, "cancelled");
  assert.equal(row.errorCode, "connection_changed");
});
