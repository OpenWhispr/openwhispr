const test = require("node:test");
const assert = require("node:assert/strict");

const { memoryCredentials } = require("./slackFixtures");

const loadManager = () => import("../../../src/helpers/connectors/connectorManager.js");
const loadPending = () => import("../../../src/helpers/connectors/pendingActions.js");

const silentLogger = { info() {}, warn() {}, error() {} };

const ACCOUNT = "account-a";
const ALLOWED = { policyState: "allowed", accountId: ACCOUNT };
const SIGNED_OUT = { policyState: "signed_out", accountId: null };

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// better-sqlite3 throws when asked to bind anything but a primitive, which
// would leave a receipt stuck in its last state.
function assertBindable(values) {
  for (const value of Object.values(values)) {
    if (value !== null && value !== undefined && typeof value === "object") {
      throw new TypeError("SQLite3 can only bind numbers, strings, bigints, buffers, and null");
    }
  }
}

function fakeLog({ failInsert = false, failTransition = false, failFinal = false } = {}) {
  const rows = new Map();
  let reconciled = 0;
  return {
    rows,
    reconciledCount: () => reconciled,
    insert: (row) => {
      if (failInsert) throw new Error("disk full");
      assertBindable(row);
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
      assertBindable(patch);
      rows.set(id, { ...row, ...patch });
      return 1;
    },
    listRecent: (connector, limit, accountId) =>
      [...rows.values()]
        .filter((row) => row.connector === connector && row.accountId === accountId)
        .slice(0, limit),
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
    async prepare(action, args, context) {
      calls.prepare.push({ action, args, context });
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
    async commit(action, payload, edits, context) {
      calls.commit.push({ action, payload, edits, context });
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

async function setup(connectorOverrides, logOptions, managerOptions = {}) {
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
    getAccountId: () => "acct-1",
    ...managerOptions,
  });
  return { manager, fake, log };
}

test("creating the manager reconciles interrupted rows", async () => {
  const { log } = await setup();
  assert.equal(log.reconciledCount(), 1);
});

test("prepare then commit sends once and records every state", async () => {
  const { manager, fake, log } = await setup();

  const prepared = await manager.prepare("fake", "post", { text: "hello" }, ALLOWED);
  assert.equal(prepared.status, "ready");
  assert.equal(log.rows.get(prepared.actionId).state, "pending");

  const result = await manager.commit(prepared.actionId, { body: "hello!" }, ALLOWED);

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
  const { actionId } = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);

  const first = manager.commit(actionId, {}, ALLOWED);
  const second = await manager.commit(actionId, {}, ALLOWED);
  gate.resolve();

  assert.deepEqual(second, { state: "not_sent", reason: "not_pending" });
  assert.deepEqual(await first, { state: "sent" });
  assert.equal(fake.calls.commit.length, 1);
});

test("a blocked or unavailable policy refuses prepare, commit and runDirect", async () => {
  const { manager, fake, log } = await setup();

  assert.deepEqual(
    await manager.prepare(
      "fake",
      "post",
      { text: "x" },
      { policyState: "blocked", accountId: ACCOUNT }
    ),
    {
      status: "unavailable",
      reason: "policy_blocked",
    }
  );
  assert.equal(fake.calls.prepare.length, 0);

  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  assert.deepEqual(
    await manager.commit(actionId, {}, { policyState: "blocked", accountId: ACCOUNT }),
    {
      state: "not_sent",
      reason: "policy_blocked",
    }
  );
  assert.equal(fake.calls.commit.length, 0);
  assert.equal(log.rows.get(actionId).state, "cancelled");

  assert.deepEqual(
    await manager.runDirect(
      "fake",
      "draft",
      {},
      { policyState: "unavailable", accountId: ACCOUNT },
      {}
    ),
    {
      state: "unavailable",
      reason: "policy_unavailable",
    }
  );
});

test("an unavailable policy at Send leaves the action pending for another try", async () => {
  const { manager, fake, log } = await setup();
  const prepared = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);

  assert.deepEqual(
    await manager.commit(prepared.actionId, {}, { policyState: "unavailable", accountId: ACCOUNT }),
    {
      state: "not_sent",
      reason: "policy_unavailable",
      retryable: true,
    }
  );
  assert.equal(log.rows.get(prepared.actionId).state, "pending");
  assert.equal(fake.calls.commit.length, 0);

  const sent = await manager.commit(prepared.actionId, {}, ALLOWED);
  assert.equal(sent.state, "sent");
  assert.equal(fake.calls.commit.length, 1);
});

test("signed out refuses every action, and an unknown state fails closed", async () => {
  const { manager, fake, log } = await setup();

  assert.deepEqual(await manager.prepare("fake", "post", { text: "hi" }, SIGNED_OUT), {
    status: "unavailable",
    reason: "signed_out",
  });
  assert.deepEqual(await manager.runDirect("fake", "draft", {}, SIGNED_OUT, {}), {
    state: "unavailable",
    reason: "signed_out",
  });
  assert.deepEqual(
    await manager.prepare(
      "fake",
      "post",
      { text: "hi" },
      { policyState: "weird", accountId: ACCOUNT }
    ),
    {
      status: "unavailable",
      reason: "policy_unavailable",
    }
  );
  assert.equal(fake.calls.prepare.length + fake.calls.runDirect.length, 0);

  const prepared = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);
  assert.deepEqual(await manager.commit(prepared.actionId, {}, SIGNED_OUT), {
    state: "not_sent",
    reason: "signed_out",
  });
  assert.equal(log.rows.get(prepared.actionId).state, "cancelled");
  assert.equal(fake.calls.commit.length, 0);
});

