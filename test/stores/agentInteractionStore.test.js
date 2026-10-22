const test = require("node:test");
const { after, before } = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// One renderer server for the file: the store pulls in the settings and
// connector stores, which load through Vite like the app's own renderer.
let vite;
const cleanups = [];
before(async () => {
  installBrowserGlobals({ after: (fn) => cleanups.push(fn) }, { window: { electronAPI: {} } });
  vite = await createRendererServer(
    { after: (fn) => cleanups.push(fn) },
    { cachePrefix: "openwhispr-agent-interaction-store-test-" }
  );
});
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function loadStore(electronAPI = {}) {
  globalThis.window.electronAPI = electronAPI;
  const store = await vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  store.useAgentInteractionStore.setState({ entries: {} });
  return store;
}

function context(toolCallId, { messageId = "m1", controller = new AbortController() } = {}) {
  const calls = { requested: 0, held: 0, interactions: [] };
  return {
    calls,
    controller,
    value: {
      messageId,
      toolCallId,
      signal: controller.signal,
      onApprovalRequested: () => (calls.requested += 1),
      onHoldDelivery: () => (calls.held += 1),
      onInteraction: (record) => calls.interactions.push(record),
      attachImage() {},
      claimTurnSlot: () => true,
      releaseTurnSlot() {},
      claimAction: () => true,
      releaseAction() {},
      sentEarlier: () => false,
      recordCompletedAction() {},
    },
  };
}

const QUESTIONS = {
  kind: "questions",
  questions: [
    {
      id: "goal",
      kind: "single",
      prompt: "What are you optimizing for?",
      options: [
        { id: "speed", label: "Speed" },
        { id: "balanced", label: "Balanced", recommended: true },
      ],
    },
    {
      id: "include",
      kind: "multiple",
      prompt: "What should I include?",
      options: [
        { id: "research", label: "Research" },
        { id: "wireframes", label: "Wireframes" },
      ],
    },
    { id: "notes", kind: "text", prompt: "Anything else?" },
  ],
};

test("a question waits, keeps its draft, and resolves only once every answer is in", async () => {
  const store = await loadStore();
  const ctx = context("call-1");
  const key = "m1::call-1";
  const pending = store.requestInteraction(ctx.value, QUESTIONS);

  const entry = store.useAgentInteractionStore.getState().entries[key];
  assert.equal(entry.state, "pending");
  assert.deepEqual(entry.draft, {}, "a recommended option is never preselected");
  assert.deepEqual(ctx.calls, {
    requested: 1,
    held: 1,
    interactions: [{ payload: QUESTIONS, state: "pending" }],
  });

  store.updateInteractionDraft(key, { goal: "speed" });
  assert.equal(store.answerQuestions(key), false, "unanswered questions keep it open");
  store.updateInteractionDraft(key, {
    goal: "speed",
    include: ["wireframes", "bogus"],
    notes: " x ",
  });
  assert.equal(store.answerQuestions(key), true);

  const answered = {
    status: "answered",
    answers: { goal: "speed", include: ["wireframes"], notes: "x" },
  };
  assert.deepEqual(await pending, answered);
  assert.deepEqual(
    ctx.calls.interactions[1],
    { payload: QUESTIONS, state: "settled", result: answered },
    "the chat hears it settle, so it can save the turn as no longer waiting"
  );
  assert.equal(store.useAgentInteractionStore.getState().entries[key].state, "settled");
  assert.equal(store.answerQuestions(key), false, "an answered question can't be answered twice");
});

test("a single choice must name one of its options", async () => {
  const store = await loadStore();
  const pending = store.requestInteraction(context("call-2").value, QUESTIONS);
  store.updateInteractionDraft("m1::call-2", { goal: "fastest", include: [], notes: "n" });
  assert.equal(store.answerQuestions("m1::call-2"), false);
  store.cancelInteraction("m1::call-2");
  assert.deepEqual(await pending, { status: "cancelled" });
});

