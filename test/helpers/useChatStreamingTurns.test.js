const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  SIGNED_OUT_AUTH_MOCK,
  createRendererServer,
  installBrowserGlobals,
} = require("../lib/rendererTestHarness");

// The running chat's turn bookkeeping on the real useChatStreaming hook (one
// synchronous render, then its sendToAI closure), with the model stream
// stubbed: how a turn ends, what waits on the user, and what is saved.
const BYOK = {
  chatAgentMode: "providers",
  chatAgentProvider: "openai",
  chatAgentModel: "gpt-5-mini",
};
const SLACK_READY = {
  slack: {
    id: "slack",
    connected: true,
    configured: true,
    accountLabel: "chad",
    workspaceLabel: "Acme",
    needsReconnect: false,
  },
};

async function renderChatStreaming(
  t,
  hookOptions = {},
  { settings = BYOK, electronAPI = {}, statuses } = {}
) {
  installBrowserGlobals(t, { initialStorage: { isSubscribed: "true" }, window: { electronAPI } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-turns-test-",
    mockModules: SIGNED_OUT_AUTH_MOCK,
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  useSettingsStore.setState({ isSignedIn: true, ...settings });
  if (statuses) {
    const { useConnectorStatusStore } = await vite.ssrLoadModule("/stores/connectorStatusStore.ts");
    useConnectorStatusStore.setState({ loaded: true, statuses });
  }
  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  const offered = [];
  const prompts = [];
  let streamFor = () => (async function* () {})();
  t.mock.method(reasoningService, "processTextStreamingAI", (messages, _m, _p, config, tools) => {
    offered.push(Object.keys(tools ?? {}));
    prompts.push(config.systemPrompt);
    return streamFor(tools, config);
  });
  t.mock.method(reasoningService, "processTextStreamingCloud", (_messages, config) => {
    offered.push((config.tools ?? []).map((tool) => tool.name));
    prompts.push(config.systemPrompt);
    return streamFor(undefined, config);
  });

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  const completed = [];
  const checkpoints = [];
  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      setMessages,
      onStreamComplete: (...args) => completed.push(args),
      onTurnCheckpoint: (...args) => checkpoints.push(args),
      ...hookOptions,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  return {
    captured,
    vite,
    offered,
    prompts,
    completed,
    checkpoints,
    setStream: (factory) => (streamFor = factory),
    assistant: () => messages.find((message) => message.role === "assistant"),
    messages: () => messages,
    seed: (list) => (messages = list),
  };
}

const toolOptions = (toolCallId) => ({ toolCallId, messages: [] });

test("a turn records when it ran, how it ended, its reasoning and each step", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  harness.setStream(() =>
    (async function* () {
      yield { type: "reasoning", text: "Check the notes " };
      yield { type: "reasoning", text: "first." };
      yield { type: "content", text: "Let me look." };
      yield { type: "tool_calls", calls: [{ id: "c1", name: "search_notes", arguments: "{}" }] };
      yield {
        type: "tool_result",
        callId: "c1",
        toolName: "search_notes",
        displayText: "Error: boom",
        isError: true,
      };
      yield { type: "content", text: "Nothing found." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI("Find the plan", [], { conversationId: 7 });

  const [[, content, toolCalls, details]] = harness.completed;
  assert.equal(
    content,
    "Let me look.\n\nNothing found.",
    "text after a step starts a new paragraph"
  );
  assert.equal(details.conversationId, 7);
  assert.equal(details.turn.status, "complete");
  assert.equal(details.turn.reasoning, "Check the notes first.");
  assert.ok(details.turn.finishedAt >= details.turn.startedAt);
  assert.equal(toolCalls[0].status, "error");
  assert.ok(toolCalls[0].finishedAt >= toolCalls[0].startedAt);
  assert.equal(harness.assistant().turn.status, "complete");
});

test("other chats show and save a reply as before: no turn notes, no reasoning", async (t) => {
  const harness = await renderChatStreaming(t);
  harness.setStream(() =>
    (async function* () {
      yield { type: "reasoning", text: "Thinking it over." };
      yield { type: "content", text: "Done." };
      yield { type: "done", finishReason: "tool-calls" };
    })()
  );
  await harness.captured.sendToAI("Go", []);
  const [[, content, , details]] = harness.completed;
  assert.equal(content, "Done.");
  assert.equal(details.turn, undefined);
  assert.equal(harness.assistant().turn, undefined);
});

test("long reasoning is cut before it is saved", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  harness.setStream(() =>
    (async function* () {
      yield { type: "reasoning", text: "x".repeat(25_000) };
      yield { type: "content", text: "Done." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI("Go", []);
  assert.equal(harness.completed[0][3].turn.reasoning.length, 20_001);
});

test("a run stopped by the step cap is marked so the user can continue it", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  harness.setStream(() =>
    (async function* () {
      yield { type: "tool_calls", calls: [{ id: "c1", name: "search_notes", arguments: "{}" }] };
      yield { type: "tool_result", callId: "c1", toolName: "search_notes", displayText: "Done" };
      yield { type: "done", finishReason: "tool-calls" };
    })()
  );
  await harness.captured.sendToAI("Do everything", []);
  assert.equal(harness.completed[0][3].turn.status, "step_limit");
});

test("a turn waiting on a question is saved as waiting, as answered, then completed in place", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  const store = await harness.vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  harness.setStream((tools) =>
    (async function* () {
      yield { type: "tool_calls", calls: [{ id: "q1", name: "ask_user", arguments: "{}" }] };
      const output = await tools.ask_user.execute(
        { questions: [{ id: "tone", kind: "text", prompt: "Which tone?" }] },
        toolOptions("q1")
      );
      yield {
        type: "tool_result",
        callId: "q1",
        toolName: "ask_user",
        displayText: "Done",
        metadata: output,
      };
      yield { type: "content", text: "Casual it is." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  const sending = harness.captured.sendToAI("Write the update", []);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.checkpoints.length, 1);
  const [assistantId, , waitingCalls, waitingDetails] = harness.checkpoints[0];
  assert.equal(waitingDetails.turn.status, "waiting");
  assert.equal(waitingCalls[0].interaction.state, "pending");
  assert.equal(harness.assistant().turn.status, "waiting");

  const key = `${assistantId}::q1`;
  store.updateInteractionDraft(key, { tone: "casual" });
  store.answerQuestions(key);
  // Saved again at once: the app closing before the turn ends must not offer
  // the answered question again.
  assert.equal(harness.checkpoints.length, 2);
  const [, , answeredCalls, answeredDetails] = harness.checkpoints[1];
  assert.equal(answeredDetails.turn.status, "running");
  assert.equal(answeredCalls[0].interaction.state, "settled");
  await sending;

  const [[savedId, , toolCalls, details]] = harness.completed;
  assert.equal(savedId, assistantId, "the same reply is completed");
  assert.equal(details.turn.status, "complete");
  assert.deepEqual(toolCalls[0].interaction.result, {
    status: "answered",
    answers: { tone: "casual" },
  });
});

test("Stop while a question waits keeps the reply, marked stopped, and dismisses it", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  const reasoningService = (await harness.vite.ssrLoadModule("/services/ReasoningService.ts"))
    .default;
  t.mock.method(reasoningService, "cancelActiveStream", () => {});
  harness.setStream((tools) =>
    (async function* () {
      yield { type: "content", text: "I need one detail." };
      yield { type: "tool_calls", calls: [{ id: "q1", name: "ask_user", arguments: "{}" }] };
      await tools.ask_user.execute(
        { questions: [{ id: "tone", kind: "text", prompt: "Which tone?" }] },
        toolOptions("q1")
      );
    })()
  );
  const sending = harness.captured.sendToAI("Write the update", []);
  await new Promise((resolve) => setImmediate(resolve));
  harness.captured.cancelStream();
  await sending;

  const [[, content, toolCalls, details]] = harness.completed;
  assert.equal(content, "I need one detail.");
  assert.equal(details.turn.status, "stopped");
  assert.deepEqual(toolCalls[0].interaction.result, { status: "cancelled" });
  assert.equal(toolCalls[0].status, "stopped", "never a step stuck asking");
});

test("a tool still running at Stop ends stopped, and may still have acted", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  const reasoningService = (await harness.vite.ssrLoadModule("/services/ReasoningService.ts"))
    .default;
  let endStream;
  const streamEnded = new Promise((resolve) => (endStream = resolve));
  t.mock.method(reasoningService, "cancelActiveStream", () => endStream());
  const { toolTrace } = await harness.vite.ssrLoadModule("/components/chat/historyMessages.ts");
  harness.setStream(() =>
    (async function* () {
      yield { type: "tool_calls", calls: [{ id: "w1", name: "web_search", arguments: "{}" }] };
      await streamEnded;
    })()
  );
  const sending = harness.captured.sendToAI("Look it up", []);
  await new Promise((resolve) => setImmediate(resolve));
  harness.captured.cancelStream();
  await sending;

  const [[, , toolCalls]] = harness.completed;
  assert.equal(toolCalls[0].status, "stopped");
  assert.equal(toolTrace(toolCalls), "[Tools used: web_search (outcome not recorded)]");
});

test("a send an earlier request made shows its card again, saying so", async (t) => {
  const harness = await renderChatStreaming(
    t,
    { allowConnectors: true },
    {
      statuses: SLACK_READY,
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: "a1",
          preview: { verbKey: "post", destinationLabel: "#eng", accountLabel: "chad", body: "hi" },
        }),
        connectorCancel: async () => ({ cancelled: true }),
      },
    }
  );
  const { connectorActionKey } = await harness.vite.ssrLoadModule(
    "/services/tools/connectors/actionKey.ts"
  );
  const approvals = await harness.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  let output;
  harness.setStream((tools) =>
    (async function* () {
      const running = tools.slack_send_message.execute(
        { destination: "#eng", text: "PR  #12 merged!" },
        toolOptions("s2")
      );
      await new Promise((resolve) => setImmediate(resolve));
      const [entry] = Object.values(approvals.useConnectorApprovalStore.getState().entries);
      assert.deepEqual(entry.preview.notes, [{ key: "connectors.approval.sentEarlier" }]);
      approvals.cancelApproval(entry.key);
      output = await running;
      yield { type: "done", finishReason: "stop" };
    })()
  );
  const earlier = {
    id: "a0",
    role: "assistant",
    content: "Posted.",
    isStreaming: false,
    toolCalls: [
      {
        id: "s1",
        name: "slack_send_message",
        arguments: "{}",
        status: "completed",
        actionKey: connectorActionKey("slack", "send_message", {
          destination: "#eng",
          text: "PR #12 merged!",
        }),
      },
    ],
  };
  await harness.captured.sendToAI("Post it again", [earlier]);

  // The user's Send or Cancel decides; the model is never told it was already done.
  assert.equal(output.status, "cancelled_by_user");
});

test("regenerating replaces the reply in place and keeps the sends it made", async (t) => {
  const harness = await renderChatStreaming(
    t,
    { allowConnectors: true, allowInteractions: true },
    {
      statuses: SLACK_READY,
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: "a1",
          preview: { verbKey: "post", destinationLabel: "#eng", accountLabel: "chad", body: "hi" },
        }),
        connectorCancel: async () => ({ cancelled: true }),
      },
    }
  );
  const { connectorActionKey } = await harness.vite.ssrLoadModule(
    "/services/tools/connectors/actionKey.ts"
  );
  const approvals = await harness.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const sent = {
    id: "s1",
    name: "slack_send_message",
    arguments: "{}",
    status: "completed",
    actionKey: connectorActionKey("slack", "send_message", { destination: "#eng", text: "hi" }),
  };
  const request = { id: "u1", role: "user", content: "Post hi to #eng", isStreaming: false };
  const reply = {
    id: "a0",
    dbId: 9,
    role: "assistant",
    content: "Posted.",
    isStreaming: false,
    toolCalls: [{ id: "q1", name: "search_notes", arguments: "{}", status: "completed" }, sent],
  };
  harness.seed([request, reply]);
  let notes;
  harness.setStream((tools) =>
    (async function* () {
      const running = tools.slack_send_message.execute(
        { destination: "#eng", text: "hi" },
        toolOptions("s2")
      );
      await new Promise((resolve) => setImmediate(resolve));
      const [entry] = Object.values(approvals.useConnectorApprovalStore.getState().entries);
      notes = entry.preview.notes;
      approvals.cancelApproval(entry.key);
      await running;
      yield { type: "content", text: "Here it is again." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI(request.content, [request], {
    conversationId: 7,
    replaceMessage: reply,
  });

  // The send the replaced reply made still counts as made.
  assert.deepEqual(notes, [{ key: "connectors.approval.sentEarlier" }]);
  const messages = harness.messages();
  assert.deepEqual(
    messages.map((message) => message.id),
    ["u1", "a0"]
  );
  assert.equal(messages[1].dbId, 9);
  assert.equal(messages[1].content, "Here it is again.");
  const [[savedId, , savedCalls]] = harness.completed;
  assert.equal(savedId, "a0");
  assert.deepEqual(
    savedCalls.map((call) => call.actionKey),
    [sent.actionKey]
  );
});

test("the same send twice in one step gets one card", async (t) => {
  const prepares = [];
  const harness = await renderChatStreaming(
    t,
    { allowConnectors: true },
    {
      statuses: SLACK_READY,
      electronAPI: {
        connectorPrepare: async (...args) => {
          prepares.push(args);
          return { status: "failed", errorCode: "x", message: "x" };
        },
      },
    }
  );
  let outputs;
  harness.setStream((tools) =>
    (async function* () {
      const call = (id) =>
        tools.slack_send_message.execute({ destination: "#eng", text: "hi" }, toolOptions(id));
      outputs = await Promise.all([call("s1"), call("s2")]);
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI("Post hi to #eng", []);

  assert.equal(prepares.length, 1);
  assert.deepEqual(
    outputs.map((output) => output.status),
    ["failed", "already_sent"]
  );
  assert.match(outputs[1].guidance, /earlier in this request, so it was not done again/);
});

test("a send that went out is keyed on its tool call, for later turns", async (t) => {
  const harness = await renderChatStreaming(
    t,
    { allowConnectors: true },
    {
      statuses: SLACK_READY,
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: "a1",
          preview: { verbKey: "post", destinationLabel: "#eng", accountLabel: "chad", body: "hi" },
        }),
        connectorCommit: async () => ({ state: "sent", url: "https://slack.test/1" }),
      },
    }
  );
  const approvals = await harness.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  harness.setStream((tools) =>
    (async function* () {
      yield {
        type: "tool_calls",
        calls: [{ id: "s1", name: "slack_send_message", arguments: "{}" }],
      };
      const running = tools.slack_send_message.execute(
        { destination: "#eng", text: "hi" },
        toolOptions("s1")
      );
      await new Promise((resolve) => setImmediate(resolve));
      const [key] = Object.keys(approvals.useConnectorApprovalStore.getState().entries);
      await approvals.approveAction(key);
      const output = await running;
      yield {
        type: "tool_result",
        callId: "s1",
        toolName: "slack_send_message",
        displayText: "Sent",
        metadata: output,
      };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI("Post hi to #eng", []);
  assert.match(harness.completed[0][2][0].actionKey, /^slack\.send_message:/);
  // Saved the moment it was sent, before the turn ended.
  assert.match(harness.checkpoints[0][2][0].actionKey, /^slack\.send_message:/);
});

test("a send that lands after Stop is saved with the stopped reply", async (t) => {
  let finishCommit;
  const harness = await renderChatStreaming(
    t,
    { allowConnectors: true, allowInteractions: true },
    {
      statuses: SLACK_READY,
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: "a1",
          preview: { verbKey: "post", destinationLabel: "#eng", accountLabel: "chad", body: "hi" },
        }),
        connectorCommit: () =>
          new Promise((resolve) => {
            finishCommit = () => resolve({ state: "sent", url: "https://slack.test/1" });
          }),
      },
    }
  );
  const reasoningService = (await harness.vite.ssrLoadModule("/services/ReasoningService.ts"))
    .default;
  // Stop ends the model stream; the tool call, already committing, runs on.
  let endStream;
  const streamEnded = new Promise((resolve) => (endStream = resolve));
  t.mock.method(reasoningService, "cancelActiveStream", () => endStream());
  const approvals = await harness.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  harness.setStream((tools) =>
    (async function* () {
      yield {
        type: "tool_calls",
        calls: [{ id: "s1", name: "slack_send_message", arguments: "{}" }],
      };
      void tools.slack_send_message.execute({ destination: "#eng", text: "hi" }, toolOptions("s1"));
      await streamEnded;
    })()
  );
  const sending = harness.captured.sendToAI("Post hi to #eng", []);
  await new Promise((resolve) => setImmediate(resolve));
  const [key] = Object.keys(approvals.useConnectorApprovalStore.getState().entries);
  void approvals.approveAction(key);
  await new Promise((resolve) => setImmediate(resolve));
  harness.captured.cancelStream();
  await sending;
  assert.equal(harness.completed[0][3].turn.status, "stopped");
  assert.equal(harness.completed[0][2][0].actionKey, undefined);

  finishCommit();
  await new Promise((resolve) => setImmediate(resolve));
  const [, , toolCalls, details] = harness.checkpoints.at(-1);
  assert.match(toolCalls[0].actionKey, /^slack\.send_message:/, "the send is never repeated");
  assert.equal(details.turn.status, "stopped");
});

test("a tool stopped while it waits for its service to connect is recorded as not sent", async (t) => {
  const harness = await renderChatStreaming(
    t,
    { allowConnectors: true, allowInteractions: true },
    {
      statuses: {
        slack: { ...SLACK_READY.slack, connected: false, accountLabel: null, workspaceLabel: null },
      },
    }
  );
  const reasoningService = (await harness.vite.ssrLoadModule("/services/ReasoningService.ts"))
    .default;
  t.mock.method(reasoningService, "cancelActiveStream", () => {});
  const { toolTrace } = await harness.vite.ssrLoadModule("/components/chat/historyMessages.ts");
  harness.setStream((tools) =>
    (async function* () {
      yield {
        type: "tool_calls",
        calls: [{ id: "s1", name: "slack_send_message", arguments: "{}" }],
      };
      await tools.slack_send_message.execute(
        { destination: "#eng", text: "hi" },
        toolOptions("s1")
      );
    })()
  );
  const sending = harness.captured.sendToAI("Post hi to #eng", []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.checkpoints[0][2][0].interaction.payload.target, "slack");
  harness.captured.cancelStream();
  await sending;

  const [[, , toolCalls]] = harness.completed;
  assert.deepEqual(toolCalls[0].metadata, { status: "not_sent" });
  assert.equal(toolTrace(toolCalls), "[Tools used: slack_send_message (not sent)]");
});

test("a service the chat can connect is offered with request_connection, and named for it", async (t) => {
  const harness = await renderChatStreaming(
    t,
    { allowConnectors: true, allowInteractions: true },
    {
      statuses: {
        slack: { ...SLACK_READY.slack, connected: false, accountLabel: null, workspaceLabel: null },
      },
      settings: { ...BYOK, gcalConnected: true },
    }
  );
  await harness.captured.sendToAI("Tell #eng the PR merged", []);
  assert.ok(harness.offered[0].includes("slack_send_message"));
  assert.ok(harness.offered[0].includes("request_connection"));
  assert.ok(harness.offered[0].includes("ask_user"));
  assert.match(harness.prompts[0], /use its tools as usual: they ask the user to connect it first/);
  assert.match(harness.prompts[0], /- Slack \(target: slack\)/);
  assert.doesNotMatch(harness.prompts[0], /Connect Slack and I can post this/);
});

test("a surface that doesn't show interactions never offers them", async (t) => {
  const harness = await renderChatStreaming(t, { allowConnectors: true });
  await harness.captured.sendToAI("Hi", []);
  for (const name of ["ask_user", "request_connection", "open_settings", "request_api_key"]) {
    assert.equal(harness.offered[0].includes(name), false, name);
  }
});

test("the cloud path marks a run that ran out of steps too", async (t) => {
  const harness = await renderChatStreaming(
    t,
    { allowInteractions: true },
    { settings: { chatAgentMode: "openwhispr" } }
  );
  harness.setStream(() =>
    (async function* () {
      yield { type: "content", text: "Partial" };
      yield { type: "done", finishReason: "tool-calls" };
    })()
  );
  await harness.captured.sendToAI("Go", []);
  assert.equal(harness.completed[0][3].turn.status, "step_limit");
});

test("a regenerate stopped or failed before its first token shows the reply it replaced", async (t) => {
  // A reply from an older build has no turn: the aborted run's must not stick to it.
  for (const [end, olderReply] of [
    ["stop", false],
    ["error", false],
    ["error", true],
  ]) {
    const label = `${end}${olderReply ? ", older reply" : ""}`;
    const harness = await renderChatStreaming(t, { allowInteractions: true });
    const reasoningService = (await harness.vite.ssrLoadModule("/services/ReasoningService.ts"))
      .default;
    let endStream;
    const streamEnded = new Promise((resolve) => (endStream = resolve));
    t.mock.method(reasoningService, "cancelActiveStream", () => endStream());
    const request = { id: "u1", role: "user", content: "Post hi to #eng", isStreaming: false };
    const reply = {
      id: "a0",
      dbId: 9,
      role: "assistant",
      content: "Posted.",
      isStreaming: false,
      ...(olderReply ? {} : { turn: { startedAt: 1, finishedAt: 2, status: "complete" } }),
      toolCalls: [
        { id: "q1", name: "search_notes", arguments: "{}", status: "completed" },
        {
          id: "s1",
          name: "slack_send_message",
          arguments: "{}",
          status: "completed",
          actionKey: "k",
        },
      ],
    };
    harness.seed([request, reply]);
    harness.setStream(() =>
      (async function* () {
        yield { type: "reasoning", text: "Thinking it over." };
        if (end === "error") throw new Error("provider down");
        await streamEnded;
      })()
    );
    let failures = 0;
    const sending = harness.captured.sendToAI(request.content, [request], {
      conversationId: 7,
      replaceMessage: reply,
      onReplaceFailed: () => (failures += 1),
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (end === "stop") harness.captured.cancelStream();
    await sending;

    assert.deepEqual(harness.messages()[1], reply, label);
    assert.deepEqual(harness.completed, [], `${label}: nothing is saved over it`);
    // A failure is said (the agent window shows a notice); a stop is the user's own.
    assert.equal(failures, end === "error" ? 1 : 0, label);
  }
});

test("reasoning after a tool step starts a new paragraph", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  harness.setStream(() =>
    (async function* () {
      yield { type: "reasoning", text: "Check the calendar." };
      yield { type: "tool_calls", calls: [{ id: "c1", name: "search_notes", arguments: "{}" }] };
      yield {
        type: "tool_result",
        callId: "c1",
        toolName: "search_notes",
        displayText: "Found 1 note",
      };
      yield { type: "reasoning", text: "Now the " };
      yield { type: "reasoning", text: "notes." };
      yield { type: "content", text: "Done." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI("Plan my day", []);

  const [[, , , details]] = harness.completed;
  assert.equal(details.turn.reasoning, "Check the calendar.\n\nNow the notes.");
});