test("a connection change between prepare and commit refuses the send", async () => {
  const { manager, fake, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  fake.setBinding({ accountId: "U2", workspaceId: "T1", generation: 2 });

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
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
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), { state: "unknown" });
  assert.equal(log.rows.get(actionId).state, "unknown");
});

test("a connector commit resolving undefined is recorded as unknown and never orphans the entry", async () => {
  const { manager, log } = await setup({
    async commit() {
      return undefined;
    },
  });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), { state: "unknown" });
  assert.equal(log.rows.get(actionId).state, "unknown");
  // The entry must not be orphaned in "committing": a second commit finds no pending action.
  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "not_found",
  });
});

test("an unknown commit keeps its errorCode on the receipt and in the finish log", async () => {
  const logger = recordingLogger();
  const checkUrl = "https://app.slack.com/client/T1/C1";
  const { manager, log } = await setup(
    {
      async commit() {
        return { state: "unknown", errorCode: "internal_error", checkUrl };
      },
    },
    undefined,
    { logger }
  );
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "unknown",
    checkUrl,
    errorCode: "internal_error",
  });
  const row = log.rows.get(actionId);
  assert.equal(row.state, "unknown");
  assert.equal(row.errorCode, "internal_error");
  assert.equal(row.resultUrl, checkUrl);
  const finished = logger.lines.find((line) => line.args[0] === "connector action finished");
  assert.equal(finished.args[1].state, "unknown");
  assert.equal(finished.args[1].errorCode, "internal_error");
});

test("a connector commit resolving an unrecognized state is recorded as unknown", async () => {
  const { manager, log } = await setup({
    async commit() {
      return { state: "banana" };
    },
  });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), { state: "unknown" });
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

    const result = await manager.runDirect("fake", "draft", {}, ALLOWED, {});

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
  const result = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
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
    assert.deepEqual(await manager.prepare("fake", "post", { text: "x" }, ALLOWED), expected);
    assert.equal(log.rows.size, 0);
  }

  const { manager } = await setup({
    async prepare() {
      throw new Error("token=abc123 rejected");
    },
  });
  assert.deepEqual(await manager.prepare("fake", "post", { text: "x" }, ALLOWED), {
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
  assert.deepEqual(await bindingThrows.manager.prepare("fake", "post", { text: "x" }, ALLOWED), {
    status: "unavailable",
    reason: "not_connected",
  });
  assert.deepEqual(await bindingThrows.manager.status(), [
    {
      id: "fake",
      connected: false,
      accountLabel: null,
      workspaceLabel: null,
      needsReconnect: false,
    },
  ]);

  const { manager, fake, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  fake.connector.getBinding = async () => {
    throw leaky;
  };
  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "connection_changed",
  });
  assert.equal(fake.calls.commit.length, 0);
  assert.equal(log.rows.get(actionId).state, "cancelled");
});

test("expired pending actions are swept and recorded as expired on the next call", async () => {
  const { PENDING_TTL_MS, createPendingActions } = await loadPending();
  let clock = 1_000;
  const { manager, log } = await setup(
    {},
    {},
    { pendingActions: createPendingActions({ now: () => clock }) }
  );
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  clock += PENDING_TTL_MS + 1;
  manager.recentActions("fake", 10, ACCOUNT);

  assert.equal(log.rows.get(actionId).state, "expired");
  assert.equal(log.rows.get(actionId).errorCode, "expired");
  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "not_found",
  });
});

test("cancel withdraws only pending actions and records the reason", async () => {
  const { manager, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  assert.deepEqual(manager.cancel(actionId, "conversation_ended"), { cancelled: true });
  assert.equal(log.rows.get(actionId).state, "cancelled");
  assert.equal(log.rows.get(actionId).errorCode, "conversation_ended");
  assert.deepEqual(manager.cancel(actionId, "cancelled_by_user"), { cancelled: false });

  const expiring = await manager.prepare("fake", "post", { text: "y" }, ALLOWED);
  manager.cancel(expiring.actionId, "expired");
  assert.equal(log.rows.get(expiring.actionId).state, "expired");
});

test("runDirect runs direct actions with the runtime and logs a receipt", async () => {
  const { manager, fake, log } = await setup();
  const runtime = { webContents: "sender" };

  const result = await manager.runDirect("fake", "draft", { to: ["a@b.co"] }, ALLOWED, runtime);

  assert.deepEqual(result, { state: "sent", destinationLabel: "gabe@example.test" });
  assert.equal(fake.calls.runDirect[0].runtime, runtime);
  const [row] = [...log.rows.values()];
  assert.equal(row.kind, "direct");
  assert.equal(row.state, "sent");
});

test("an action is only reachable through its own kind", async () => {
  const { manager } = await setup();
  assert.deepEqual(await manager.runDirect("fake", "post", {}, ALLOWED, {}), {
    state: "unavailable",
    reason: "unknown_action",
  });
  assert.deepEqual(await manager.prepare("fake", "draft", {}, ALLOWED), {
    status: "unavailable",
    reason: "unknown_action",
  });
  assert.deepEqual(await manager.prepare("nope", "post", {}, ALLOWED), {
    status: "unavailable",
    reason: "unknown_connector",
  });
});

test("edits are reduced to string title and body", async () => {
  const { manager, fake } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  await manager.commit(actionId, { body: "b", title: 5, channel: "C999" }, ALLOWED);
  assert.deepEqual(fake.calls.commit[0].edits, { body: "b" });
});

test("invalidate cancels pending actions for that connector", async () => {
  const { manager, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  assert.deepEqual(manager.invalidate("fake"), [actionId]);
  assert.equal(log.rows.get(actionId).errorCode, "connection_changed");
});

test("a pending row that can't be written means no card and no pending action", async () => {
  const { manager, log } = await setup({}, { failInsert: true });
  const result = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "receipt_unavailable");
  assert.equal(log.rows.size, 0);
});

test("the send never starts unless committing was durably recorded", async () => {
  const { manager, fake } = await setup({}, { failTransition: true });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "receipt_unavailable",
  });
  assert.equal(fake.calls.commit.length, 0);
  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "not_found",
  });
});