test("the turn ending withdraws an open interaction", async () => {
  const store = await loadStore();
  const ctx = context("call-3");
  const pending = store.requestInteraction(ctx.value, QUESTIONS);
  ctx.controller.abort();
  assert.deepEqual(await pending, { status: "not_answered", reason: "conversation_ended" });

  const late = context("call-4", { controller: ctx.controller });
  assert.deepEqual(await store.requestInteraction(late.value, QUESTIONS), {
    status: "not_answered",
    reason: "conversation_ended",
  });
  assert.equal(late.calls.requested, 0, "an aborted turn shows nothing new");
});

test("an unanswered interaction expires after the approval TTL", async (t) => {
  const store = await loadStore();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = store.requestInteraction(context("call-5").value, QUESTIONS);
  t.mock.timers.tick(store.INTERACTION_TTL_MS);
  assert.deepEqual(await pending, { status: "not_answered", reason: "expired" });
});

test("a second request on the same call never steals the first one", async () => {
  const store = await loadStore();
  const first = store.requestInteraction(context("call-6").value, QUESTIONS);
  assert.deepEqual(await store.requestInteraction(context("call-6").value, QUESTIONS), {
    status: "not_answered",
    reason: "duplicate_tool_call",
  });
  store.cancelInteraction("m1::call-6");
  assert.deepEqual(await first, { status: "cancelled" });
});

test("a key goes straight to the settings saver and never into the store or result", async () => {
  const store = await loadStore();
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const saved = [];
  useSettingsStore.setState({ setGroqApiKey: (key) => saved.push(key) });
  const pending = store.requestInteraction(context("call-7").value, {
    kind: "apiKey",
    provider: "groq",
    providerName: "Groq",
  });

  await store.submitApiKey("m1::call-7", "  gsk_secret_value  ");

  assert.deepEqual(saved, ["gsk_secret_value"]);
  const result = await pending;
  assert.deepEqual(result, { status: "saved" });
  const serialized = JSON.stringify(store.useAgentInteractionStore.getState().entries);
  assert.equal(serialized.includes("gsk_secret_value"), false);
});

test("a connection is reported only once the connector's status says connected", async () => {
  let connected = false;
  const store = await loadStore({
    connectorConnect: async () => {
      connected = true;
      return { status: "connected", accountLabel: "chad", workspaceLabel: "Acme" };
    },
    connectorStatus: async () => [
      {
        id: "slack",
        connected,
        configured: true,
        accountLabel: "chad",
        workspaceLabel: "Acme",
        needsReconnect: false,
      },
    ],
  });
  const pending = store.requestInteraction(context("call-8").value, {
    kind: "connection",
    target: "slack",
  });
  await store.connectInteraction("m1::call-8");
  assert.deepEqual(await pending, { status: "connected", target: "slack" });
});

test("a failed connect keeps the card open to retry; a closed browser tab is no error", async () => {
  const results = [
    { status: "failed", errorCode: "token_exchange_failed" },
    { status: "failed", errorCode: "oauth_cancelled" },
  ];
  const cancels = [];
  const store = await loadStore({
    connectorConnect: async () => results.shift(),
    connectorCancelConnect: async (id) => cancels.push(id),
  });
  const key = "m1::call-9";
  const pending = store.requestInteraction(context("call-9").value, {
    kind: "connection",
    target: "slack",
  });

  await store.connectInteraction(key);
  let entry = store.useAgentInteractionStore.getState().entries[key];
  assert.equal(entry.state, "pending");
  assert.equal(entry.error, "token_exchange_failed");

  await store.connectInteraction(key);
  entry = store.useAgentInteractionStore.getState().entries[key];
  assert.equal(entry.state, "pending");
  assert.equal(entry.error, undefined);

  store.cancelInteraction(key);
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.deepEqual(cancels, [], "nothing was connecting when it was dismissed");
});

test("dismissing a connect in progress stops it", async () => {
  const cancels = [];
  let finishConnect;
  const store = await loadStore({
    connectorConnect: () => new Promise((resolve) => (finishConnect = resolve)),
    connectorCancelConnect: async (id) => cancels.push(id),
  });
  const key = "m1::call-10";
  const pending = store.requestInteraction(context("call-10").value, {
    kind: "connection",
    target: "github",
  });
  const connecting = store.connectInteraction(key);
  assert.equal(store.useAgentInteractionStore.getState().entries[key].state, "working");

  store.cancelInteraction(key);
  assert.deepEqual(cancels, ["github"]);
  assert.deepEqual(await pending, { status: "cancelled" });
  finishConnect({ status: "failed", errorCode: "oauth_cancelled" });
  await connecting;
  assert.equal(store.useAgentInteractionStore.getState().entries[key].state, "settled");
});

