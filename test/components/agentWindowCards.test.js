const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The agent window mounted for real with its chat and voice hooks stood in
// for (mocks match the import specifiers' ends): the test sets the chat's messages and drives main's messages. The
// interaction store, the cards and the layouts are the real ones, and the
// settings store brings the app's i18n, so labels are in English.
const MOCKS = {
  "/useAgentChat": `
    import { useSyncExternalStore } from "react";
    const listeners = new Set();
    let state = { messages: [], busy: false };
    globalThis.__chat = {
      set(next) { state = { ...state, ...next }; listeners.forEach((listener) => listener()); },
      sent: [],
    };
    export function useAgentChat() {
      const current = useSyncExternalStore(
        (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        () => state
      );
      return {
        messages: current.messages,
        busy: current.busy,
        conversationId: 1,
        forkOrigin: null,
        agentState: current.busy ? "streaming" : "idle",
        send: async (text) => { globalThis.__chat.sent.push(text); return true; },
        cancel() {},
        switchChat: async () => true,
        newChat() {},
        fork: async () => null,
        regenerate() {},
      };
    }
  `,
  "/useAgentVoice": `
    export function useAgentVoice() {
      return {
        status: "idle", opening: false, readLevel: () => 0, streamingOnlyProvider: false,
        start: async () => "started", stop() {}, cancel() {},
      };
    }
  `,
  "/useReadAloud": `
    export function useReadAloud() {
      return { available: false, speakingId: null, toggle() {}, stop() {} };
    }
  `,
  "/lib/accountScopeMirror": `export function mirrorActiveAccountScope() { return () => {}; }`,
  "/notes/AssistantNoteUndoListener": `export default function Listener() { return null; }`,
};

async function mountWindow(t) {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  // Ends the turn's waits (and their timers) while the DOM still exists.
  const turn = new AbortController();
  t.after(() => turn.abort());
  const happyWindow = await installHappyDom(t);
  const main = { layouts: [], handlers: {} };
  const on = (name) => (callback) => {
    main.handlers[name] = callback;
    return () => {};
  };
  happyWindow.electronAPI = {
    agentWindowReady() {},
    agentWindowSetLayout: async (request) => {
      main.layouts.push(request);
      return true;
    },
    agentWindowHide: async () => true,
    agentWindowSetVoiceState: async () => true,
    captureSelectedText: async () => null,
    onAgentWindowHotkey: on("hotkey"),
    onAgentWindowOpen: on("open"),
    onAgentWindowCommand: on("command"),
    onAgentWindowDismiss: on("dismiss"),
    onCancelHotkeyPressed: on("cancel"),
    connectorCancel: async () => ({ cancelled: true }),
  };
  // Frames as plain timers: the window fades through two of them around each resize.
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-agent-window-cards-",
    mockModules: MOCKS,
  });
  const interactions = await vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  const approvals = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const { default: AgentWindow } = await vite.ssrLoadModule("/components/agent/AgentWindow.tsx");
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  interactions.useAgentInteractionStore.setState({ entries: {} });
  approvals.useConnectorApprovalStore.setState({ entries: {} });
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  // As main.jsx mounts every window.
  await React.act(async () =>
    root.render(
      React.createElement(
        SettingsProvider,
        null,
        React.createElement(ToastProvider, null, React.createElement(AgentWindow))
      )
    )
  );

  // Twice: what the first round sets off (a timed commit, a resize) lands in the second.
  const wait = (ms) => React.act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const settle = async () => {
    await wait(300);
    await wait(300);
  };
  const chat = (next) => React.act(async () => globalThis.__chat.set(next));
  const button = (label) =>
    [...host.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label
    );
  const layout = () => main.layouts.at(-1)?.layout;
  // A tool call of the running turn waits on this question or answer card.
  const toolContext = (toolCallId) => ({
    messageId: "a1",
    toolCallId,
    signal: turn.signal,
    onInteraction() {},
  });
  const ask = async (toolCallId, payload) => {
    const results = [];
    await React.act(async () => {
      void interactions
        .requestInteraction(toolContext(toolCallId), payload)
        .then((result) => results.push(result));
    });
    return results;
  };
  const askApproval = (toolCallId) =>
    React.act(async () => {
      void approvals.requestApproval(
        toolContext(toolCallId),
        { actionId: "act-1", connectorId: "slack", preview: SLACK_PREVIEW },
        async () => undefined
      );
    });
  return {
    happyWindow,
    host,
    main,
    interactions,
    approvals,
    settle,
    chat,
    button,
    layout,
    ask,
    askApproval,
    wait,
  };
}

const SLACK_PREVIEW = {
  verbKey: "slackPost",
  destinationLabel: "#general",
  accountLabel: "QA Fixture",
  workspaceLabel: "Fixture Co",
  body: "The homepage draft is ready.",
};