test("the send never starts when the committing write moves no row", async () => {
  const { manager, fake, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  log.rows.delete(actionId);

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "receipt_unavailable",
  });
  assert.equal(fake.calls.commit.length, 0);
});

test("a failed final write still reports the real outcome and leaves the row committing", async () => {
  const { manager, log } = await setup({}, { failFinal: true });
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
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

  await manager.runDirect("fake", "draft", {}, ALLOWED, {});

  assert.deepEqual(statesSeenByConnector, ["committing"]);
  const [row] = [...log.rows.values()];
  assert.equal(row.state, "sent");
  assert.equal(row.destinationLabel, "a@b.co");
});

test("a direct action whose record can't be written never runs", async () => {
  const { manager, fake } = await setup({}, { failInsert: true });
  assert.deepEqual(await manager.runDirect("fake", "draft", {}, ALLOWED, {}), {
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

  const { actionId } = await manager.prepare("fake", "post", { text: "hello" }, ALLOWED);

  // Start both commits concurrently (no await between them)
  const first = manager.commit(actionId, {}, ALLOWED);
  const second = manager.commit(actionId, {}, ALLOWED);

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

  const { actionId } = await manager.prepare("fake", "post", { text: "hello" }, ALLOWED);

  // Start commit (will be gated at call 2)
  const committing = manager.commit(actionId, {}, ALLOWED);

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

function recordingLogger() {
  const lines = [];
  const capture =
    (level) =>
    (...args) =>
      lines.push({ level, args });
  return { lines, info: capture("info"), warn: capture("warn"), error: capture("error") };
}

test("connector logs carry error names and codes, never messages", async () => {
  const logger = recordingLogger();
  const leaky = () =>
    Object.assign(
      new Error("POST https://slack.com/api/chat.postMessage?token=xoxp-secret failed"),
      {
        code: "ECONNRESET",
      }
    );

  const throwing = await setup(
    {
      async prepare() {
        throw leaky();
      },
      async runDirect() {
        throw leaky();
      },
    },
    undefined,
    { logger }
  );
  await throwing.manager.prepare("fake", "post", { text: "hi" }, ALLOWED);
  await throwing.manager.runDirect("fake", "draft", {}, ALLOWED, {});

  const committing = await setup(
    {
      async commit() {
        throw leaky();
      },
    },
    undefined,
    { logger }
  );
  const prepared = await committing.manager.prepare("fake", "post", { text: "hi" }, ALLOWED);
  await committing.manager.commit(prepared.actionId, {}, ALLOWED);

  const logged = JSON.stringify(logger.lines);
  assert.doesNotMatch(logged, /xoxp-secret|slack\.com/);
  assert.match(logged, /ECONNRESET/);
});

const VALID_PREVIEW = {
  verbKey: "default",
  destinationLabel: "#eng",
  accountLabel: "chad",
  body: "hi",
};
const NOT_CONNECTED = {
  connected: false,
  accountLabel: null,
  workspaceLabel: null,
  needsReconnect: false,
};

test("a malformed prepare result fails closed with no card and no receipt", async () => {
  for (const bad of [
    undefined,
    null,
    { status: "ready" },
    { status: "ready", payload: {}, preview: { verbKey: "default" } },
    { status: "weird" },
    { status: "needs_clarification" },
  ]) {
    const { manager, log } = await setup({
      async prepare() {
        return bad;
      },
    });
    assert.deepEqual(await manager.prepare("fake", "post", { text: "hi" }, ALLOWED), {
      status: "failed",
      errorCode: "invalid_result",
      message: "Couldn't prepare that action.",
    });
    assert.equal(log.rows.size, 0);
  }

  // A failure the connector reported stays a failure, with the default code
  // and message filled in.
  const { manager, log } = await setup({
    async prepare() {
      return { status: "failed" };
    },
  });
  assert.deepEqual(await manager.prepare("fake", "post", { text: "hi" }, ALLOWED), {
    status: "failed",
    errorCode: "prepare_failed",
    message: "Couldn't prepare that action.",
  });
  assert.equal(log.rows.size, 0);
});

test("a well-formed clarification keeps only its string candidates", async () => {
  const { manager } = await setup({
    async prepare() {
      return {
        status: "needs_clarification",
        message: "Which one?",
        candidates: ["A", 7, null, "B"],
      };
    },
  });
  assert.deepEqual(await manager.prepare("fake", "post", { text: "hi" }, ALLOWED), {
    status: "needs_clarification",
    message: "Which one?",
    candidates: ["A", "B"],
  });
});

test("a status or binding that throws or is malformed reads as not connected", async () => {
  const throwing = await setup({
    async getStatus() {
      throw new Error("disk");
    },
    async getBinding() {
      throw new Error("disk");
    },
  });
  assert.deepEqual(await throwing.manager.status(), [{ id: "fake", ...NOT_CONNECTED }]);
  assert.deepEqual(await throwing.manager.prepare("fake", "post", { text: "hi" }, ALLOWED), {
    status: "unavailable",
    reason: "not_connected",
  });

  const malformed = await setup({
    async getStatus() {
      return { connected: "yes", accountLabel: 7 };
    },
    async getBinding() {
      return { accountId: 42 };
    },
  });
  assert.deepEqual((await malformed.manager.status())[0], { id: "fake", ...NOT_CONNECTED });
  assert.equal(
    (await malformed.manager.prepare("fake", "post", { text: "hi" }, ALLOWED)).reason,
    "not_connected"
  );
});

test("the main process expires a card nobody answered, but never a committing one", async () => {
  const { createPendingActions } = await loadPending();
  const clock = { now: 1_000 };
  let finishSend;
  const { manager, fake, log } = await setup(
    {
      commit(action, payload, edits) {
        fake.calls.commit.push({ action, payload, edits });
        return new Promise((resolve) => {
          finishSend = resolve;
        });
      },
    },
    undefined,
    { pendingActions: createPendingActions({ now: () => clock.now }) }
  );
  const abandoned = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);
  const sending = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);
  const inFlight = manager.commit(sending.actionId, {}, ALLOWED);
  // Let commit's own await (fetching the binding to guard beginCommit) settle
  // and flip the entry to "committing" before the sweep runs, the same way an
  // in-flight IPC call would have already reserved it by the time a real
  // 60s-interval sweep landed.
  await new Promise((resolve) => setImmediate(resolve));

  clock.now += 10 * 60 * 1000 + 1;
  manager.sweepExpired();

  assert.equal(log.rows.get(abandoned.actionId).state, "expired");
  assert.equal(log.rows.get(sending.actionId).state, "committing");
  finishSend({ state: "sent" });
  assert.equal((await inFlight).state, "sent");
  assert.deepEqual(await manager.commit(abandoned.actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "not_found",
  });
  assert.equal(fake.calls.commit.length, 1);
});

test("receipts carry the account, and no account means no action", async () => {
  const { manager, fake, log } = await setup();
  const signedIn = { policyState: "allowed", accountId: "acct-1" };

  const prepared = await manager.prepare("fake", "post", { text: "hi" }, signedIn);
  assert.equal(log.rows.get(prepared.actionId).accountId, "acct-1");
  await manager.runDirect("fake", "draft", {}, signedIn, {});
  assert.ok([...log.rows.values()].every((row) => row.accountId === "acct-1"));
  assert.equal(manager.recentActions("fake", 10, "acct-1").length, 2);

  // Signed in, but no account could be pinned to the call (a signed-out call
  // is refused as signed_out by the policy check first).
  const noAccount = { policyState: "allowed", accountId: null };
  assert.deepEqual(await manager.prepare("fake", "post", { text: "hi" }, noAccount), {
    status: "failed",
    errorCode: "receipt_unavailable",
    message: "Couldn't record this action, so nothing was prepared.",
  });
  assert.deepEqual(await manager.runDirect("fake", "draft", {}, noAccount, {}), {
    state: "unavailable",
    reason: "receipt_unavailable",
  });
  assert.deepEqual(manager.recentActions("fake", 10, null), []);
  assert.equal(fake.calls.prepare.length, 1);
});

test("the connector acts only under the binding the action was prepared with", async () => {
  const { manager, fake } = await setup();
  const prepared = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);
  await manager.commit(prepared.actionId, {}, ALLOWED);

  const binding = { accountId: "U1", workspaceId: "T1", generation: 1 };
  assert.deepEqual(fake.calls.prepare[0].context, { binding });
  assert.deepEqual(fake.calls.commit[0].context, { binding });
});

const connectable = (overrides = {}) => ({
  async authorize() {
    return { accessToken: "new" };
  },
  async revoke() {},
  async getStatus() {
    return { connected: true, accountLabel: "chad", workspaceLabel: "Acme" };
  },
  ...overrides,
});

test("connect saves under the account that started it, cancels old approvals and announces", async () => {
  const credentials = memoryCredentials(null, { connectorId: "fake" });
  const announced = [];
  const { manager, log } = await setup(connectable(), undefined, {
    credentials,
    onStatusChanged: (statuses) => announced.push(statuses),
  });
  const prepared = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);

  assert.deepEqual(await manager.connect("fake", "allowed"), {
    status: "connected",
    accountLabel: "chad",
    workspaceLabel: "Acme",
  });
  assert.deepEqual(credentials.read("acct-1", "fake"), {
    credential: { accessToken: "new" },
    generation: 1,
  });
  assert.equal(log.rows.get(prepared.actionId).state, "cancelled");
  assert.equal(announced.length, 1);
});

