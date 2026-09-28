const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const load = () => import("../../src/stores/connectorApprovalStore.ts");

const PREVIEW = {
  verbKey: "default",
  destinationLabel: "#eng",
  accountLabel: "chad",
  body: "Hello team",
};

function fakeElectron(commitImpl) {
  const calls = { commit: [], cancel: [] };
  return {
    calls,
    api: {
      connectorCommit: async (actionId, edits) => {
        calls.commit.push({ actionId, edits });
        return commitImpl ? commitImpl() : { state: "sent", url: "https://slack.test/p/1" };
      },
      connectorCancel: async (actionId, reason) => {
        calls.cancel.push({ actionId, reason });
        return { cancelled: true };
      },
    },
  };
}

function context(toolCallId, controller = new AbortController(), messageId = "m1") {
  let requested = 0;
  return {
    controller,
    requestedCount: () => requested,
    value: {
      messageId,
      toolCallId,
      signal: controller.signal,
      onApprovalRequested: () => {
        requested += 1;
      },
    },
  };
}

const keyOf = (store, toolCallId, messageId = "m1") => store.approvalKey(messageId, toolCallId);

async function freshStore() {
  const store = await load();
  store.useConnectorApprovalStore.setState({ entries: {} });
  return store;
}

test("a request shows a pending card and tells the surface", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const ctx = context("call-1");

  void store.requestApproval(ctx.value, { actionId: "a1", connectorId: "slack", preview: PREVIEW });

  assert.equal(
    store.useConnectorApprovalStore.getState().entries[keyOf(store, "call-1")].state,
    "pending"
  );
  assert.equal(ctx.requestedCount(), 1);
  // Settle it so the 10-minute expiry timer doesn't keep the test process alive.
  store.cancelApproval(keyOf(store, "call-1"));
});

test("Send commits the edited draft once and reports the edited text", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-2").value, {
    actionId: "a2",
    connectorId: "slack",
    preview: PREVIEW,
  });

  store.updateApprovalDraft(keyOf(store, "call-2"), { body: "Hello team!" });
  await Promise.all([
    store.approveAction(keyOf(store, "call-2")),
    store.approveAction(keyOf(store, "call-2")),
  ]);

  assert.deepEqual(await outcome, {
    state: "sent",
    url: "https://slack.test/p/1",
    finalText: "Hello team!",
  });
  assert.deepEqual(electron.calls.commit, [{ actionId: "a2", edits: { body: "Hello team!" } }]);
  assert.equal(
    store.useConnectorApprovalStore.getState().entries[keyOf(store, "call-2")].state,
    "sent"
  );
});

test("an unedited send commits the preview text and reports no edit", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-8").value, {
    actionId: "a8",
    connectorId: "slack",
    preview: PREVIEW,
  });

  await store.approveAction(keyOf(store, "call-8"));

  assert.deepEqual(await outcome, { state: "sent", url: "https://slack.test/p/1" });
  assert.deepEqual(electron.calls.commit[0].edits, { body: "Hello team" });
});

test("the draft is frozen once sending starts, and a title needs a titled preview", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-9").value, {
    actionId: "a9",
    connectorId: "slack",
    preview: PREVIEW,
  });

  store.updateApprovalDraft(keyOf(store, "call-9"), { title: "Not allowed" });
  const sending = store.approveAction(keyOf(store, "call-9"));
  store.updateApprovalDraft(keyOf(store, "call-9"), { body: "Too late" });
  await sending;
  await outcome;

  assert.deepEqual(electron.calls.commit[0].edits, { body: "Hello team" });
});

test("Cancel withdraws a pending card", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-3").value, {
    actionId: "a3",
    connectorId: "slack",
    preview: PREVIEW,
  });

  store.cancelApproval(keyOf(store, "call-3"));

  assert.deepEqual(await outcome, { state: "cancelled" });
  assert.deepEqual(electron.calls.cancel, [{ actionId: "a3", reason: "cancelled_by_user" }]);
});

test("ending the conversation withdraws a pending card", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const ctx = context("call-4");
  const outcome = store.requestApproval(ctx.value, {
    actionId: "a4",
    connectorId: "slack",
    preview: PREVIEW,
  });

  ctx.controller.abort();

  assert.deepEqual(await outcome, { state: "not_sent", reason: "conversation_ended" });
  assert.deepEqual(electron.calls.cancel, [{ actionId: "a4", reason: "conversation_ended" }]);
});

test("ending the conversation during Send keeps the real result", async (t) => {
  let releaseCommit;
  const electron = fakeElectron(
    () =>
      new Promise((resolve) => {
        releaseCommit = () => resolve({ state: "sent", url: "https://slack.test/p/5" });
      })
  );
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const ctx = context("call-5");
  const outcome = store.requestApproval(ctx.value, {
    actionId: "a5",
    connectorId: "slack",
    preview: PREVIEW,
  });

  const sending = store.approveAction(keyOf(store, "call-5"));
  ctx.controller.abort();
  releaseCommit();
  await sending;

  assert.deepEqual(await outcome, { state: "sent", url: "https://slack.test/p/5" });
  assert.equal(electron.calls.cancel.length, 0);
});

test("a commit IPC failure is reported as unknown, never as not sent", async (t) => {
  const electron = fakeElectron(() => {
    throw new Error("ipc channel closed");
  });
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-6").value, {
    actionId: "a6",
    connectorId: "slack",
    preview: PREVIEW,
  });

  await store.approveAction(keyOf(store, "call-6"));

  assert.deepEqual(await outcome, { state: "unknown" });
});