const QUESTION = {
  kind: "questions",
  questions: [
    {
      id: "goal",
      kind: "single",
      prompt: "What are you optimizing for?",
      options: [
        { id: "speed", label: "Speed" },
        { id: "cost", label: "Cost" },
      ],
    },
  ],
};

const reply = (toolCalls, content = "") => ({
  id: "a1",
  role: "assistant",
  content,
  isStreaming: true,
  toolCalls,
});
const askUser = { id: "c1", name: "ask_user", arguments: "{}", status: "executing" };

// A spoken request whose reply asks a question first.
async function askWhileCompact(view) {
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  assert.equal(view.layout(), "pill");
  await view.chat({
    busy: true,
    messages: [
      { id: "u1", role: "user", content: "Plan it", isStreaming: false },
      reply([askUser]),
    ],
  });
  const results = await view.ask("c1", QUESTION);
  await view.settle();
  return results;
}

test("a question that arrives while compact shows above the waiting pill, then the answer opens the modal", async (t) => {
  const view = await mountWindow(t);
  const results = await askWhileCompact(view);

  assert.equal(view.layout(), "standalone", "the card above the pill, not the modal");
  const sized = view.main.layouts.at(-1);
  assert.equal(typeof sized.contentHeight, "number");
  assert.ok(view.host.querySelector("[data-interaction-card]"));
  assert.match(view.host.textContent, /Waiting for answer/);
  assert.ok(view.button("Expand").className.includes("agent-expand-cue"));
  assert.equal(view.host.querySelector(".agent-modal"), null);

  await React.act(async () => view.host.querySelector('[role="radio"]').click());
  await view.settle();
  assert.deepEqual(results, [{ status: "answered", answers: { goal: "speed" } }]);
  assert.equal(view.layout(), "pill", "the pill on its own again");

  // The reply goes on and has something to show: the modal opens to it.
  await view.chat({
    messages: [
      { id: "u1", role: "user", content: "Plan it", isStreaming: false },
      reply([{ ...askUser, status: "completed" }], "Optimizing for speed."),
    ],
  });
  await view.settle();
  assert.equal(view.layout(), "modal");
});

test("minimized with a card waiting, the pill waits; Keyboard reopens it, and the composer answers it", async (t) => {
  const view = await mountWindow(t);
  const results = await askWhileCompact(view);
  await React.act(async () => view.button("Expand").click());
  await view.settle();
  assert.equal(view.layout(), "modal");

  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.equal(view.layout(), "pill", "the waiting pill, not the card above it");
  assert.equal(view.host.querySelector("[data-interaction-card]"), null);
  assert.match(view.host.textContent, /Waiting for answer/);

  await React.act(async () => view.button("Type").click());
  await view.settle();
  assert.equal(view.layout(), "modal");
  const composer = view.host.querySelector("textarea");
  assert.equal(composer.getAttribute("placeholder"), "Answer here…");

  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      view.happyWindow.HTMLTextAreaElement.prototype,
      "value"
    ).set.call(composer, "Whatever is cheapest");
    composer.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
  });
  const send = view.button("Send");
  assert.equal(send.disabled, false, "Send answers the question while the turn waits");
  await React.act(async () => send.click());
  assert.deepEqual(results, [{ status: "answered", answers: { goal: "Whatever is cheapest" } }]);
  assert.deepEqual(globalThis.__chat.sent, [], "the answer is no new request");
});

test("a reply whose first step is a tool, not a question, opens the modal", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({
    busy: true,
    messages: [reply([{ id: "c2", name: "search_notes", arguments: "{}", status: "executing" }])],
  });
  await view.settle();
  assert.equal(view.layout(), "modal");
});

test("a connector step that asks to connect first keeps its card above the pill", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  const slack = { id: "c3", name: "slack_send_message", arguments: "{}", status: "executing" };
  await view.chat({ busy: true, messages: [reply([slack])] });
  // The connect card registers just after the step starts.
  await view.ask("c3", { kind: "connection", target: "slack" });
  await view.chat({
    messages: [
      reply([
        {
          ...slack,
          interaction: { payload: { kind: "connection", target: "slack" }, state: "pending" },
        },
      ]),
    ],
  });
  await view.settle();
  assert.equal(view.layout(), "standalone");
  assert.match(view.host.textContent, /Connect Slack/);
});

const user = { id: "u1", role: "user", content: "Plan it", isStreaming: false };
// Text fields outside the cards (an answer card edits its message in one).
const composers = (view) =>
  [...view.host.querySelectorAll("textarea")].filter(
    (field) => !field.closest("[data-approval-card]")
  ).length;
const slackCall = { id: "c5", name: "slack_send_message", arguments: "{}", status: "executing" };