test("an account switch during the OAuth round trip saves nothing and revokes the new login", async () => {
  let accountId = "acct-a";
  const credentials = memoryCredentials();
  const flow = deferred();
  const revoked = [];
  const { manager } = await setup(
    connectable({
      authorize: () => flow.promise,
      async revoke(credential) {
        revoked.push(credential);
      },
    }),
    undefined,
    { credentials, getAccountId: () => accountId }
  );

  const connecting = manager.connect("fake", "allowed");
  accountId = "acct-b";
  flow.resolve({ accessToken: "a-login" });

  assert.deepEqual(await connecting, { status: "failed", errorCode: "connection_changed" });
  assert.equal(credentials.read("acct-a", "fake"), null);
  assert.equal(credentials.read("acct-b", "fake"), null);
  assert.deepEqual(revoked, [{ accessToken: "a-login" }]);
});

test("a login that changed during the round trip is kept, and the late one is revoked", async () => {
  const credentials = memoryCredentials();
  const flow = deferred();
  const revoked = [];
  const { manager } = await setup(
    connectable({
      authorize: () => flow.promise,
      async revoke(credential) {
        revoked.push(credential);
      },
    }),
    undefined,
    { credentials }
  );

  const connecting = manager.connect("fake", "allowed");
  credentials.replace("acct-1", "fake", { accessToken: "other-window" }, 0);
  flow.resolve({ accessToken: "late" });

  assert.deepEqual(await connecting, { status: "failed", errorCode: "connection_changed" });
  assert.equal(credentials.read("acct-1", "fake").credential.accessToken, "other-window");
  assert.deepEqual(revoked, [{ accessToken: "late" }]);
});