test("an unanswered card expires after ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-7").value, {
    actionId: "a7",
    connectorId: "slack",
    preview: PREVIEW,
  });

  t.mock.timers.tick(store.APPROVAL_TTL_MS);

  assert.deepEqual(await outcome, { state: "not_sent", reason: "expired" });
  assert.deepEqual(electron.calls.cancel, [{ actionId: "a7", reason: "expired" }]);
});

test("a commit result with the wrong key settles as unknown instead of hanging", async (t) => {
  const electron = fakeElectron(() => ({ status: "sent", url: "https://slack.test/p/10" }));
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-10").value, {
    actionId: "a10",
    connectorId: "slack",
    preview: PREVIEW,
  });

  await store.approveAction(keyOf(store, "call-10"));

  assert.deepEqual(await outcome, { state: "unknown" });
  assert.equal(
    store.useConnectorApprovalStore.getState().entries[keyOf(store, "call-10")].state,
    "unknown"
  );
});

test("a commit result with an unknown state settles as unknown instead of hanging", async (t) => {
  const electron = fakeElectron(() => ({ state: "bogus" }));
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-12").value, {
    actionId: "a12",
    connectorId: "slack",
    preview: PREVIEW,
  });

  await store.approveAction(keyOf(store, "call-12"));

  assert.deepEqual(await outcome, { state: "unknown" });
  assert.equal(
    store.useConnectorApprovalStore.getState().entries[keyOf(store, "call-12")].state,
    "unknown"
  );
});

test("a commit result that resolves undefined settles as unknown", async (t) => {
  const electron = fakeElectron(() => undefined);
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-11").value, {
    actionId: "a11",
    connectorId: "slack",
    preview: PREVIEW,
  });

  await store.approveAction(keyOf(store, "call-11"));

  assert.deepEqual(await outcome, { state: "unknown" });
  assert.equal(
    store.useConnectorApprovalStore.getState().entries[keyOf(store, "call-11")].state,
    "unknown"
  );
});

test("a duplicate request for the same tool call cancels the new action and leaves the first alone", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const ctx = context("call-12");
  const firstOutcome = store.requestApproval(ctx.value, {
    actionId: "a12-first",
    connectorId: "slack",
    preview: PREVIEW,
  });

  const secondOutcome = store.requestApproval(ctx.value, {
    actionId: "a12-second",
    connectorId: "slack",
    preview: PREVIEW,
  });

  assert.deepEqual(await secondOutcome, { state: "not_sent", reason: "duplicate_tool_call" });
  assert.deepEqual(electron.calls.cancel, [
    { actionId: "a12-second", reason: "cancelled_by_user" },
  ]);

  const entry = store.useConnectorApprovalStore.getState().entries[keyOf(store, "call-12")];
  assert.equal(entry.state, "pending");
  assert.equal(entry.actionId, "a12-first");

  await store.approveAction(keyOf(store, "call-12"));

  assert.deepEqual(await firstOutcome, { state: "sent", url: "https://slack.test/p/1" });
  assert.deepEqual(electron.calls.commit, [
    { actionId: "a12-first", edits: { body: "Hello team" } },
  ]);
});

test("a policy check that couldn't finish returns the card to pending", async (t) => {
  let attempt = 0;
  const electron = fakeElectron(() => {
    attempt += 1;
    return attempt === 1
      ? { state: "not_sent", reason: "policy_unavailable", retryable: true }
      : { state: "sent", url: "https://slack.test/p/2" };
  });
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-r").value, {
    actionId: "ar",
    connectorId: "slack",
    preview: PREVIEW,
  });
  const key = keyOf(store, "call-r");

  await store.approveAction(key);
  const afterFirst = store.useConnectorApprovalStore.getState().entries[key];
  assert.equal(afterFirst.state, "pending");
  assert.equal(afterFirst.notice, "policy_retry");

  await store.approveAction(key);
  assert.deepEqual(await outcome, { state: "sent", url: "https://slack.test/p/2" });
  assert.equal(store.useConnectorApprovalStore.getState().entries[key].notice, undefined);
  assert.equal(electron.calls.commit.length, 2);
});

test("a conversation that ended during a retryable Send withdraws the card", async (t) => {
  const controller = new AbortController();
  const electron = fakeElectron(() => {
    controller.abort();
    return { state: "not_sent", reason: "policy_unavailable", retryable: true };
  });
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const outcome = store.requestApproval(context("call-s", controller).value, {
    actionId: "as",
    connectorId: "slack",
    preview: PREVIEW,
  });

  await store.approveAction(keyOf(store, "call-s"));

  assert.deepEqual(await outcome, { state: "not_sent", reason: "conversation_ended" });
  assert.deepEqual(
    electron.calls.cancel.map((call) => call.reason),
    ["conversation_ended"]
  );
});

test("the same tool-call id on two messages gets two separate cards", async (t) => {
  const electron = fakeElectron();
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await freshStore();
  const first = store.requestApproval(context("call-1", undefined, "msg-a").value, {
    actionId: "a1",
    connectorId: "slack",
    preview: PREVIEW,
  });
  const second = store.requestApproval(context("call-1", undefined, "msg-b").value, {
    actionId: "a2",
    connectorId: "slack",
    preview: PREVIEW,
  });

  const entries = store.useConnectorApprovalStore.getState().entries;
  assert.equal(entries[keyOf(store, "call-1", "msg-a")].actionId, "a1");
  assert.equal(entries[keyOf(store, "call-1", "msg-b")].actionId, "a2");
  assert.deepEqual(electron.calls.cancel, [], "a reused id on a new message is not a duplicate");

  await store.approveAction(keyOf(store, "call-1", "msg-b"));
  assert.deepEqual(
    electron.calls.commit.map((call) => call.actionId),
    ["a2"]
  );
  assert.equal((await second).state, "sent");

  store.cancelApproval(keyOf(store, "call-1", "msg-a"));
  assert.equal((await first).state, "cancelled");
});
