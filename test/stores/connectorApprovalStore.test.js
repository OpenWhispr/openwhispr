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

const EMAIL_FIELDS = {
  to: ["josh@acme.test"],
  cc: ["sam@acme.test"],
  subject: "Q3 numbers",
  body: "Numbers attached.",
};
const EMAIL_PREVIEW = {
  verbKey: "email",
  destinationLabel: "josh@acme.test",
  accountLabel: "you@example.test",
  body: EMAIL_FIELDS.body,
  fields: EMAIL_FIELDS,
};
const SENT = { state: "sent", url: "https://mail.google.test/#sent/1" };

// The cleanup is registered before installBrowserGlobals's own (which
// removes window), so a test that fails before Send or Cancel never leaves a
// card's 10-minute expiry timer holding the process open.
async function emailCards(t, commitImpl = () => SENT) {
  const keys = [];
  let store;
  t.after(() => keys.forEach((key) => store?.cancelApproval(key)));
  const electron = fakeElectron(commitImpl);
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  store = await freshStore();
  const request = (toolCallId, preview = EMAIL_PREVIEW) => {
    keys.push(keyOf(store, toolCallId));
    return store.requestApproval(context(toolCallId).value, {
      actionId: `a-${toolCallId}`,
      connectorId: preview === EMAIL_PREVIEW ? "gmail" : "slack",
      preview,
    });
  };
  const draftOf = (toolCallId) =>
    store.useConnectorApprovalStore.getState().entries[keyOf(store, toolCallId)].draft;
  return { store, electron, request, draftOf, key: (toolCallId) => keyOf(store, toolCallId) };
}

test("an email card starts from the preview's fields and Send commits exactly what it shows", async (t) => {
  const { store, electron, request, draftOf, key } = await emailCards(t);
  const outcome = request("call-20");

  assert.deepEqual(draftOf("call-20").fields, EMAIL_FIELDS);
  assert.notEqual(draftOf("call-20").fields.to, EMAIL_FIELDS.to, "the draft owns its lists");

  store.updateApprovalDraft(key("call-20"), {
    fields: { to: ["josh@acme.test", "dana@acme.test"] },
  });
  store.updateApprovalDraft(key("call-20"), { fields: { subject: "Q3 numbers (final)" } });
  const onCard = draftOf("call-20").fields;
  await store.approveAction(key("call-20"));

  const edited = {
    to: ["josh@acme.test", "dana@acme.test"],
    cc: ["sam@acme.test"],
    subject: "Q3 numbers (final)",
    body: "Numbers attached.",
  };
  assert.deepEqual(onCard, edited);
  assert.deepEqual(electron.calls.commit, [{ actionId: "a-call-20", edits: edited }]);
  assert.deepEqual(await outcome, { ...SENT, final: edited });
  assert.deepEqual(EMAIL_FIELDS.to, ["josh@acme.test"], "the preview is untouched");
});

test("an unedited email, or one edited back to the original, reports no final fields", async (t) => {
  const { store, electron, request, key } = await emailCards(t);

  const untouched = request("call-21");
  await store.approveAction(key("call-21"));
  assert.deepEqual(await untouched, SENT);
  assert.deepEqual(electron.calls.commit[0].edits, EMAIL_FIELDS);

  const reverted = request("call-22");
  store.updateApprovalDraft(key("call-22"), { fields: { to: ["dana@acme.test"] } });
  store.updateApprovalDraft(key("call-22"), { fields: { to: ["josh@acme.test"] } });
  await store.approveAction(key("call-22"));
  assert.deepEqual(await reverted, SENT);
});

test("a card takes edits only to the fields it shows, in the same shape", async (t) => {
  const { store, electron, request, draftOf, key } = await emailCards(t);
  const outcome = request("call-23");

  store.updateApprovalDraft(key("call-23"), {
    fields: { bcc: ["evil@attacker.test"], to: "josh@acme.test", subject: ["Q3"] },
  });
  assert.deepEqual(draftOf("call-23").fields, EMAIL_FIELDS);
  store.cancelApproval(key("call-23"));
  await outcome;

  // A card without fields (Slack's) ignores them and commits its text.
  const slack = request("call-24", PREVIEW);
  store.updateApprovalDraft(key("call-24"), { fields: { to: ["x@y.test"] } });
  await store.approveAction(key("call-24"));
  await slack;
  assert.equal("fields" in draftOf("call-24"), false);
  assert.deepEqual(electron.calls.commit.at(-1), {
    actionId: "a-call-24",
    edits: { body: "Hello team" },
  });
});

