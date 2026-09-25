const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/pendingActions.js");

const BINDING = { accountId: "U1", workspaceId: "T1", generation: 1 };

function makeStore(overrides = {}) {
  let clock = 1_000;
  let counter = 0;
  return load().then(({ createPendingActions }) => ({
    store: createPendingActions({
      now: () => clock,
      randomId: () => `action-${++counter}`,
      ...overrides,
    }),
    advance: (ms) => {
      clock += ms;
    },
  }));
}

function prepareOne(store, connectorId = "slack") {
  return store.create({
    connectorId,
    action: "send_message",
    binding: BINDING,
    payload: { channel: "C1" },
    preview: { destinationLabel: "#eng" },
  });
}

test("a created action is pending and readable", async () => {
  const { store } = await makeStore();
  const actionId = prepareOne(store);
  assert.equal(actionId, "action-1");
  assert.equal(store.get(actionId).state, "pending");
  assert.deepEqual(store.get(actionId).payload, { channel: "C1" });
});

test("beginCommit moves a pending action to committing exactly once", async () => {
  const { store } = await makeStore();
  const actionId = prepareOne(store);

  const first = store.beginCommit(actionId, { ...BINDING });
  const second = store.beginCommit(actionId, { ...BINDING });

  assert.equal(first.ok, true);
  assert.equal(first.entry.state, "committing");
  assert.deepEqual(second, { ok: false, reason: "not_pending" });
});

test("cancel is refused once an action is committing", async () => {
  const { store } = await makeStore();
  const actionId = prepareOne(store);
  store.beginCommit(actionId, { ...BINDING });

  assert.equal(store.cancel(actionId), false);
  assert.equal(store.get(actionId).state, "committing");
});

test("finish only settles committing actions and then forgets them", async () => {
  const { store } = await makeStore();
  const actionId = prepareOne(store);
  assert.equal(store.finish(actionId), false);

  store.beginCommit(actionId, { ...BINDING });
  assert.equal(store.finish(actionId), true);
  assert.equal(store.get(actionId), null);
  assert.deepEqual(store.beginCommit(actionId, BINDING), { ok: false, reason: "not_found" });
});

test("a pending action expires after the TTL", async () => {
  const { PENDING_TTL_MS } = await load();
  const { store, advance } = await makeStore();
  const actionId = prepareOne(store);

  advance(PENDING_TTL_MS + 1);

  assert.deepEqual(store.beginCommit(actionId, BINDING), { ok: false, reason: "expired" });
  assert.equal(store.get(actionId), null);
});

test("sweepExpired drops only expired pending actions", async () => {
  const { PENDING_TTL_MS } = await load();
  const { store, advance } = await makeStore();
  const stale = prepareOne(store);
  const committing = prepareOne(store);
  store.beginCommit(committing, BINDING);
  advance(PENDING_TTL_MS + 1);
  const fresh = prepareOne(store);

  assert.deepEqual(store.sweepExpired(), [stale]);
  assert.equal(store.get(stale), null);
  assert.equal(store.get(committing).state, "committing");
  assert.equal(store.get(fresh).state, "pending");
});

test("a changed account, workspace or generation refuses the commit", async () => {
  const { store } = await makeStore();
  for (const changed of [
    { ...BINDING, accountId: "U2" },
    { ...BINDING, workspaceId: "T2" },
    { ...BINDING, generation: 2 },
    null,
  ]) {
    const actionId = prepareOne(store);
    assert.deepEqual(store.beginCommit(actionId, changed), {
      ok: false,
      reason: "connection_changed",
    });
    assert.equal(store.get(actionId), null);
  }
});

test("invalidateConnector cancels only that connector's pending actions", async () => {
  const { store } = await makeStore();
  const slackPending = prepareOne(store, "slack");
  const slackCommitting = prepareOne(store, "slack");
  const linearPending = prepareOne(store, "linear");
  store.beginCommit(slackCommitting, BINDING);

  assert.deepEqual(store.invalidateConnector("slack"), [slackPending]);
  assert.equal(store.get(slackPending), null);
  assert.equal(store.get(slackCommitting).state, "committing");
  assert.equal(store.get(linearPending).state, "pending");
});

test("the default id generator returns distinct 128-bit hex ids", async () => {
  const { createPendingActions } = await load();
  const store = createPendingActions();
  const ids = new Set(Array.from({ length: 50 }, () => prepareOne(store)));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});
