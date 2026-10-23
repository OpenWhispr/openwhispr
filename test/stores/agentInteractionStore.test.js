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
  const calls = { interactions: [] };
  return {
    calls,
    controller,
    value: {
      messageId,
      toolCallId,
      signal: controller.signal,
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

test("dismissing a calendar card cancels its actual request and fences late settings writes", async () => {
  for (const provider of ["google", "microsoft", "apple"]) {
    let finish, requestId;
    const started = Promise.withResolvers();
    const cancelled = [],
      wrongCancels = [];
    const connect = (id) => {
      requestId = id;
      return new Promise((resolve) => {
        finish = resolve;
        started.resolve();
      });
    };
    const store = await loadStore({
      gcalStartOAuth: connect,
      mcalStartOAuth: connect,
      acalConnect: connect,
      calendarCancelConnect: async (id) => {
        cancelled.push(id);
        return true;
      },
      connectorCancelConnect: async (id) => wrongCancels.push(id),
    });
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    useSettingsStore.setState({
      gcalAccounts: [],
      mcalAccounts: [],
      appleCalendarConnected: false,
    });
    const wait = store.requestInteraction(context(`calendar-${provider}`).value, {
      kind: "connection",
      target: "calendar",
    });
    const key = `m1::calendar-${provider}`;
    const connecting = store.connectInteraction(key, provider);
    await started.promise;
    store.cancelInteraction(key);
    finish({ success: true, email: "late@calendar.test" });
    await connecting;
    assert.deepEqual(await wait, { status: "cancelled" });
    assert.deepEqual(cancelled, [requestId], provider);
    assert.deepEqual(wrongCancels, [], provider);
    assert.deepEqual(useSettingsStore.getState().gcalAccounts, []);
    assert.deepEqual(useSettingsStore.getState().mcalAccounts, []);
    assert.equal(useSettingsStore.getState().appleCalendarConnected, false);
  }
});

test("legacy Settings and onboarding calendar calls still save successful connections", async () => {
  await loadStore({
    gcalStartOAuth: async () => ({ success: true, email: "google@test" }),
    mcalStartOAuth: async () => ({ success: true, email: "microsoft@test", tenantId: "tenant" }),
    acalConnect: async () => ({ success: true }),
  });
  const { connectCalendar } = await vite.ssrLoadModule("/utils/calendarConnect.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ gcalAccounts: [], mcalAccounts: [], appleCalendarConnected: false });
  for (const provider of ["google", "microsoft", "apple"])
    assert.equal(await connectCalendar(provider), "connected");
  assert.deepEqual(useSettingsStore.getState().gcalAccounts, [{ email: "google@test" }]);
  assert.deepEqual(useSettingsStore.getState().mcalAccounts, [
    { email: "microsoft@test", tenantId: "tenant" },
  ]);
  assert.equal(useSettingsStore.getState().appleCalendarConnected, true);
});

test("a question waits, keeps its draft, and resolves only once every answer is in", async () => {
  const store = await loadStore();
  const ctx = context("call-1");
  const key = "m1::call-1";
  const pending = store.requestInteraction(ctx.value, QUESTIONS);

  const entry = store.useAgentInteractionStore.getState().entries[key];
  assert.equal(entry.state, "pending");
  assert.deepEqual(entry.draft, {}, "a recommended option is never preselected");
  assert.deepEqual(ctx.calls, { interactions: [{ payload: QUESTIONS, state: "pending" }] });

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
  assert.deepEqual(late.calls.interactions, [], "an aborted turn shows nothing new");
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

test("forgetting restored access deletes an unconsumed screenshot", async () => {
  const store = await loadStore({
    checkScreenRecordingAccess: async () => ({ granted: true }),
    captureScreenContext: async () => ({ data: "ABANDONED", mediaType: "image/jpeg" }),
  });
  store.restoreInteraction(
    {
      messageId: "restored",
      toolCallId: "screen",
      payload: { kind: "access", resource: "screen", reason: "Read the error" },
    },
    () => {}
  );
  await store.respondToAccess("restored::screen", true);
  store.forgetInteraction("restored::screen");
  assert.equal(store.takeGrantedImage("restored::screen"), undefined);
});

test("pruning preserves open waiters, working cards and current receipts", async () => {
  let finishCapture;
  const store = await loadStore({
    checkScreenRecordingAccess: async () => ({ granted: true }),
    captureScreenContext: () => new Promise((resolve) => (finishCapture = resolve)),
  });
  const pending = store.requestInteraction(context("pending").value, QUESTIONS);
  const working = store.requestInteraction(context("working").value, {
    kind: "access",
    resource: "screen",
    reason: "Read the error",
  });
  const capturing = store.respondToAccess("m1::working", true);
  const settled = store.requestInteraction(context("settled").value, QUESTIONS);
  store.cancelInteraction("m1::settled");
  await settled;

  store.pruneInteractions(["m1"]);
  assert.equal(Object.keys(store.useAgentInteractionStore.getState().entries).length, 3);
  store.pruneInteractions([]);
  assert.deepEqual(Object.keys(store.useAgentInteractionStore.getState().entries).sort(), [
    "m1::pending",
    "m1::working",
  ]);
  store.cancelInteraction("m1::pending");
  store.cancelInteraction("m1::working");
  await Promise.all([pending, working]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishCapture, "function");
  finishCapture(null);
  await capturing;
  store.pruneInteractions([]);
  assert.deepEqual(store.useAgentInteractionStore.getState().entries, {});
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

test("generic connector settings acknowledge Done without inferring service readiness", async () => {
  const opened = [];
  const store = await loadStore({
    openSettingsSection: async (section) => opened.push(section),
    connectorStatus: async () => [
      { id: "github", connected: true, configured: true, needsReconnect: false },
    ],
  });
  const pending = store.requestInteraction(context("call-15").value, {
    kind: "settings",
    target: "integrations.connectors",
    message: "Connect Linear there",
  });
  store.openInteractionSettings("m1::call-15");
  assert.deepEqual(opened, ["integrations.connectors"]);
  await store.confirmSettingsDone("m1::call-15");
  assert.deepEqual(await pending, { status: "done" });
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
  assert.equal(
    store.answerQuestions("m9::call-16"),
    false,
    "a restored checkbox still needs an answer"
  );
  store.updateInteractionDraft("m9::call-16", {
    goal: "balanced",
    include: ["wireframes"],
    notes: "ok",
  });
  store.answerQuestions("m9::call-16");
  assert.deepEqual(settled, [
    { status: "answered", answers: { goal: "balanced", include: ["wireframes"], notes: "ok" } },
  ]);

  restore("call-17");
  store.forgetInteraction("m9::call-17");
  assert.equal(store.useAgentInteractionStore.getState().entries["m9::call-17"], undefined);
  assert.equal(store.answerQuestions("m9::call-17"), false);
  assert.equal(settled.length, 1);
});

test("questions are answered one at a time, and moving between them keeps every answer", async () => {
  const store = await loadStore();
  const key = "m1::call-20";
  const pending = store.requestInteraction(context("call-20").value, QUESTIONS);
  const entry = () => store.useAgentInteractionStore.getState().entries[key];
  assert.equal(entry().step, 0);

  store.updateInteractionDraft(key, { goal: "balanced" });
  store.commitQuestion(key, 0);
  assert.equal(entry().step, 1);
  // A second commit for a question already left (a late radio timer) does nothing.
  store.commitQuestion(key, 0);
  assert.equal(entry().step, 1);
  store.updateInteractionDraft(key, { ...entry().draft, include: ["research"] });
  store.goToQuestion(key, 0);
  assert.equal(entry().step, 0);
  assert.deepEqual(entry().draft, { goal: "balanced", include: ["research"] });
  store.goToQuestion(key, 9);
  assert.equal(entry().step, 2, "never past the last question");
  store.goToQuestion(key, -3);
  assert.equal(entry().step, 0, "never before the first");

  store.goToQuestion(key, 2);
  store.updateInteractionDraft(key, { ...entry().draft, notes: "Ship it" });
  store.commitQuestion(key, 2);
  assert.deepEqual(await pending, {
    status: "answered",
    answers: { goal: "balanced", include: ["research"], notes: "Ship it" },
  });
});

test("the last question submits once; with one still unanswered it goes back to it", async () => {
  const store = await loadStore();
  const key = "m1::call-21";
  const results = [];
  void store.requestInteraction(context("call-21").value, QUESTIONS).then((r) => results.push(r));
  const entry = () => store.useAgentInteractionStore.getState().entries[key];

  // The first question was skipped with ›; the recommended option is no answer.
  store.goToQuestion(key, 2);
  store.updateInteractionDraft(key, { notes: "n" });
  store.commitQuestion(key, 2);
  assert.equal(entry().state, "pending");
  assert.equal(entry().step, 0, "back to the first unanswered question");

  store.updateInteractionDraft(key, { ...entry().draft, goal: "speed" });
  store.goToQuestion(key, 2);
  store.commitQuestion(key, 2);
  assert.equal(entry().state, "pending", "the untouched checkbox question still needs an answer");
  assert.equal(entry().step, 1);
  store.updateInteractionDraft(key, { ...entry().draft, include: [] });
  store.goToQuestion(key, 2);
  store.commitQuestion(key, 2);
  assert.equal(entry().state, "pending", "clearing every selection is not a submitted answer");
  store.answerWithText(key, "Only the wireframes");
  store.commitQuestion(key, 2);
  await Promise.resolve();
  assert.deepEqual(results, [
    { status: "answered", answers: { goal: "speed", include: "Only the wireframes", notes: "n" } },
  ]);
});

test("the composer's text answers the question on screen, a choice question too", async () => {
  const store = await loadStore();
  const key = "m1::call-22";
  const pending = store.requestInteraction(context("call-22").value, QUESTIONS);
  const entry = () => store.useAgentInteractionStore.getState().entries[key];

  store.answerWithText(key, "  Whatever is cheapest ");
  assert.equal(entry().step, 1, "a typed answer moves on like a pick");
  assert.deepEqual(entry().draft, {});

  store.answerWithText(key, "   ");
  assert.equal(entry().step, 1, "blank text answers nothing");

  // A pick on the same question replaces the typed answer.
  store.answerWithText(key, "Only the research");
  store.goToQuestion(key, 1);
  store.updateInteractionDraft(key, { ...entry().draft, include: ["wireframes"] });
  store.goToQuestion(key, 2);
  store.answerWithText(key, "Due Friday");
  assert.deepEqual(await pending, {
    status: "answered",
    answers: { goal: "Whatever is cheapest", include: ["wireframes"], notes: "Due Friday" },
  });
});

test("the card's own submit path still needs a real option for a single choice", async () => {
  const store = await loadStore();
  const key = "m1::call-23";
  void store.requestInteraction(context("call-23").value, QUESTIONS);
  store.updateInteractionDraft(key, { goal: "made-up", include: [], notes: "n" });
  assert.equal(store.answerQuestions(key), false);
  store.cancelInteraction(key);
});

test("Done is offered only after Settings opened, and llms checks the chat's key", async () => {
  const opened = [];
  const store = await loadStore({ openSettingsSection: async (section) => opened.push(section) });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const previous = useSettingsStore.getState();
  useSettingsStore.setState({
    useDictationAgent: true,
    dictationAgentMode: "providers",
    dictationAgentProvider: "groq",
    dictationAgentModel: "openai/gpt-oss-120b",
    groqApiKey: "",
  });
  const key = "m1::call-24";
  const ask = () =>
    store.requestInteraction(context("call-24").value, {
      kind: "settings",
      target: "llms",
      message: "Add your Groq key",
      scope: "dictationAgent",
    });

  let pending = ask();
  assert.equal(store.useAgentInteractionStore.getState().entries[key].settingsOpened, undefined);
  store.openInteractionSettings(key);
  assert.equal(store.useAgentInteractionStore.getState().entries[key].settingsOpened, true);
  assert.deepEqual(opened, ["llms"]);
  await store.confirmSettingsDone(key);
  assert.deepEqual(await pending, { status: "done", ready: false });

  useSettingsStore.setState({ groqApiKey: "gsk-fake-test-key" });
  pending = store.requestInteraction(context("call-25").value, {
    kind: "settings",
    target: "llms",
    scope: "dictationAgent",
  });
  await store.confirmSettingsDone("m1::call-25");
  assert.deepEqual(await pending, { status: "done", ready: true });
  useSettingsStore.setState(previous, true);
});

test("Done never asks for a key the chat's model doesn't use", async () => {
  const store = await loadStore();
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const previous = useSettingsStore.getState();
  const done = async (callId, scope) => {
    const pending = store.requestInteraction(context(callId).value, {
      kind: "settings",
      target: "llms",
      ...(scope ? { scope } : {}),
    });
    await store.confirmSettingsDone(`m1::${callId}`);
    return pending;
  };
  try {
    // Cloud mode, with the provider an old BYOK setup left behind.
    useSettingsStore.setState({
      isSignedIn: true,
      useDictationAgent: true,
      dictationAgentMode: "openwhispr",
      dictationAgentProvider: "openai",
      openaiApiKey: "",
      chatAgentMode: "openwhispr",
      chatAgentProvider: "openai",
    });
    assert.deepEqual(await done("call-60", "dictationAgent"), { status: "done" });
    assert.deepEqual(await done("call-61"), { status: "done" });

    // Typed chat checks its own scope, not the Voice Assistant's.
    useSettingsStore.setState({
      chatAgentMode: "providers",
      chatAgentProvider: "openai",
      chatAgentModel: "gpt-5-mini",
    });
    assert.deepEqual(await done("call-62"), { status: "done", ready: false });
  } finally {
    useSettingsStore.setState(previous, true);
  }
});