test("an email card's fields are frozen once sending starts", async (t) => {
  const { store, electron, request, draftOf, key } = await emailCards(t);
  const outcome = request("call-25");

  const sending = store.approveAction(key("call-25"));
  store.updateApprovalDraft(key("call-25"), { fields: { to: ["late@acme.test"] } });
  await sending;

  assert.deepEqual(electron.calls.commit[0].edits, EMAIL_FIELDS);
  assert.deepEqual(draftOf("call-25").fields, EMAIL_FIELDS);
  assert.deepEqual(await outcome, SENT);
});

test("the recipients main reports after Send reach the card and the outcome", async (t) => {
  let reply;
  const { store, request, key } = await emailCards(t, () => reply);

  reply = { ...SENT, destinationLabel: "dana@acme.test" };
  const sent = request("call-26");
  store.updateApprovalDraft(key("call-26"), { fields: { to: ["dana@acme.test"] } });
  await store.approveAction(key("call-26"));
  assert.equal((await sent).destinationLabel, "dana@acme.test");
  assert.equal(
    store.useConnectorApprovalStore.getState().entries[key("call-26")].destinationLabel,
    "dana@acme.test"
  );

  reply = {
    state: "unknown",
    checkUrl: "https://mail.google.test/#sent",
    destinationLabel: "dana@acme.test",
  };
  const unknown = request("call-27");
  await store.approveAction(key("call-27"));
  assert.deepEqual(await unknown, {
    state: "unknown",
    checkUrl: "https://mail.google.test/#sent",
    destinationLabel: "dana@acme.test",
  });

  reply = { ...SENT, destinationLabel: "" };
  const blank = request("call-28");
  await store.approveAction(key("call-28"));
  assert.deepEqual(await blank, SENT, "an empty label is ignored");
});

test("a failed or unknown Send still reports what the user changed on the card", async (t) => {
  let reply;
  const { store, request, key } = await emailCards(t, () => reply);

  reply = { state: "failed", errorCode: "network", message: "offline" };
  const failed = request("call-29");
  store.updateApprovalDraft(key("call-29"), { fields: { cc: [], subject: "Q3 (final)" } });
  await store.approveAction(key("call-29"));
  assert.deepEqual(await failed, {
    ...reply,
    final: { ...EMAIL_FIELDS, cc: [], subject: "Q3 (final)" },
  });

  const unedited = request("call-2a");
  await store.approveAction(key("call-2a"));
  assert.deepEqual(await unedited, reply, "nothing changed, nothing reported");

  // A card without fields reports its edited text the same way.
  reply = { state: "unknown" };
  const slack = request("call-2b", PREVIEW);
  store.updateApprovalDraft(key("call-2b"), { body: "Hello team, updated" });
  await store.approveAction(key("call-2b"));
  assert.deepEqual(await slack, { state: "unknown", finalText: "Hello team, updated" });
});

test("a malformed commit result settles an email card as unknown, never sent", async (t) => {
  let reply;
  const { store, request, key } = await emailCards(t, () => reply);
  for (const [index, raw] of [
    { state: "bogus" },
    { status: "sent" },
    undefined,
    "sent",
  ].entries()) {
    reply = raw;
    const toolCallId = `call-3${index}`;
    const outcome = request(toolCallId);
    store.updateApprovalDraft(key(toolCallId), { fields: { subject: "Edited" } });
    await store.approveAction(key(toolCallId));
    // The user's edit still reaches the model, since it may have gone out.
    assert.deepEqual(
      await outcome,
      { state: "unknown", final: { ...EMAIL_FIELDS, subject: "Edited" } },
      JSON.stringify(raw)
    );
    assert.equal(
      store.useConnectorApprovalStore.getState().entries[key(toolCallId)].state,
      "unknown"
    );
  }
});