// The real loopback flow, with Electron's shell stubbed out.
function loadLoopbackFlow() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return { shell: { openExternal: async () => {} } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../../src/helpers/oauthLoopbackFlow.js");
  } finally {
    Module._load = originalLoad;
  }
}

async function until(read) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

test("a second Connect cancels the abandoned sign-in, and only the new login is saved", async () => {
  const { runOAuthLoopbackFlow } = loadLoopbackFlow();
  const credentials = memoryCredentials(null, { connectorId: "fake" });
  const launches = [];
  const revoked = [];
  const { manager } = await setup(
    connectable({
      authorize: ({ signal } = {}) =>
        runOAuthLoopbackFlow({
          errorParam: "fake_error",
          signal,
          renderResultPage: () => "done",
          buildAuthUrl: (redirectUri, state) => {
            launches.push({ redirectUri, state });
            return "https://example.test/authorize";
          },
          handleCallback: async (code) => ({ accessToken: code }),
        }),
      async revoke(credential) {
        revoked.push(credential);
      },
    }),
    undefined,
    { credentials }
  );

  const first = manager.connect("fake", "allowed");
  await until(() => launches.length === 1);
  const second = manager.connect("fake", "allowed");

  assert.deepEqual(await first, { status: "failed", errorCode: "oauth_cancelled" });
  await until(() => launches.length === 2);
  const [abandoned, current] = launches;
  // The abandoned tab's server is gone.
  await assert.rejects(fetch(`${abandoned.redirectUri}/?code=late&state=${abandoned.state}`));
  await fetch(`${current.redirectUri}/?code=second&state=${current.state}`);

  assert.equal((await second).status, "connected");
  assert.deepEqual(credentials.read("acct-1", "fake").credential, { accessToken: "second" });
  assert.equal(launches.length, 2, "one browser launch per attempt");
  assert.deepEqual(revoked, [], "nothing was revoked for the cancelled attempt");
});

test("a sign-in that finishes after a newer Connect replaced it is revoked, never saved", async () => {
  const credentials = memoryCredentials(null, { connectorId: "fake" });
  const flows = [];
  const revoked = [];
  const { manager } = await setup(
    connectable({
      // Like a flow whose provider answered before the abort: it resolves.
      authorize: () => {
        const flow = deferred();
        flows.push(flow);
        return flow.promise;
      },
      async revoke(credential) {
        revoked.push(credential);
      },
    }),
    undefined,
    { credentials }
  );

  const first = manager.connect("fake", "allowed");
  const second = manager.connect("fake", "allowed");
  flows[0].resolve({ accessToken: "late" });

  assert.deepEqual(await first, { status: "failed", errorCode: "oauth_cancelled" });
  assert.deepEqual(revoked, [{ accessToken: "late" }]);
  assert.equal(credentials.read("acct-1", "fake"), null);

  flows[1].resolve({ accessToken: "second" });
  assert.equal((await second).status, "connected");
  assert.deepEqual(credentials.read("acct-1", "fake").credential, { accessToken: "second" });
});

test("connect refuses on policy or no account, and reports flow errors by code", async () => {
  const credentials = memoryCredentials();
  const refusing = await setup(connectable(), undefined, { credentials });
  assert.deepEqual(await refusing.manager.connect("fake", "blocked"), {
    status: "unavailable",
    reason: "policy_blocked",
  });

  const signedOut = await setup(connectable(), undefined, {
    credentials,
    getAccountId: () => null,
  });
  assert.deepEqual(await signedOut.manager.connect("fake", "allowed"), {
    status: "unavailable",
    reason: "signed_out",
  });

  for (const [thrown, errorCode] of [
    [Object.assign(new Error("OAuth flow timed out"), { code: "oauth_timeout" }), "oauth_timeout"],
    [
      Object.assign(new Error("x"), { redirectCode: "token_exchange_failed" }),
      "token_exchange_failed",
    ],
    [new Error("GET https://slack.com/api/oauth.v2.access?code=secret failed"), "connect_failed"],
  ]) {
    const failing = await setup(
      connectable({
        async authorize() {
          throw thrown;
        },
      }),
      undefined,
      { credentials }
    );
    assert.deepEqual(await failing.manager.connect("fake", "allowed"), {
      status: "failed",
      errorCode,
    });
  }
  assert.equal(credentials.read("acct-1", "fake"), null);
});

test("connect whose credential save fails for a real reason (not a race) logs it, revokes the new login, and reports credential_save_failed", async () => {
  const logger = recordingLogger();
  const credentials = memoryCredentials(null, { connectorId: "fake" });
  credentials.replace = () => {
    throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  };
  const revoked = [];
  const { manager } = await setup(
    connectable({
      async revoke(credential) {
        revoked.push(credential);
      },
    }),
    undefined,
    { credentials, logger }
  );

  assert.deepEqual(await manager.connect("fake", "allowed"), {
    status: "failed",
    errorCode: "credential_save_failed",
  });
  assert.deepEqual(revoked, [{ accessToken: "new" }]);
  const warnings = logger.lines.filter((line) => line.level === "warn");
  assert.equal(warnings.length, 1);
  const logged = JSON.stringify(warnings);
  assert.match(logged, /EIO/);
  assert.doesNotMatch(logged, /accessToken/);
});

