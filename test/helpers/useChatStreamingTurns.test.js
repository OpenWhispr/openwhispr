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
  installHookDom,
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
  { settings = BYOK, electronAPI = {}, statuses, live = false } = {}
) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { initialStorage: { isSubscribed: "true" }, window: { electronAPI } });
  const container = live ? installHookDom(t) : null;
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
  if (live) {
    const { createRoot } = require("react-dom/client");
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
  } else renderToStaticMarkup(React.createElement(Harness));
  return {
    captured,
    current: () => captured,
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

test("unclassified live provider failures use generic copy and preserve only separate details", async (t) => {
  for (const error of [
    new Error("RAW_PROVIDER_SECRET"),
    { message: "NESTED_PROVIDER_SECRET", cause: { message: "RAW_BODY" } },
  ]) {
    await t.test(error.message, async (t) => {
      const h = await renderChatStreaming(t, { allowInteractions: true });
      h.setStream(() =>
        (async function* () {
          yield { type: "reasoning", text: "" };
          throw error;
        })()
      );
      await h.captured.sendToAI("Go", [], { conversationId: 1 });
      assert.match(h.assistant().content, /unexpected error/);
      assert.doesNotMatch(h.assistant().content, /PROVIDER_SECRET|RAW_BODY/);
      assert.equal(h.assistant().turn.status, "error");
      assert.equal(h.checkpoints[0][1], "", "raw failures never enter the saved checkpoint");
    });
  }
});

test("classified live provider failures retain their actionable copy and details", async (t) => {
  const h = await renderChatStreaming(t, { allowInteractions: true });
  const { providerHttpError } = await h.vite.ssrLoadModule("/helpers/providerHttpErrors.js");
  h.setStream(() =>
    (async function* () {
      yield { type: "reasoning", text: "" };
      throw providerHttpError({
        provider: "OpenAI",
        status: 401,
        body: "invalid_api_key",
        surface: "llm",
      });
    })()
  );
  await h.captured.sendToAI("Go", [], { conversationId: 1 });
  assert.match(h.assistant().content, /rejected your API key/);
  assert.equal(h.assistant().error.settingsTarget, "llms");
  assert.equal(h.assistant().error.technicalDetails.status, 401);
});

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

// The service asks the hook whether a final answer's claim is backed, as
// ReasoningService does, and streams what follows from the answer.
test("an answer asked again replaces the claim it made, and one still claiming is flagged", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  const verdicts = [];
  harness.setStream((_tools, config) =>
    (async function* () {
      yield { type: "content", text: "Let me look." };
      yield { type: "tool_calls", calls: [{ id: "c1", name: "search_notes", arguments: "{}" }] };
      yield { type: "tool_result", callId: "c1", toolName: "search_notes", displayText: "Done" };
      yield { type: "content", text: "Done! I've created the note for you." };
      verdicts.push(config.isUnbackedClaim("Done! I've created the note for you."));
      yield { type: "unbacked_claim", retry: true };
      yield { type: "content", text: "I've created the note, honestly." };
      yield { type: "unbacked_claim", retry: false };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI("Make a note of it", []);

  assert.deepEqual(verdicts, [true], "a lookup backs no claim");
  const [[, content, , details]] = harness.completed;
  assert.equal(content, "Let me look.\n\nI've created the note, honestly.");
  assert.equal(details.turn.status, "complete");
  assert.equal(details.turn.unbackedClaim, true);
});

test("an answer that claims what its turn's tools did is left alone", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  const verdicts = [];
  harness.setStream((_tools, config) =>
    (async function* () {
      verdicts.push(config.isUnbackedClaim("I've created the note."));
      yield { type: "tool_calls", calls: [{ id: "c1", name: "create_note", arguments: "{}" }] };
      yield {
        type: "tool_result",
        callId: "c1",
        toolName: "create_note",
        displayText: "Created",
        metadata: { id: 4, title: "Plan" },
      };
      verdicts.push(config.isUnbackedClaim("I've created the note."));
      yield { type: "content", text: "I've created the note." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  await harness.captured.sendToAI("Make a note", []);

  assert.deepEqual(verdicts, [true, false]);
  assert.equal(harness.completed[0][3].turn.unbackedClaim, undefined);
});

test("a report on an earlier recorded result, the user's own words and a kind with no tool are not flagged", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  const verdicts = [];
  harness.setStream((_tools, config) =>
    (async function* () {
      verdicts.push(config.isUnbackedClaim("Yes, the note was created."));
      verdicts.push(config.isUnbackedClaim("I have created the note for Dana."));
      // No send tool here: nothing to check.
      verdicts.push(config.isUnbackedClaim("I've sent it to Gabe."));
      yield { type: "content", text: "Yes, the note was created." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  const earlier = [
    { id: "u0", role: "user", content: "Make a note for Dana", isStreaming: false },
    {
      id: "a0",
      role: "assistant",
      content: "Done.",
      isStreaming: false,
      toolCalls: [
        {
          id: "c0",
          name: "create_note",
          arguments: "{}",
          status: "completed",
          metadata: { id: 3, title: "Dana" },
        },
      ],
    },
    { id: "u1", role: "user", content: "Did that work?", isStreaming: false },
  ];
  await harness.captured.sendToAI("Did that work?", earlier, {
    selectedContext: { text: "I have created the note for Dana yesterday", sourceMessageId: "" },
  });
  await harness.captured.sendToAI("Did that work?", earlier.slice(2));

  assert.deepEqual(verdicts, [false, false, false, true, true, false]);
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

  assert.equal(harness.checkpoints.length, 2);
  assert.equal(harness.checkpoints[0][3].turn.status, "running");
  const [assistantId, , waitingCalls, waitingDetails] = harness.checkpoints[1];
  assert.equal(waitingDetails.turn.status, "waiting");
  assert.equal(waitingCalls[0].interaction.state, "pending");
  assert.equal(harness.assistant().turn.status, "waiting");

  const key = `${assistantId}::q1`;
  store.updateInteractionDraft(key, { tone: "casual" });
  store.answerQuestions(key);
  // Saved again at once: the app closing before the turn ends must not offer
  // the answered question again.
  assert.equal(harness.checkpoints.length, 3);
  const [, , answeredCalls, answeredDetails] = harness.checkpoints[2];
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
  const { toolTrace } = await harness.vite.ssrLoadModule("/components/chat/historyMessages.ts");
  harness.setStream((_tools, config) =>
    (async function* () {
      yield { type: "tool_calls", calls: [{ id: "w1", name: "web_search", arguments: "{}" }] };
      await new Promise((resolve) =>
        config.signal.addEventListener("abort", resolve, { once: true })
      );
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

for (const previousOutcome of ["sent", "unknown"]) {
  test(`an earlier ${previousOutcome} attempt still needs approval and makes no definite delivery claim`, async (t) => {
    const harness = await renderChatStreaming(
      t,
      { allowConnectors: true },
      {
        statuses: SLACK_READY,
        electronAPI: {
          connectorPrepare: async () => ({
            status: "ready",
            actionId: "a1",
            preview: {
              verbKey: "post",
              destinationLabel: "#eng",
              accountLabel: "chad",
              body: "hi",
            },
          }),
          connectorCancel: async () => ({ cancelled: true }),
        },
      }
    );
    const { connectorActionKey } = await harness.vite.ssrLoadModule(
      "/services/tools/connectors/actionKey.ts"
    );
    const approvals = await harness.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
    let output, note;
    harness.setStream((tools) =>
      (async function* () {
        const running = tools.slack_send_message.execute(
          { destination: "#eng", text: "PR #12 merged!" },
          toolOptions("s2")
        );
        await new Promise((resolve) => setImmediate(resolve));
        const [entry] = Object.values(approvals.useConnectorApprovalStore.getState().entries);
        assert.deepEqual(entry.preview.notes, [{ key: "connectors.approval.sentEarlier" }]);
        const i18n = (await harness.vite.ssrLoadModule("/i18n.ts")).default;
        note = i18n.t(entry.preview.notes[0].key);
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
          metadata: { status: previousOutcome },
          actionKey: connectorActionKey("slack", "send_message", {
            destination: "#eng",
            text: "PR #12 merged!",
          }),
        },
      ],
    };
    await harness.captured.sendToAI("Post it again", [earlier]);

    assert.match(note, /tried.*earlier/);
    assert.match(note, /Check whether it went through/);
    assert.doesNotMatch(note, /already sent/);
    // The user's Send or Cancel decides; the model is never told it was already done.
    assert.equal(output.status, "cancelled_by_user");
  });
}

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

for (const cloud of [false, true]) {
  test(`regeneration preserves a sent receipt when ${cloud ? "Cloud" : "AI SDK"} reuses its call ID`, async (t) => {
    const harness = await renderChatStreaming(
      t,
      { allowConnectors: true, allowInteractions: true },
      {
        settings: cloud ? { chatAgentMode: "openwhispr" } : BYOK,
        statuses: SLACK_READY,
        electronAPI: {
          connectorPrepare: async () => ({
            status: "ready",
            actionId: "a1",
            preview: {
              verbKey: "slackPost",
              destinationLabel: "#eng",
              accountLabel: "chad",
              body: "hi",
            },
          }),
          connectorCommit: async () => ({ state: "sent", url: "https://slack.test/1" }),
          connectorCancel: async () => ({ cancelled: true }),
        },
      }
    );
    const approvals = await harness.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
    const request = { id: "u1", role: "user", content: "Post hi to #eng", isStreaming: false };
    harness.seed([request]);
    let regenerating = false;
    harness.setStream((tools, config) =>
      (async function* () {
        yield {
          type: "tool_calls",
          calls: [{ id: "s1", name: "slack_send_message", arguments: "{}" }],
        };
        const args = { destination: "#eng", text: "hi" };
        const running = cloud
          ? config.executeToolCall("slack_send_message", JSON.stringify(args), "s1")
          : tools.slack_send_message.execute(args, toolOptions("s1"));
        await new Promise((resolve) => setImmediate(resolve));
        const entry = Object.values(approvals.useConnectorApprovalStore.getState().entries).find(
          (entry) => entry.state === "pending"
        );
        if (regenerating) approvals.cancelApproval(entry.key);
        else await approvals.approveAction(entry.key);
        const output = await running;
        yield {
          type: "tool_result",
          callId: "s1",
          toolName: "slack_send_message",
          displayText: "Settled",
          metadata: cloud ? output.metadata : output,
        };
        yield { type: "content", text: regenerating ? "Nothing new sent." : "Sent." };
        yield { type: "done", finishReason: "stop" };
      })()
    );
    await harness.captured.sendToAI(request.content, [request], { conversationId: 7 });
    const reply = harness.assistant();
    const receipt = structuredClone(reply.toolCalls[0]);
    regenerating = true;
    await harness.captured.sendToAI(request.content, [request], {
      conversationId: 7,
      replaceMessage: reply,
    });

    const calls = harness.completed.at(-1)[2];
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], receipt, "the earlier send keeps its outcome, link and action key");
    assert.notEqual(calls[1].id, receipt.id);
    assert.equal(calls[1].metadata.status, "cancelled_by_user");
    const entries = Object.values(approvals.useConnectorApprovalStore.getState().entries);
    assert.equal(entries.length, 2);
    assert.equal(entries.find((entry) => entry.toolCallId === receipt.id).state, "sent");
    assert.equal(entries.find((entry) => entry.toolCallId === calls[1].id).state, "cancelled");
  });
}

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
    ["failed", "not_sent"]
  );
  assert.match(outputs[1].guidance, /may still be waiting for the user/);
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
  assert.match(harness.checkpoints.at(-1)[2][0].actionKey, /^slack\.send_message:/);
});

test("a send that lands after Stop is saved with the stopped reply", async (t) => {
  for (const state of ["sent", "unknown"])
    await t.test(state, async (t) => {
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
              preview: {
                verbKey: "post",
                destinationLabel: "#eng",
                accountLabel: "chad",
                body: "hi",
              },
            }),
            connectorCommit: () =>
              new Promise((resolve) => {
                finishCommit = () => resolve({ state, url: "https://slack.test/1" });
              }),
          },
        }
      );
      // Stop ends the model stream; the tool call, already committing, runs on.
      const approvals = await harness.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
      harness.setStream((tools, config) =>
        (async function* () {
          yield {
            type: "tool_calls",
            calls: [{ id: "s1", name: "slack_send_message", arguments: "{}" }],
          };
          void tools.slack_send_message.execute(
            { destination: "#eng", text: "hi" },
            toolOptions("s1")
          );
          await new Promise((resolve) =>
            config.signal.addEventListener("abort", resolve, { once: true })
          );
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
      assert.deepEqual(toolCalls[0].metadata, {
        status: state,
        ...(state === "sent" ? { url: "https://slack.test/1" } : {}),
      });
      const { toolTrace } = await harness.vite.ssrLoadModule("/components/chat/historyMessages.ts");
      assert.equal(
        toolTrace(toolCalls),
        state === "sent"
          ? "[Tools used: slack_send_message (sent: https://slack.test/1)]"
          : "[Tools used: slack_send_message (may have been sent)]"
      );
    });
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
  assert.equal(harness.checkpoints.at(-1)[2][0].interaction.payload.target, "slack");
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
    harness.setStream((_tools, config) =>
      (async function* () {
        yield { type: "reasoning", text: "Thinking it over." };
        if (end === "error") throw new Error("provider down");
        await new Promise((resolve) =>
          config.signal.addEventListener("abort", resolve, { once: true })
        );
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
    assert.deepEqual(
      harness.checkpoints,
      [],
      `${label}: its saved row is never overwritten before a replacement exists`
    );
    // A failure is said (the agent window shows a notice); a stop is the user's own.
    assert.equal(failures, end === "error" ? 1 : 0, label);
  }
});

test("a superseded regeneration cannot clear the newer regeneration's busy state or activity", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  const h = await renderChatStreaming(
    t,
    { allowInteractions: true, productHelpEnabled: false },
    { live: true, settings: { ...BYOK, isSignedIn: false } }
  );
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const request = { id: "u1", role: "user", content: "Explain the plan", isStreaming: false };
  const reply = { id: "a1", dbId: 9, role: "assistant", content: "Original", isStreaming: false };
  // Loading saved history keeps the database ID and assigns a new renderer ID.
  const reopenedReply = { ...reply, id: "reopened-a1" };
  h.seed([request, reply]);
  const firstEntered = Promise.withResolvers();
  const failFirst = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  const finishSecond = Promise.withResolvers();
  let calls = 0;
  h.setStream(() =>
    ++calls === 1
      ? (async function* () {
          yield { type: "reasoning", text: "" };
          firstEntered.resolve();
          await failFirst.promise;
          throw new Error("Old model setup failed after Stop");
        })()
      : (async function* () {
          yield { type: "content", text: "New replacement answer" };
          yield {
            type: "tool_calls",
            calls: [{ id: "c1", name: "search_notes", arguments: "{}" }],
          };
          secondEntered.resolve();
          await finishSecond.promise;
          yield {
            type: "tool_result",
            callId: "c1",
            toolName: "search_notes",
            displayText: "Found",
          };
          yield { type: "done", finishReason: "stop" };
        })()
  );
  let first;
  let second;
  try {
    await React.act(async () => {
      first = h.captured.sendToAI(request.content, [request], {
        conversationId: 7,
        replaceMessage: reply,
      });
      await firstEntered.promise;
    });
    await React.act(async () => h.captured.cancelStream());
    h.seed([request, reopenedReply]);
    await React.act(async () => {
      second = h.captured.sendToAI(request.content, [request], {
        conversationId: 7,
        replaceMessage: reopenedReply,
      });
      await secondEntered.promise;
    });
    const status = h.current().toolStatus;
    assert.equal(h.current().agentState, "tool-executing");
    assert.ok(status, "the newer turn has visible tool activity");
    await React.act(async () => {
      failFirst.resolve();
      await first;
      t.mock.timers.tick(3000);
    });
    assert.deepEqual(
      {
        state: h.current().agentState,
        tool: h.current().activeToolName,
        status: h.current().toolStatus,
        content: h.assistant().content,
        streaming: h.assistant().isStreaming,
      },
      {
        state: "tool-executing",
        tool: "search_notes",
        status,
        content: "New replacement answer",
        streaming: true,
      }
    );
  } finally {
    failFirst.resolve();
    finishSecond.resolve();
    await React.act(async () => Promise.allSettled([first, second].filter(Boolean)));
  }
  assert.equal(h.current().agentState, "idle", "the newer turn still completes normally");
  assert.equal(h.completed.length, 1);
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

test("an idle sibling cannot stop the turn that owns a transport", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  const { useChatStreaming } = await harness.vite.ssrLoadModule(
    "/components/chat/useChatStreaming.ts"
  );
  let sibling;
  function Sibling() {
    sibling = useChatStreaming({ setMessages() {} });
    return null;
  }
  renderToStaticMarkup(React.createElement(Sibling));
  let signal;
  let finish;
  harness.setStream((_tools, config) =>
    (async function* () {
      signal = config.signal;
      yield { type: "content", text: "Partial" };
      await new Promise((resolve) => {
        finish = resolve;
      });
      yield { type: "content", text: " answer" };
    })()
  );
  const sending = harness.captured.sendToAI("Go", []);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signal, "the stream receives its own cancellation signal");
  sibling.cancelStream();
  assert.equal(signal.aborted, false);
  finish();
  await sending;
  assert.equal(harness.completed[0][1], "Partial answer");
  assert.equal(harness.completed[0][3].turn.status, "complete");
});

test("reasoning truncated through an emoji remains valid persisted text", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  harness.setStream(() =>
    (async function* () {
      yield { type: "reasoning", text: "x".repeat(19_999) + "😀tail" };
      yield { type: "content", text: "Answer" };
    })()
  );
  await harness.captured.sendToAI("Go", []);
  const saved = harness.completed[0][3].turn.reasoning;
  assert.equal(saved.isWellFormed(), true);
  assert.ok(saved.endsWith("…"));
  assert.ok(saved.length <= 20_001);
});

test("a throwing cancelled transport saves the stopped reply exactly once", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  let fail;
  harness.setStream(() =>
    (async function* () {
      yield { type: "content", text: "Partial" };
      await new Promise((resolve) => {
        fail = resolve;
      });
      throw new Error("aborted transport");
    })()
  );
  const sending = harness.captured.sendToAI("Go", []);
  while (!fail) await new Promise((resolve) => setImmediate(resolve));
  harness.captured.cancelStream();
  fail();
  await sending;
  assert.equal(harness.completed.length, 1);
  assert.equal(harness.completed[0][1], "Partial");
  assert.equal(harness.completed[0][3].turn.status, "stopped");
});

test("a local-only policy never advertises provider key setup", async (t) => {
  const harness = await renderChatStreaming(
    t,
    { allowInteractions: true },
    {
      settings: {
        chatAgentMode: "local",
        chatAgentProvider: "local",
        chatAgentModel: "qwen3-4b-q4_k_m",
      },
    }
  );
  const { usePolicyStore } = await harness.vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({
    status: "managed",
    policy: {
      version: 1,
      llm: { allowedModes: ["local"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
      transcription: { allowedModes: ["local"], allowedByokProviders: [] },
      dataRetention: { cloudBackupAllowed: true, localHistoryMode: "user_choice" },
      sharing: { externalLinkSharing: "allowed" },
      features: { agentEnabled: true, webSearchEnabled: false },
    },
  });
  await harness.captured.sendToAI("Help", []);
  assert.equal(harness.offered[0].includes("request_api_key"), false);
});

test("a service-reported abort saves a stopped turn instead of a completed one", async (t) => {
  const harness = await renderChatStreaming(t, { allowInteractions: true });
  harness.setStream(() =>
    (async function* () {
      yield { type: "content", text: "Partial" };
      yield { type: "done", finishReason: "abort" };
    })()
  );
  await harness.captured.sendToAI("Go", []);
  assert.equal(harness.completed[0][3].turn.status, "stopped");
});