test("a card that arrives while typing: a question shows above the pill, an answer card waits behind it", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  // Keyboard on the pill while the request thinks: the typing layout.
  await React.act(async () => view.button("Type").click());
  await view.settle();
  assert.equal(view.layout(), "typing");

  const results = await view.ask("c1", QUESTION);
  await view.settle();
  assert.equal(view.layout(), "standalone");
  assert.ok(view.host.querySelector("[data-interaction-card]"));
  assert.match(view.host.textContent, /Waiting for answer/);
  await React.act(async () => view.host.querySelector('[role="radio"]').click());
  await view.settle();
  assert.equal(results.length, 1);
  assert.equal(view.layout(), "typing", "back to typing once it is answered");

  // An answer card from the typing layout: the waiting pill.
  await view.chat({ messages: [user, reply([{ ...askUser, status: "completed" }, slackCall])] });
  await view.askApproval("c5");
  await view.wait(100);
  assert.equal(view.layout(), "pill");
  assert.match(view.host.textContent, /Waiting for answer/);
});

test("an answer card the reply opened the modal for still opens it again after a minimize", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([slackCall])] });
  await view.askApproval("c5");
  await view.settle();
  assert.equal(view.layout(), "modal", "the reply's step opened it");
  // In the modal the card has its own Send: the voice pill is the turn's, not waiting.
  assert.ok(view.host.querySelector("[data-approval-card]"));
  assert.doesNotMatch(view.host.textContent, /Waiting for answer/);

  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.equal(view.layout(), "pill");
  assert.match(view.host.textContent, /Waiting for answer/);
  assert.ok(view.button("Expand").className.includes("agent-expand-cue"));
  await view.wait(2800);
  assert.equal(view.layout(), "pill");
  await view.wait(1500);
  await view.settle();
  assert.equal(view.layout(), "modal", "opened about four seconds after the minimize");
  assert.equal(composers(view), 0, "a voice request opens with no composer");
});

test("in the voice modal the pill waits for a question, and Expand adds no composer", async (t) => {
  const view = await mountWindow(t);
  await askWhileCompact(view);
  await React.act(async () => view.button("Expand").click());
  await view.settle();
  assert.equal(view.layout(), "modal");
  assert.equal(composers(view), 0);
  assert.match(view.host.textContent, /Waiting for answer/);
});

test("a click on a card above the pill asks for the keyboard", async (t) => {
  const view = await mountWindow(t);
  await askWhileCompact(view);
  assert.equal(view.main.layouts.at(-1).focus, false);
  const card = view.host.querySelector("[data-interaction-card]");
  await React.act(async () =>
    card.dispatchEvent(new view.happyWindow.PointerEvent("pointerdown", { bubbles: true }))
  );
  await view.settle();
  assert.deepEqual(
    [view.main.layouts.at(-1).layout, view.main.layouts.at(-1).focus],
    ["standalone", true]
  );
});

test("a reply never reopens a modal the user opened and then minimized", async (t) => {
  const view = await mountWindow(t);
  await askWhileCompact(view);
  await React.act(async () => view.button("Expand").click());
  await view.settle();
  await React.act(async () => view.host.querySelector('[role="radio"]').click());
  await view.settle();
  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.equal(view.layout(), "pill");

  await view.chat({
    messages: [user, reply([{ ...askUser, status: "completed" }], "Optimizing for speed.")],
  });
  await view.settle();
  assert.equal(view.layout(), "pill");
});

test("a step's moment to show its card starts once, however often the reply streams", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  const search = { id: "c2", name: "search_notes", arguments: "{}", status: "completed" };
  const streaming = (reasoning) => ({ ...reply([search]), reasoning });
  await view.chat({ busy: true, messages: [user, streaming("a")] });
  // Reasoning streams in every 60 ms, well inside the 300 ms each time.
  for (let i = 0; i < 8; i++) {
    await view.wait(60);
    await view.chat({ messages: [user, streaming("a".repeat(i + 2))] });
  }
  assert.equal(view.layout(), "modal");
});

test("a card restored from a turn that ended doesn't wait anything", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ messages: [user, { ...reply([askUser]), isStreaming: false }] });
  await React.act(async () =>
    view.interactions.restoreInteraction(
      { messageId: "a1", toolCallId: "c1", payload: QUESTION },
      () => {}
    )
  );
  await view.settle();
  assert.equal(view.layout(), "pill");
  assert.doesNotMatch(view.host.textContent, /Waiting for answer/);
  assert.ok(!view.button("Expand")?.className.includes("agent-expand-cue"));
});

test("on a connect card the composer points at the card", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await view.ask("c1", { kind: "connection", target: "slack" });
  await view.settle();
  const composer = view.host.querySelector("textarea");
  assert.equal(composer.getAttribute("placeholder"), "Answer on the card above…");
});