test("a calendar connection runs the provider the user picks", async () => {
  const store = await loadStore({
    mcalStartOAuth: async () => ({ success: true, email: "me@contoso.com", tenantId: "t1" }),
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const accounts = [];
  useSettingsStore.setState({ mcalAccounts: [], setMcalAccounts: (list) => accounts.push(list) });
  const pending = store.requestInteraction(context("call-11").value, {
    kind: "connection",
    target: "calendar",
  });
  await store.connectInteraction("m1::call-11", "microsoft");
  assert.deepEqual(await pending, { status: "connected", target: "microsoft" });
  assert.deepEqual(accounts, [[{ email: "me@contoso.com", tenantId: "t1" }]]);
});

test("allowed screen access hands the screenshot to the turn, never to the result", async () => {
  const store = await loadStore({
    getPlatform: () => "linux",
    checkScreenRecordingAccess: async () => ({ granted: true }),
    captureScreenContext: async () => ({ data: "BASE64", mediaType: "image/jpeg" }),
  });
  const pending = store.requestInteraction(context("call-12").value, {
    kind: "access",
    resource: "screen",
    reason: "To see the error",
  });
  await store.respondToAccess("m1::call-12", true);
  assert.deepEqual(await pending, { status: "granted" });
  assert.equal(JSON.stringify(store.useAgentInteractionStore.getState()).includes("BASE64"), false);
  assert.deepEqual(store.takeGrantedImage("m1::call-12"), {
    image: "BASE64",
    mediaType: "image/jpeg",
  });
  assert.equal(store.takeGrantedImage("m1::call-12"), undefined, "handed over once");
});

test("Not now on access is a refusal, and a failed capture is unavailable", async () => {
  const store = await loadStore({
    getPlatform: () => "linux",
    checkScreenRecordingAccess: async () => ({ granted: true }),
    captureScreenContext: async () => null,
  });
  const declined = store.requestInteraction(context("call-13").value, {
    kind: "access",
    resource: "screen",
    reason: "r",
  });
  await store.respondToAccess("m1::call-13", false);
  assert.deepEqual(await declined, { status: "declined" });

  const failed = store.requestInteraction(context("call-14").value, {
    kind: "access",
    resource: "screen",
    reason: "r",
  });
  await store.respondToAccess("m1::call-14", true);
  assert.deepEqual(await failed, { status: "unavailable", reason: "capture_failed" });
});

test("settings open the destination and re-check it when the user is done", async () => {
  const opened = [];
  const store = await loadStore({
    openSettingsSection: async (section) => opened.push(section),
    connectorStatus: async () => [],
  });
  const pending = store.requestInteraction(context("call-15").value, {
    kind: "settings",
    target: "integrations.connectors",
    message: "Connect Linear there",
  });
  store.openInteractionSettings("m1::call-15");
  assert.deepEqual(opened, ["integrations.connectors"]);
  await store.confirmSettingsDone("m1::call-15");
  assert.deepEqual(await pending, { status: "done", ready: false });
});

test("a restored interaction reports to its handler, and a forgotten one never does", async () => {
  const store = await loadStore();
  const settled = [];
  const restore = (toolCallId) =>
    store.restoreInteraction({ messageId: "m9", toolCallId, payload: QUESTIONS }, (result) =>
      settled.push(result)
    );
  assert.equal(restore("call-16"), true);
  assert.equal(restore("call-16"), false, "already open");

  store.updateInteractionDraft("m9::call-16", { goal: "balanced", include: [], notes: "ok" });
  store.answerQuestions("m9::call-16");
  assert.deepEqual(settled, [
    { status: "answered", answers: { goal: "balanced", include: [], notes: "ok" } },
  ]);

  restore("call-17");
  store.forgetInteraction("m9::call-17");
  assert.equal(store.useAgentInteractionStore.getState().entries["m9::call-17"], undefined);
  assert.equal(store.answerQuestions("m9::call-17"), false);
  assert.equal(settled.length, 1);
});