test("disconnect revokes the stored login, clears it, cancels and announces; a failed revoke still disconnects", async () => {
  const credentials = memoryCredentials(
    { accessToken: "t", refreshToken: "r" },
    { connectorId: "fake" }
  );
  const revoked = [];
  const announced = [];
  const { manager, log } = await setup(
    connectable({
      async revoke(credential) {
        revoked.push(credential);
      },
    }),
    undefined,
    { credentials, onStatusChanged: (statuses) => announced.push(statuses) }
  );
  const prepared = await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);

  assert.deepEqual(await manager.disconnect("fake"), { status: "disconnected" });
  assert.deepEqual(revoked, [{ accessToken: "t", refreshToken: "r" }]);
  assert.equal(credentials.read("acct-1", "fake"), null);
  assert.equal(log.rows.get(prepared.actionId).state, "cancelled");
  assert.equal(announced.length, 1);

  const offline = await setup(
    connectable({
      async revoke() {
        throw new Error("offline");
      },
    }),
    undefined,
    { credentials: memoryCredentials({ accessToken: "t" }, { connectorId: "fake" }) }
  );
  assert.deepEqual(await offline.manager.disconnect("fake"), { status: "disconnected" });
});

test("a disconnect never deletes a login connected while it was revoking", async () => {
  const credentials = memoryCredentials({ accessToken: "old" }, { connectorId: "fake" });
  const revoking = deferred();
  const { manager } = await setup(connectable({ revoke: () => revoking.promise }), undefined, {
    credentials,
  });

  const disconnecting = manager.disconnect("fake");
  credentials.replace("acct-1", "fake", { accessToken: "new" }, 1);
  revoking.resolve();

  assert.deepEqual(await disconnecting, { status: "failed", errorCode: "connection_changed" });
  assert.equal(credentials.read("acct-1", "fake").credential.accessToken, "new");
});

test("disconnect whose credential clear fails for a real reason (not a race) logs it and reports disconnect_failed", async () => {
  const logger = recordingLogger();
  const credentials = memoryCredentials({ accessToken: "t" }, { connectorId: "fake" });
  credentials.clear = () => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  };
  const revoked = [];
  const { manager } = await setup(
    connectable({
      async revoke(credential) {
        revoked.push(credential);
      },
    }),
    undefined,
    { credentials, logger }
  );

  assert.deepEqual(await manager.disconnect("fake"), {
    status: "failed",
    errorCode: "disconnect_failed",
  });
  // The revoke already happened; the local slot wasn't cleared, so it isn't
  // pretended away.
  assert.deepEqual(revoked, [{ accessToken: "t" }]);
  assert.deepEqual(credentials.read("acct-1", "fake"), {
    credential: { accessToken: "t" },
    generation: 1,
  });
  const warnings = logger.lines.filter((line) => line.level === "warn");
  assert.equal(warnings.length, 1);
  const logged = JSON.stringify(warnings);
  assert.match(logged, /EPERM/);
  assert.doesNotMatch(logged, /accessToken/);
});

function loadAccountScopeBinding() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => require("node:os").tmpdir() } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../../src/helpers/accountScopeBinding.js");
  } finally {
    Module._load = originalLoad;
  }
}

// connectorCredentials over an in-memory store.
function memoryStore() {
  const slots = new Map();
  const generations = new Map();
  const bump = (slot) => generations.set(slot, (generations.get(slot) ?? 0) + 1);
  return {
    getGeneration: (slot) => generations.get(slot) ?? 0,
    read: (slot) => slots.get(slot) ?? null,
    replace: (slot, credential) => {
      slots.set(slot, credential);
      bump(slot);
    },
    save: (slot, credential) => slots.set(slot, credential),
    clear: (slot) => {
      slots.delete(slot);
      bump(slot);
    },
  };
}

test("logins are filed under the account the credential in use is bound to, as receipts are", async () => {
  const { resolveActiveAccountScope, hashToken } = loadAccountScopeBinding();
  const { connectorAccountIdFrom } = require("../../../src/helpers/connectors/connectorIpc.js");
  const {
    createConnectorCredentials,
  } = require("../../../src/helpers/connectors/connectorCredentials.js");
  // What main.js used to read: it doesn't move when one signed-in token
  // replaces another.
  const databaseManager = { activeAccountId: "account-a" };
  const tokenState = { token: "token-b", generation: 2 };
  let binding = null;
  const getAccountId = connectorAccountIdFrom(() =>
    resolveActiveAccountScope({ ...tokenState, binding })
  );
  const credentials = createConnectorCredentials({ store: memoryStore(), getAccountId });
  let authorized = 0;
  const { manager } = await setup(
    connectable({
      async authorize() {
        authorized += 1;
        return { accessToken: "b-login" };
      },
    }),
    undefined,
    { credentials, getAccountId }
  );

  // No validated scope for the token in use: refused before any sign-in.
  assert.deepEqual(await manager.connect("fake", "allowed"), {
    status: "unavailable",
    reason: "signed_out",
  });
  assert.equal(authorized, 0);
  assert.equal(credentials.read(databaseManager.activeAccountId, "fake"), null);

  binding = { version: 1, accountId: "account-b", tokenHash: hashToken("token-b") };
  assert.equal((await manager.connect("fake", "allowed")).status, "connected");
  assert.deepEqual(credentials.read("account-b", "fake").credential, { accessToken: "b-login" });
  assert.equal(credentials.read(databaseManager.activeAccountId, "fake"), null);
});

test("main files connector logins under the credential's account scope, not the database scope", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../../main.js"),
    "utf8"
  );
  const wiring = source.match(
    /const getConnectorAccountScope = ([\s\S]*?)\n\s+const connectorCredentials/
  );
  assert.ok(wiring, "main.js defines the connector account lookup");
  assert.match(wiring[1], /accountScopeBinding\.resolveActiveAccountScope\(/);
  assert.match(wiring[1], /require\("\.\/src\/helpers\/tokenStore"\)\.getState\(\)/);
  assert.match(
    wiring[1],
    /getConnectorAccountId = connectorAccountIdFrom\(getConnectorAccountScope\)/
  );
  assert.doesNotMatch(wiring[1], /databaseManager\.activeAccountId/);
});

test("disconnectAll disconnects every connector that can revoke", async () => {
  const credentials = memoryCredentials({ accessToken: "t" }, { connectorId: "fake" });
  const { manager } = await setup(connectable(), undefined, { credentials });
  await manager.disconnectAll();
  assert.equal(credentials.read("acct-1", "fake"), null);
});

test("only the newest status change is announced", async () => {
  const announced = [];
  const slowFirst = deferred();
  let reads = 0;
  const { manager } = await setup(
    {
      getStatus: () => {
        reads += 1;
        return reads === 1
          ? slowFirst.promise
          : Promise.resolve({ connected: false, accountLabel: null });
      },
    },
    undefined,
    { onStatusChanged: (statuses) => announced.push(statuses[0].connected) }
  );

  const older = manager.notifyStatusChanged();
  const newer = manager.notifyStatusChanged();
  await newer;
  slowFirst.resolve({ connected: true, accountLabel: "chad" });
  await older;

  assert.deepEqual(announced, [false]);
});

test("a reconnect_needed result announces the status change", async () => {
  const announced = [];
  const { manager } = await setup(
    {
      async prepare() {
        return { status: "failed", errorCode: "reconnect_needed", message: "Reconnect Slack." };
      },
    },
    undefined,
    { onStatusChanged: (statuses) => announced.push(statuses) }
  );

  await manager.prepare("fake", "post", { text: "hi" }, ALLOWED);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(announced.length, 1);
});

test("an action with no resolvable account is refused before any receipt or side effect", async () => {
  const { manager, fake, log } = await setup();
  const signedOut = { policyState: "allowed", accountId: null };

  assert.deepEqual(await manager.prepare("fake", "post", { text: "x" }, signedOut), {
    status: "failed",
    errorCode: "receipt_unavailable",
    message: "Couldn't record this action, so nothing was prepared.",
  });
  assert.deepEqual(await manager.runDirect("fake", "draft", {}, signedOut, {}), {
    state: "unavailable",
    reason: "receipt_unavailable",
  });
  assert.equal(fake.calls.prepare.length, 0);
  assert.equal(fake.calls.runDirect.length, 0);
  assert.equal(log.rows.size, 0);
});

test("receipts carry the account the action ran under, and only it sees them", async () => {
  const { manager, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  await manager.runDirect(
    "fake",
    "draft",
    {},
    { policyState: "allowed", accountId: "account-b" },
    {}
  );

  const rows = [...log.rows.values()];
  assert.equal(log.rows.get(actionId).accountId, ACCOUNT);
  assert.equal(rows.find((row) => row.kind === "direct").accountId, "account-b");
  assert.deepEqual(
    manager.recentActions("fake", 10, ACCOUNT).map((row) => row.id),
    [actionId]
  );
  assert.deepEqual(manager.recentActions("fake", 10, null), []);
});

test("an approval prepared by one account can't be sent by another", async () => {
  for (const accountId of ["account-b", null]) {
    const { manager, fake, log } = await setup();
    const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);

    assert.deepEqual(await manager.commit(actionId, {}, { policyState: "allowed", accountId }), {
      state: "not_sent",
      reason: "account_changed",
    });
    assert.equal(fake.calls.commit.length, 0);
    assert.equal(log.rows.get(actionId).state, "cancelled");
    assert.equal(log.rows.get(actionId).errorCode, "account_changed");
    // Withdrawn, so its own account can't send it later either.
    assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
      state: "not_sent",
      reason: "not_found",
    });
  }
});

test("a commit refused by policy withdraws the action for good", async () => {
  const { manager, fake } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  await manager.commit(actionId, {}, { policyState: "blocked", accountId: ACCOUNT });

  assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "not_found",
  });
  assert.equal(fake.calls.commit.length, 0);
});

test("prepare and commit each sweep other expired actions", async () => {
  const { PENDING_TTL_MS, createPendingActions } = await loadPending();
  let clock = 1_000;
  const { manager, log } = await setup(
    {},
    {},
    { pendingActions: createPendingActions({ now: () => clock }) }
  );

  const stale = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  clock += PENDING_TTL_MS + 1;
  await manager.prepare("fake", "post", { text: "y" }, ALLOWED);
  assert.equal(log.rows.get(stale.actionId).state, "expired");

  const older = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  clock += PENDING_TTL_MS - 1_000;
  const fresh = await manager.prepare("fake", "post", { text: "y" }, ALLOWED);
  clock += 2_000;
  assert.equal(log.rows.get(older.actionId).state, "pending");
  assert.equal((await manager.commit(fresh.actionId, {}, ALLOWED)).state, "sent");
  assert.equal(log.rows.get(older.actionId).state, "expired");
});

test("a cancel reason outside the known set is recorded as the user's cancel", async () => {
  const { manager, log } = await setup();
  const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  manager.cancel(actionId, "<img src=x>");
  assert.equal(log.rows.get(actionId).errorCode, "cancelled_by_user");
});

test("recent actions asks for at most 50 rows and defaults to 10", async () => {
  const { manager, log } = await setup();
  const limits = [];
  log.listRecent = (connector, limit) => {
    limits.push(limit);
    return [];
  };
  manager.recentActions("fake", 500, ACCOUNT);
  manager.recentActions("fake", -1, ACCOUNT);
  manager.recentActions("fake", "5", ACCOUNT);
  manager.recentActions("fake", 5, ACCOUNT);
  assert.deepEqual(limits, [50, 10, 10, 5]);
});

test("a commit result keeps only its state's fields, typed, and its receipt still lands", async () => {
  const cases = [
    [{ state: "sent", url: { href: "x" }, raw: "LEAK" }, { state: "sent" }],
    [
      { state: "sent", url: "https://example.test/p/2", token: "xoxb" },
      { state: "sent", url: "https://example.test/p/2" },
    ],
    [
      { state: "failed", errorCode: 5, message: { text: "raw" }, headers: "Bearer abc" },
      { state: "failed", errorCode: "action_failed", message: "That action didn't go through." },
    ],
    [{ state: "unknown", checkUrl: ["x"] }, { state: "unknown" }],
    [{ state: "not_sent", reason: "cancelled" }, { state: "unknown" }],
  ];
  for (const [committed, expected] of cases) {
    const { manager, log } = await setup({ commit: async () => committed });
    const { actionId } = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
    assert.deepEqual(await manager.commit(actionId, {}, ALLOWED), expected);
    assert.equal(log.rows.get(actionId).state, expected.state);
  }
});

test("a direct result keeps only its state's fields, typed, and its receipt still lands", async () => {
  const cases = [
    [
      {
        state: "sent",
        destinationLabel: ["a@b.co"],
        bodyCopied: "yes",
        copyFailed: true,
        url: "https://mail.test/?body=secret",
      },
      { state: "sent", destinationLabel: "", copyFailed: true },
      "sent",
    ],
    [
      { state: "failed", errorCode: "open_failed", message: "Couldn't open.", debug: { a: 1 } },
      { state: "failed", errorCode: "open_failed", message: "Couldn't open." },
      "failed",
    ],
    [
      { state: "failed", errorCode: { code: 1 }, destinationLabel: "a@b.co" },
      {
        state: "failed",
        errorCode: "action_failed",
        message: "That action didn't go through.",
        destinationLabel: "a@b.co",
      },
      "failed",
    ],
    [
      { state: "not_sent", reason: "cancelled", extra: 1 },
      { state: "not_sent", reason: "cancelled" },
      "cancelled",
    ],
  ];
  for (const [ran, expected, receiptState] of cases) {
    const { manager, log } = await setup({ runDirect: async () => ran });
    assert.deepEqual(await manager.runDirect("fake", "draft", {}, ALLOWED, {}), expected);
    assert.equal([...log.rows.values()][0].state, receiptState);
  }
});

test("a connector can't claim a direct outcome only main may report", async () => {
  for (const state of ["unavailable", "unknown", "committing"]) {
    const { manager, log } = await setup({ runDirect: async () => ({ state, reason: "x" }) });
    const result = await manager.runDirect("fake", "draft", {}, ALLOWED, {});
    assert.equal(result.state, "unknown");
    assert.equal(result.errorCode, "invalid_result");
    assert.equal([...log.rows.values()][0].state, "unknown");
  }
});

test("a prepare failure with a non-string code or message falls back to the defaults", async () => {
  const { manager } = await setup({
    prepare: async () => ({ status: "failed", errorCode: { raw: "x" }, message: 42 }),
  });
  assert.deepEqual(await manager.prepare("fake", "post", { text: "x" }, ALLOWED), {
    status: "failed",
    errorCode: "prepare_failed",
    message: "Couldn't prepare that action.",
  });
});

test("a preview reaches the card with only its defined, typed fields", async () => {
  const preview = {
    verbKey: "default",
    destinationLabel: "#eng",
    accountLabel: "chad",
    workspaceLabel: 7,
    title: "Standup",
    body: "hi",
    internal: "LEAK",
    notes: [{ key: "thread", values: { name: "x", token: {} }, raw: 1 }, { key: 3 }, null],
  };
  const { manager } = await setup({
    prepare: async () => ({ status: "ready", payload: {}, preview }),
  });
  const prepared = await manager.prepare("fake", "post", { text: "x" }, ALLOWED);
  assert.deepEqual(prepared.preview, {
    verbKey: "default",
    destinationLabel: "#eng",
    accountLabel: "chad",
    title: "Standup",
    body: "hi",
    notes: [{ key: "thread", values: { name: "x" } }],
  });

  for (const field of ["verbKey", "destinationLabel", "accountLabel", "body"]) {
    const broken = await setup({
      prepare: async () => ({
        status: "ready",
        payload: {},
        preview: { ...preview, [field]: { toString: () => "x" } },
      }),
    });
    const result = await broken.manager.prepare("fake", "post", { text: "x" }, ALLOWED);
    assert.equal(result.errorCode, "invalid_result", field);
    assert.equal(broken.log.rows.size, 0);
  }
});

test("Esc during the Linux mail-app probe stops the draft before it opens or copies", async () => {
  const [{ createConnectorManager }, { createPendingActions }, { createEmailConnector }] =
    await Promise.all([
      loadManager(),
      loadPending(),
      import("../../../src/helpers/connectors/emailConnector.js"),
    ]);
  const controller = new AbortController();
  const opened = [];
  const copied = [];
  const email = createEmailConnector({
    platform: "linux",
    openExternal: async (url) => opened.push(url),
    writeClipboard: async (text) => copied.push(text),
    // The user presses Esc while xdg-mime is still answering.
    hasMailtoHandler: async () => {
      controller.abort();
      return true;
    },
  });
  const log = fakeLog();
  const manager = createConnectorManager({
    connectors: [email],
    pendingActions: createPendingActions(),
    actionLog: log,
    logger: silentLogger,
  });

  const result = await manager.runDirect(
    "email",
    "draft",
    {
      target: "mailto",
      to: ["gabe@example.com"],
      subject: "Notes",
      body: "x".repeat(5_000),
      clipboardReserved: true,
    },
    ALLOWED,
    { webContents: null, signal: controller.signal }
  );

  assert.deepEqual(result, { state: "not_sent", reason: "cancelled" });
  assert.deepEqual(opened, []);
  assert.deepEqual(copied, []);
  const [row] = [...log.rows.values()];
  assert.equal(row.state, "cancelled");
  assert.equal(row.errorCode, "cancelled");
});
