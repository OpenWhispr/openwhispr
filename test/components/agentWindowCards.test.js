const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The agent window mounted for real with its chat and voice hooks stood in
// for (mocks match the import specifiers' ends): the test sets the chat's messages and drives main's messages. The
// interaction store, the cards and the layouts are the real ones, and the
// settings store brings the app's i18n, so labels are in English.
const MOCKS = {
  "/services/editSelectedText": `
    export async function editSelectedText(instruction, selectedText, options) {
      globalThis.__selectionEdits.calls.push({ instruction, selectedText, ...options });
      return globalThis.__selectionEdits.result;
    }
  `,
  "/useAgentChat": `
    import { useSyncExternalStore } from "react";
    const listeners = new Set();
    let state = { messages: [], busy: false };
    globalThis.__chat = {
      set(next) { state = { ...state, ...next }; listeners.forEach((listener) => listener()); },
      sent: [],
      sentOptions: [],
      // How many new chats had started when each request was sent.
      sentAfterNewChats: [],
      cancels: 0,
      newChats: 0,
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
        forkOrigin: current.forkOrigin ?? null,
        agentState: current.busy ? "streaming" : "idle",
        send: async (text, options) => {
          globalThis.__chat.sentOptions.push(options);
          globalThis.__chat.sent.push(text);
          globalThis.__chat.sentAfterNewChats.push(globalThis.__chat.newChats);
          return globalThis.__chat.sendResult ?? true;
        },
        cancel() { globalThis.__chat.cancels += 1; },
        switchChat: async (_id, beforeOpen) => {
          const result = await ("switchResult" in globalThis.__chat ? globalThis.__chat.switchResult : true);
          if (result === true) beforeOpen?.();
          return result;
        },
        newChat() { globalThis.__chat.newChats += 1; },
        fork: async () => null,
        regenerate() {},
      };
    }
  `,
  "/useAgentVoice": `
    import { useSyncExternalStore } from "react";
    const listeners = new Set();
    let status = "idle";
    globalThis.__voice = {
      cancels: 0,
      events: [],
      set(next) { status = next; listeners.forEach((listener) => listener()); },
    };
    export function useAgentVoice(options) { globalThis.__voice.callbacks = options;
      const current = useSyncExternalStore(
        (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        () => status
      );
      return {
        status: current, opening: false, readLevel: () => 0, streamingOnlyProvider: false,
        start: async () => {
          globalThis.__voice.events.push("start");
          return globalThis.__voice.startResult ?? "started";
        },
        stop(intent) { globalThis.__voice.events.push("stop:" + intent); },
        cancel() { globalThis.__voice.cancels++; },
      };
    }
  `,
  "/useReadAloud": `
    export function useReadAloud() {
      return { available: false, speakingId: null, toggle() {},
        stop() { globalThis.__voice.events.push("stopReading"); } };
    }
  `,
  "/lib/accountScopeMirror": `export function mirrorActiveAccountScope() { return () => {}; }`,
  "/notes/AssistantNoteUndoListener": `export default function Listener() { return null; }`,
};

async function mountWindow(t, { platform } = {}) {
  globalThis.__selectionEdits = { calls: [], result: null };
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  // Ends the turn's waits (and their timers) while the DOM still exists. The
  // end of a turn withdraws only a card waiting on the user, so a card a test
  // left sending waits again first, as a Send that didn't go out leaves it.
  const turn = new AbortController();
  let approvalStore = null;
  t.after(() => {
    approvalStore?.setState(({ entries }) => ({
      entries: Object.fromEntries(
        Object.entries(entries).map(([key, entry]) => [
          key,
          entry.state === "committing" ? { ...entry, state: "pending" } : entry,
        ])
      ),
    }));
    turn.abort();
  });
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
    ...(platform ? { getPlatform: () => platform } : {}),
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
  approvalStore = approvals.useConnectorApprovalStore;
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
  const waitForLayout = async (expected) => {
    const shown = () => layout() === expected && host.querySelector('[data-shown="true"]');
    const deadline = Date.now() + 5000;
    while (!shown() && Date.now() < deadline) await wait(20);
    assert.ok(shown(), `the ${expected} layout finished its resize before teardown`);
  };
  // A tool call of the running turn waits on this question or answer card.
  const toolContext = (toolCallId, messageId = "a1") => ({
    messageId,
    toolCallId,
    signal: turn.signal,
    onInteraction() {},
  });
  const ask = async (toolCallId, payload, messageId = "a1") => {
    const results = [];
    await React.act(async () => {
      void interactions
        .requestInteraction(toolContext(toolCallId, messageId), payload)
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
    vite,
    happyWindow,
    host,
    main,
    interactions,
    approvals,
    settle,
    chat,
    button,
    layout,
    waitForLayout,
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

const TEXT_QUESTION = {
  kind: "questions",
  questions: [{ id: "deadline", kind: "text", prompt: "When is it due?" }],
};

// A spoken request whose reply asks a question first.
async function askWhileCompact(view, payload = QUESTION) {
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
  const results = await view.ask("c1", payload);
  await view.settle();
  return results;
}

for (const input of ["mic", "hotkey"]) {
  test(`${input} stops read-aloud before starting a take, preserving busy and toggle behavior`, async (t) => {
    const view = await mountWindow(t);
    await React.act(async () => view.main.handlers.open({ layout: "modal" }));
    await view.settle();
    const start = () =>
      React.act(async () =>
        input === "mic"
          ? view.button("Speak").click()
          : view.main.handlers.hotkey({ external: false })
      );
    globalThis.__voice.events.length = 0;
    await view.chat({ busy: true });
    await start();
    assert.deepEqual(globalThis.__voice.events, [], "a busy rejection leaves playback alone");
    await view.chat({ busy: false });
    await start();
    const started = [...globalThis.__voice.events];
    globalThis.__voice.events.length = 0;
    await React.act(async () => globalThis.__voice.set("recording"));
    await React.act(async () => view.main.handlers.hotkey({ external: false }));
    assert.deepEqual(globalThis.__voice.events, ["stop:submit"], "a second hotkey stops the take");
    await React.act(async () => globalThis.__voice.set("idle"));
    await view.settle();
    await view.waitForLayout("modal");
    assert.deepEqual(started, ["stopReading", "start"]);
  });
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
// The composer's field, never an answer card's message.
const COMPOSER = "textarea:not([data-approval-card] textarea)";
const KEY_CARD = { kind: "apiKey", provider: "openai", providerName: "OpenAI" };
const KEY_FIELD = '[data-interaction-card] input[type="password"]';

const setDraft = (view, field, text) =>
  React.act(async () => {
    Object.getOwnPropertyDescriptor(
      view.happyWindow.HTMLTextAreaElement.prototype,
      "value"
    ).set.call(field, text);
    field.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
  });

test("a refused agent submission restores its draft, selected context and screenshot", async (t) => {
  const view = await mountWindow(t);
  await view.chat({ busy: true });
  globalThis.__chat.sendResult = false;
  await React.act(async () =>
    view.main.handlers.command({
      text: "Explain this",
      selectedContext: { text: "Original selection", source: "external" },
      attachment: { image: "original-image", mediaType: "image/jpeg" },
    })
  );
  await view.chat({ busy: false });
  await view.settle();
  await React.act(async () => view.button("Send").click());
  await view.settle();
  assert.equal(view.host.querySelector(COMPOSER).value, "Explain this");
  assert.match(view.host.textContent, /Original selection/);
  assert.match(view.host.textContent, /message wasn't sent/);
  globalThis.__chat.sendResult = true;
  await React.act(async () => view.button("Send").click());
  assert.deepEqual(globalThis.__chat.sentOptions.at(-1), {
    selectedContext: { text: "Original selection", sourceMessageId: "", source: "external" },
    attachment: { image: "original-image", mediaType: "image/jpeg" },
  });
  await view.waitForLayout("modal");
});

test("a late agent refusal cannot overwrite newer draft, context or screenshot", async (t) => {
  const view = await mountWindow(t);
  let refuse;
  globalThis.__chat.sendResult = new Promise((resolve) => {
    refuse = resolve;
  });
  await React.act(async () =>
    view.main.handlers.command({
      text: "Old request",
      selectedContext: { text: "Old selection" },
      attachment: { image: "old-image", mediaType: "image/jpeg" },
    })
  );
  await view.settle();
  await React.act(async () =>
    view.main.handlers.command({
      text: "New request",
      selectedContext: { text: "New selection" },
      attachment: { image: "new-image", mediaType: "image/jpeg" },
    })
  );
  await React.act(async () => refuse(false));
  assert.equal(view.host.querySelector(COMPOSER).value, "New request");
  assert.match(view.host.textContent, /New selection/);
  assert.doesNotMatch(view.host.textContent, /Old selection/);
  globalThis.__chat.sendResult = true;
  await React.act(async () => view.button("Send").click());
  assert.equal(globalThis.__chat.sentOptions.at(-1).selectedContext.text, "New selection");
  assert.equal(globalThis.__chat.sentOptions.at(-1).attachment.image, "new-image");
  await view.waitForLayout("modal");
});

test("a late agent refusal leaves a newer typed draft in the same chat alone", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  let refuse;
  globalThis.__chat.sendResult = new Promise((resolve) => {
    refuse = resolve;
  });
  await React.act(async () => view.main.handlers.command({ text: "Old request" }));
  await view.settle();
  await setDraft(view, view.host.querySelector(COMPOSER), "Newer typed request");
  await React.act(async () => refuse(false));
  assert.equal(view.host.querySelector(COMPOSER).value, "Newer typed request");
  assert.match(view.host.textContent, /message wasn't sent/);
});

test("a deleted parent chip leaves the agent's take and current chat untouched", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.chat({
    forkOrigin: { parentConversationId: 9, parentTitle: "Deleted parent", copiedMessageCount: 0 },
  });
  await view.settle();
  globalThis.__chat.switchResult = null;
  const cancellations = globalThis.__voice.cancels;
  await React.act(async () => view.button('Forked from "Deleted parent"').click());
  assert.equal(globalThis.__voice.cancels, cancellations);
  assert.equal(globalThis.__chat.cancels, 0);
  assert.match(view.host.textContent, /Deleted parent/);
  assert.match(view.host.textContent, /no longer available/);
});
const pointer = (view, target, type, init = {}) =>
  React.act(async () =>
    target.dispatchEvent(new view.happyWindow.PointerEvent(type, { bubbles: true, ...init }))
  );

// Text fields outside the cards (an answer card edits its message in one).
const composers = (view) =>
  [...view.host.querySelectorAll("textarea")].filter(
    (field) => !field.closest("[data-approval-card]")
  ).length;
const slackCall = { id: "c5", name: "slack_send_message", arguments: "{}", status: "executing" };

test("a card that arrives while typing: a question shows above the pill, an answer card opens the modal", async (t) => {
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

  // An answer card from the typing layout opens in the modal: the keyboard
  // stays with the window instead of going to the app behind.
  await view.chat({ messages: [user, reply([{ ...askUser, status: "completed" }, slackCall])] });
  await view.askApproval("c5");
  await view.waitForLayout("modal");
  assert.equal(view.layout(), "modal");
  assert.equal(view.main.layouts.at(-1).focus, true);
});

test("a question that replaces the typing composer takes the keyboard, so Esc dismisses it", async (t) => {
  const view = await mountWindow(t);
  const { document } = view.happyWindow;
  document.hasFocus = () => true;
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await React.act(async () => view.button("Type").click());
  await view.settle();
  view.host.querySelector("textarea").focus();

  const results = await view.ask("c1", QUESTION);
  await view.settle();
  assert.equal(view.layout(), "standalone");
  assert.ok(
    view.host.querySelector("[data-interaction-card]").contains(document.activeElement),
    "focus in the card, not on the page"
  );
  await React.act(async () =>
    document.activeElement.dispatchEvent(
      new view.happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
  );
  assert.deepEqual(results, [{ status: "cancelled" }]);
  assert.equal(globalThis.__chat.cancels, 0, "the turn goes on");
});

test("the window being given the keyboard doesn't count as starting on the card", async (t) => {
  const view = await mountWindow(t);
  await askWhileCompact(view, TEXT_QUESTION);
  assert.equal(view.layout(), "standalone");
  // Windows and Linux focus the window for a card that needs typing; the card
  // puts that focus in its field.
  await React.act(async () => view.happyWindow.dispatchEvent(new view.happyWindow.Event("focus")));
  assert.ok(view.button("Expand").className.includes("agent-expand-cue"), "still cued");
  await view.wait(4200);
  await view.settle();
  assert.equal(view.layout(), "modal", "and it still opens");
});

test("working on a card in the modal uses up its timed open", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([slackCall])] });
  await view.askApproval("c5");
  await view.settle();
  assert.equal(view.layout(), "modal");
  await React.act(async () =>
    view.host
      .querySelector("[data-approval-card] textarea")
      .dispatchEvent(new view.happyWindow.PointerEvent("pointerdown", { bubbles: true }))
  );
  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.equal(view.layout(), "pill");
  assert.ok(!view.button("Expand").className.includes("agent-expand-cue"));
  await view.wait(4500);
  assert.equal(view.layout(), "pill", "no second open");
});

test("the composer answers a restored question, and points at a card only when it shows one", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ messages: [user, { ...reply([askUser]), isStreaming: false }] });
  const answered = [];
  await React.act(async () =>
    view.interactions.restoreInteraction(
      { messageId: "a1", toolCallId: "c1", payload: QUESTION },
      (result) => answered.push(result)
    )
  );
  await view.settle();
  const composer = view.host.querySelector("textarea");
  assert.equal(composer.getAttribute("placeholder"), "Answer here…");
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      view.happyWindow.HTMLTextAreaElement.prototype,
      "value"
    ).set.call(composer, "Whatever is cheapest");
    composer.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
  });
  await React.act(async () => view.button("Send").click());
  assert.deepEqual(answered, [{ status: "answered", answers: { goal: "Whatever is cheapest" } }]);
  assert.deepEqual(globalThis.__chat.sent, [], "not sent as a new request");
});

// The answer card's Send was pressed: it is sending.
const sendCard = (view, toolCallId) =>
  React.act(async () =>
    view.approvals.useConnectorApprovalStore.setState(({ entries }) => {
      const key = view.approvals.approvalKey("a1", toolCallId);
      return { entries: { ...entries, [key]: { ...entries[key], state: "committing" } } };
    })
  );

test("the composer keeps Stop beside a card with no dismiss control, and never beside one with its own", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  const step = (id) => ({ ...askUser, id });
  await view.chat({
    busy: true,
    messages: [user, reply([step("c1"), step("c2"), step("c3"), slackCall])],
  });
  assert.ok(view.button("Stop"), "a running reply can be stopped");

  const cases = [
    ["c1", QUESTION, true],
    ["c2", KEY_CARD, true],
    ["c3", { kind: "connection", target: "slack" }, false],
  ];
  for (const [toolCallId, payload, stops] of cases) {
    await view.ask(toolCallId, payload);
    await view.settle();
    assert.equal(Boolean(view.button("Stop")), stops, `${payload.kind} card`);
    await React.act(async () =>
      view.interactions.cancelInteraction(view.approvals.approvalKey("a1", toolCallId))
    );
  }

  await view.askApproval("c5");
  await view.settle();
  assert.ok(!view.button("Stop"), "an answer card carries the turn");
  await sendCard(view, "c5");
  assert.ok(!view.button("Stop"), "and while it sends");
});

test("historical and regenerated carried sends cannot hide Stop for a new turn", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([{ ...slackCall, startedAt: 10 }])] });
  await view.askApproval("c5");
  await sendCard(view, "c5");
  assert.ok(!view.button("Stop"), "the current send carries its turn");

  const historical = {
    ...reply([{ ...slackCall, startedAt: 10 }], "Sending."),
    isStreaming: false,
  };
  await view.chat({
    busy: true,
    messages: [
      user,
      historical,
      { ...user, id: "u2", content: "Another task" },
      { ...reply([], "Working."), id: "a2" },
    ],
  });
  assert.ok(view.button("Stop"), "an older reply's send leaves the new turn stoppable");

  await view.chat({
    busy: true,
    messages: [
      user,
      {
        ...reply([{ ...slackCall, startedAt: 10 }], "Trying again."),
        turn: { startedAt: 100, status: "running" },
      },
    ],
  });
  assert.ok(view.button("Stop"), "a regenerated reply's carried send is from its old turn");
});

test("an answer card that waits or sends leaves the pill at rest, in the modal and minimized", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([slackCall], "Drafting it now.")] });
  await view.settle();
  assert.equal(view.layout(), "modal");
  assert.ok(view.button("Stop"), "the voice pill stops a streaming reply");
  await view.askApproval("c5");
  await view.settle();
  assert.ok(!view.button("Stop"), "no Stop while the card waits");
  assert.ok(view.button("Speak") && view.button("Type") && view.button("Close"));

  await sendCard(view, "c5");
  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.equal(view.layout(), "pill");
  assert.ok(!view.button("Stop"), "the pill on its own offers no Stop while the card sends");
});

test("the modal's glow is full on an empty chat, faint while speaking or working in one, gone at rest or while a card waits", async (t) => {
  const view = await mountWindow(t);
  const glow = () => view.host.querySelector(".agent-modal-glow").getAttribute("data-glow");
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  assert.equal(glow(), "strong");
  await React.act(async () => globalThis.__voice.set("recording"));
  assert.equal(glow(), "strong", "speaking into the empty chat, as the design's empty modal");
  await React.act(async () => globalThis.__voice.set("idle"));
  await view.chat({ busy: true, messages: [user, reply([slackCall])] });
  assert.equal(glow(), "soft");
  await view.askApproval("c5");
  await view.settle();
  assert.equal(glow(), "none");
  await view.chat({ busy: false, messages: [user, { ...reply([], "Done."), isStreaming: false }] });
  assert.equal(glow(), "none");
  await React.act(async () => globalThis.__voice.set("recording"));
  assert.equal(glow(), "soft", "speaking a follow-up in the chat");
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`the window's opaque surfaces need no backdrop blur on ${platform}`, async (t) => {
    const view = await mountWindow(t, { platform });
    assert.equal(view.host.querySelector(".agent-window").hasAttribute("data-blur"), false);
  });
}

test("a fork with nothing of its own yet shows its chip, not the new-chat prompt", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  assert.match(view.host.textContent, /What can I help with/);
  await view.chat({
    messages: [user, { ...reply([], "Here is the plan."), isStreaming: false }],
    forkOrigin: {
      parentConversationId: 1,
      parentTitle: "Plan",
      context: null,
      copiedMessageCount: 2,
    },
  });
  await view.settle();
  assert.match(view.host.textContent, /Forked from/);
  assert.doesNotMatch(view.host.textContent, /What can I help with|Here is the plan/);
});

test("a fork of a reply left waiting on a question shows it, for the composer to answer", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  const asking = {
    ...askUser,
    status: "stopped",
    interaction: { payload: QUESTION, state: "interrupted" },
  };
  await view.chat({
    messages: [user, { ...reply([asking]), isStreaming: false }],
    forkOrigin: {
      parentConversationId: 1,
      parentTitle: "Plan",
      context: null,
      copiedMessageCount: 2,
    },
  });
  // As the fork's chat restores a question its last reply left unanswered.
  await React.act(async () =>
    view.interactions.restoreInteraction(
      { messageId: "a1", toolCallId: "c1", payload: QUESTION },
      () => {}
    )
  );
  await view.settle();
  assert.match(view.host.textContent, /Forked from/);
  assert.ok(view.host.querySelector("[data-interaction-card]"), "the question is on screen");
  assert.equal(view.host.querySelector(COMPOSER).getAttribute("placeholder"), "Answer here…");
});

test("a held command over a waiting connect card types with the usual placeholder", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await view.ask("c1", { kind: "connection", target: "slack" });
  await view.settle();
  await React.act(async () => view.button("Expand").click());
  await view.settle();
  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  // A wake-word command while the turn runs waits in the typing composer.
  await React.act(async () => view.main.handlers.command({ text: "and Linear too" }));
  await view.settle();
  assert.equal(view.layout(), "typing");
  assert.notEqual(
    view.host.querySelector("textarea").getAttribute("placeholder"),
    "Answer on the card above…",
    "no card shows above this composer"
  );
});

test("only the pill that reads Waiting for answer, or a notice, asks for the wide window", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await view.settle();
  assert.deepEqual(
    [view.main.layouts.at(-1).layout, view.main.layouts.at(-1).wide],
    ["pill", undefined],
    "the thinking pill stays narrow"
  );
  await view.ask("c1", QUESTION);
  await view.settle();
  await React.act(async () => view.button("Expand").click());
  await view.settle();
  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.deepEqual(
    [view.main.layouts.at(-1).layout, view.main.layouts.at(-1).wide],
    ["pill", true]
  );
  await React.act(async () => view.button("Expand").click());
  await view.settle();
  await React.act(async () => view.host.querySelector('[role="radio"]').click());
  await view.settle();
  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.deepEqual(
    [view.main.layouts.at(-1).layout, view.main.layouts.at(-1).wide],
    ["pill", undefined],
    "narrow again once answered"
  );

  // A notice in the pill (here: the hotkey while dictation has the mic).
  await view.chat({ busy: false, messages: [user, { ...reply([], "Done."), isStreaming: false }] });
  await view.settle();
  globalThis.__voice.startResult = "refused";
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  assert.match(view.host.textContent, /Dictation is using the mic/);
  assert.deepEqual(
    [view.main.layouts.at(-1).layout, view.main.layouts.at(-1).wide],
    ["pill", true],
    "a notice has room to read"
  );
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

for (const [what, payload] of [
  ["a key card", { kind: "apiKey", provider: "openai", providerName: "OpenAI" }],
  ["a text question", TEXT_QUESTION],
]) {
  test(`${what} that arrives while a message is being typed opens in the modal and leaves the message the keyboard`, async (t) => {
    const view = await mountWindow(t);
    const { document } = view.happyWindow;
    document.hasFocus = () => true;
    await React.act(async () => view.main.handlers.hotkey({ external: false }));
    await view.settle();
    await view.chat({ busy: true, messages: [user, reply([askUser])] });
    await React.act(async () => view.button("Type").click());
    await view.settle();
    const typing = view.host.querySelector("textarea");
    typing.focus();
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(
        view.happyWindow.HTMLTextAreaElement.prototype,
        "value"
      ).set.call(typing, "and also check my cal");
      typing.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
    });

    await view.ask("c1", payload);
    // Not even during the fade: the card never takes the keyboard from the message.
    const field = () => view.host.querySelector("[data-interaction-card] input");
    assert.ok(document.activeElement !== field(), "the card's field doesn't take it on arrival");
    await view.settle();
    assert.equal(view.layout(), "modal");
    assert.equal(view.host.querySelector(`${COMPOSER}`).value, "and also check my cal");
    assert.ok(document.activeElement !== field(), "nor once the modal shows");
    // Compared by identity: a failed deep-equal of two DOM nodes inspects the whole document.
    assert.ok(
      document.activeElement === view.host.querySelector(COMPOSER),
      "the message keeps the keyboard"
    );
    assert.equal(field().value, "", "nothing landed in the card");
  });
}

test("the typing composer never answers a restored question it doesn't show", async (t) => {
  const view = await mountWindow(t);
  await view.chat({ messages: [user, { ...reply([askUser]), isStreaming: false }] });
  const answered = [];
  await React.act(async () =>
    view.interactions.restoreInteraction(
      { messageId: "a1", toolCallId: "c1", payload: QUESTION },
      (result) => answered.push(result)
    )
  );
  await React.act(async () => view.main.handlers.open({ layout: "typing" }));
  await view.settle();
  assert.equal(view.layout(), "typing");
  const composer = view.host.querySelector("textarea");
  assert.notEqual(composer.getAttribute("placeholder"), "Answer here…");
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      view.happyWindow.HTMLTextAreaElement.prototype,
      "value"
    ).set.call(composer, "What is on my calendar today?");
    composer.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
  });
  await React.act(async () => view.button("Send").click());
  assert.deepEqual(globalThis.__chat.sent, ["What is on my calendar today?"], "a new request");
  assert.deepEqual(answered, [], "the old question is left as it was");
});

test("a question that arrives at the pill opens the card without widening the pill first", async (t) => {
  const view = await mountWindow(t);
  await askWhileCompact(view);
  const firstCard = view.main.layouts.findIndex((request) => request.layout === "standalone");
  assert.ok(firstCard > 0);
  assert.ok(
    view.main.layouts.slice(0, firstCard).every((request) => !request.wide),
    "no wide pill shown for a moment before the card"
  );
});

for (const [what, payload] of [
  ["a question", QUESTION],
  ["a key card", KEY_CARD],
]) {
  test(`the timed open of ${what} never takes the keyboard from the app the user went to`, async (t) => {
    const view = await mountWindow(t);
    const { document } = view.happyWindow;
    await React.act(async () => view.main.handlers.open({ layout: "modal" }));
    await view.settle();
    await view.chat({ busy: true, messages: [user, reply([askUser])] });
    await view.ask("c1", payload);
    await view.settle();
    await React.act(async () => view.button("Minimize").click());
    await view.settle();
    // The window lost the keyboard (main blurred it on Windows and Linux; on
    // macOS the user is in another app), and the user types there.
    document.hasFocus = () => false;
    await view.wait(4300);
    await view.settle();
    assert.equal(view.layout(), "modal", "the timed open");
    assert.equal(view.main.layouts.at(-1).focus, false, "main isn't asked for the keyboard");
    assert.ok(!view.host.querySelector("[data-interaction-card]").contains(document.activeElement));

    // Pointing at the window gives it the keyboard.
    document.hasFocus = () => true;
    await pointer(view, view.host.querySelector(".agent-window-content"), "pointerdown");
    await view.settle();
    assert.equal(view.main.layouts.at(-1).focus, true);
  });
}

test("a message typed before a question arrives is never sent as its answer", async (t) => {
  const view = await mountWindow(t);
  const { document } = view.happyWindow;
  document.hasFocus = () => true;
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await React.act(async () => view.button("Type").click());
  await view.settle();
  const typing = view.host.querySelector("textarea");
  typing.focus();
  await setDraft(view, typing, "and also check my cal");
  const results = await view.ask("c1", TEXT_QUESTION);
  await view.settle();
  assert.equal(view.layout(), "modal");
  const composer = view.host.querySelector(COMPOSER);
  assert.equal(composer.value, "and also check my cal");
  assert.equal(view.button("Send").disabled, true, "Send stays off: the turn is busy");
  await React.act(async () =>
    composer.dispatchEvent(
      new view.happyWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    )
  );
  assert.deepEqual(results, [], "Enter doesn't answer the question with the message");
  assert.deepEqual(globalThis.__chat.sent, []);

  // Once the message is gone, the composer answers the question as usual.
  await setDraft(view, composer, "");
  assert.equal(composer.getAttribute("placeholder"), "Answer here…");
  await setDraft(view, composer, "Friday");
  await React.act(async () => view.button("Send").click());
  assert.deepEqual(results, [{ status: "answered", answers: { deadline: "Friday" } }]);
});

test("a spoken command that arrives while a question waits is held as a message, never its answer", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  const results = await view.ask("c1", TEXT_QUESTION);
  await view.settle();
  // A wake-word command while the question waits goes into the composer.
  await React.act(async () => view.main.handlers.command({ text: "and email Dana" }));
  await view.settle();
  const composer = view.host.querySelector(COMPOSER);
  assert.equal(composer.value, "and email Dana");
  assert.notEqual(composer.getAttribute("placeholder"), "Answer here…");
  await React.act(async () =>
    composer.dispatchEvent(
      new view.happyWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    )
  );
  assert.deepEqual(results, [], "Enter doesn't answer the question with the command");
  assert.deepEqual(globalThis.__chat.sent, []);

  // Answered on its card, the question goes; once the turn ends the command can be sent.
  const field = view.host.querySelector("[data-interaction-card] input");
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(view.happyWindow.HTMLInputElement.prototype, "value").set.call(
      field,
      "Friday"
    );
    field.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
  });
  await React.act(async () => field.form.requestSubmit());
  await view.settle();
  assert.deepEqual(results, [{ status: "answered", answers: { deadline: "Friday" } }]);
  await view.chat({ busy: false, messages: [user, { ...reply([askUser]), isStreaming: false }] });
  await view.settle();
  await React.act(async () => view.button("Send").click());
  assert.deepEqual(globalThis.__chat.sent, ["and email Dana"]);
});

test("back to the window by focus alone, a key card that came meanwhile takes the keyboard from the empty composer", async (t) => {
  const view = await mountWindow(t);
  const { document } = view.happyWindow;
  document.hasFocus = () => true;
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.settle();
  const composer = view.host.querySelector(COMPOSER);
  assert.ok(document.activeElement === composer, "the empty composer has the caret");
  // The user goes to another app (the caret stays put); the key card arrives meanwhile.
  document.hasFocus = () => false;
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await view.ask("c1", KEY_CARD);
  await view.settle();
  assert.ok(document.activeElement === composer, "nothing moves while the user is away");
  // Back by Alt-Tab: the window gets focus, nothing is clicked.
  document.hasFocus = () => true;
  await React.act(async () => view.happyWindow.dispatchEvent(new view.happyWindow.Event("focus")));
  await view.settle();
  assert.ok(
    document.activeElement === view.host.querySelector(KEY_FIELD),
    "a pasted key lands in the key field"
  );
});

test("Keyboard on a waiting key card puts the keyboard in the key field, not the composer", async (t) => {
  const view = await mountWindow(t);
  const { document } = view.happyWindow;
  document.hasFocus = () => true;
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await view.ask("c1", KEY_CARD);
  await view.settle();
  const type = view.button("Type");
  type.focus();
  await React.act(async () => type.click());
  await view.settle();
  await view.settle();
  assert.equal(view.layout(), "modal");
  assert.ok(document.activeElement === view.host.querySelector(KEY_FIELD), "after the fade too");
});

test("a restored question never takes the keyboard, so Esc still closes the window", async (t) => {
  const view = await mountWindow(t);
  const { document } = view.happyWindow;
  document.hasFocus = () => true;
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  await view.chat({ messages: [user, { ...reply([askUser]), isStreaming: false }] });
  const answered = [];
  await React.act(async () =>
    view.interactions.restoreInteraction(
      { messageId: "a1", toolCallId: "c1", payload: QUESTION },
      (result) => answered.push(result)
    )
  );
  await view.settle();
  const expand = view.button("Expand");
  expand.focus();
  await React.act(async () => expand.click());
  await view.settle();
  assert.equal(view.layout(), "modal");
  const card = view.host.querySelector("[data-interaction-card]");
  assert.ok(card);
  assert.ok(!card.contains(document.activeElement), "no focus in the restored card");
  await React.act(async () => view.happyWindow.dispatchEvent(new view.happyWindow.Event("focus")));
  assert.ok(!card.contains(document.activeElement), "nor when the window gets the keyboard");
  assert.deepEqual(answered, []);
});

test("a card laid out under a resting cursor keeps its timed open", async (t) => {
  const view = await mountWindow(t);
  await askWhileCompact(view);
  const frame = view.host.querySelector("[data-interaction-card]").closest(".agent-chat-scroll");
  // Chromium replays a resting cursor's position after layout, with no movement.
  await pointer(view, frame, "pointerover");
  await pointer(view, frame, "pointermove");
  await view.wait(4300);
  await view.settle();
  assert.equal(view.layout(), "modal", "the timed open still happens");
});

test("moving the pointer over a card above the pill uses up its timed open", async (t) => {
  const view = await mountWindow(t);
  await askWhileCompact(view);
  const frame = view.host.querySelector("[data-interaction-card]").closest(".agent-chat-scroll");
  await pointer(view, frame, "pointermove", { movementX: 4, movementY: 1 });
  await view.wait(4300);
  await view.settle();
  assert.equal(view.layout(), "standalone", "the user pointing at it keeps it above the pill");
  assert.ok(!view.button("Expand").className.includes("agent-expand-cue"));
});

for (const [what, payload, draft] of [
  ["a key card, with a message being written", KEY_CARD, "and also check my cal"],
  ["a text question", TEXT_QUESTION, ""],
  ["a text question, with a message being written", TEXT_QUESTION, "and also check my cal"],
]) {
  test(`back from another app, the field the user clicks on ${what} keeps the keyboard`, async (t) => {
    const view = await mountWindow(t);
    const { document } = view.happyWindow;
    document.hasFocus = () => true;
    await React.act(async () => view.main.handlers.hotkey({ external: false }));
    await view.settle();
    await view.chat({ busy: true, messages: [user, reply([askUser])] });
    await React.act(async () => view.button("Type").click());
    await view.settle();
    const typing = view.host.querySelector("textarea");
    typing.focus();
    if (draft) await setDraft(view, typing, draft);
    // The user goes to another app; the card arrives meanwhile.
    typing.blur();
    document.hasFocus = () => false;
    await view.ask("c1", payload);
    await view.settle();
    // Back, a click into the card's own field.
    const field = view.host.querySelector("[data-interaction-card] input");
    document.hasFocus = () => true;
    await pointer(view, field, "pointerdown");
    field.focus();
    await React.act(async () =>
      view.happyWindow.dispatchEvent(new view.happyWindow.Event("focus"))
    );
    await view.settle();
    await view.settle();
    // Compared by identity: a failed deep-equal of two DOM nodes inspects the whole document.
    assert.ok(document.activeElement === field, "the composer doesn't take it back");
  });
}

test("the modal's composer never takes the keyboard while a restored key card shows", async (t) => {
  const view = await mountWindow(t);
  const { document } = view.happyWindow;
  document.hasFocus = () => true;
  await view.chat({ messages: [user, { ...reply([askUser]), isStreaming: false }] });
  await React.act(async () =>
    view.interactions.restoreInteraction(
      { messageId: "a1", toolCallId: "c1", payload: KEY_CARD },
      () => {}
    )
  );
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.settle();
  assert.ok(view.host.querySelector(KEY_FIELD), "the restored key card shows");
  assert.ok(
    document.activeElement !== view.host.querySelector(COMPOSER),
    "a pasted key can't land in the message"
  );
});

test("a spoken command after a timed open made while away asks for the keyboard again", async (t) => {
  const view = await mountWindow(t);
  const { document } = view.happyWindow;
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([askUser])] });
  await view.ask("c1", QUESTION);
  await view.settle();
  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  document.hasFocus = () => false;
  await view.wait(4300);
  await view.settle();
  assert.equal(view.main.layouts.at(-1).focus, false, "the timed open while away");
  await React.act(async () => view.interactions.cancelInteraction("a1::c1"));
  const done = { ...reply([{ ...askUser, status: "completed" }], "ok"), isStreaming: false };
  await view.chat({ busy: false, messages: [user, done] });
  await view.settle();
  // A wake-word command, whose reply asks a text question.
  await React.act(async () => view.main.handlers.command({ text: "draft a reply" }));
  const asking = {
    id: "a2",
    role: "assistant",
    content: "",
    isStreaming: true,
    toolCalls: [{ id: "c9", name: "ask_user", arguments: "{}", status: "executing" }],
  };
  const second = { id: "u2", role: "user", content: "draft a reply", isStreaming: false };
  await view.chat({ busy: true, messages: [user, done, second, asking] });
  await view.ask("c9", TEXT_QUESTION, "a2");
  await view.settle();
  assert.equal(view.main.layouts.at(-1).focus, true, "the question can be typed into");
});

test("a reply that still claims an action nothing did says it wasn't done", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.chat({
    messages: [
      { id: "u1", role: "user", content: "Email Gabe", isStreaming: false },
      {
        id: "a1",
        role: "assistant",
        content: "I've sent it.",
        isStreaming: false,
        turn: { startedAt: 1, finishedAt: 2, status: "complete", unbackedClaim: true },
      },
    ],
  });
  await view.settle();
  assert.match(
    view.host.textContent,
    /Not actually done: nothing ran for what this reply says it did\./
  );
});

const finished = { ...reply([], "Here is the plan."), isStreaming: false };

test("Close starts a new chat, and a command that arrives after it goes to that chat", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ messages: [user, finished] });

  await React.act(async () => view.button("Close").click());
  assert.equal(globalThis.__chat.newChats, 1);
  await React.act(async () => view.main.handlers.command({ text: "What's next?" }));
  await view.settle();
  assert.deepEqual(globalThis.__chat.sent, ["What's next?"]);
  assert.deepEqual(globalThis.__chat.sentAfterNewChats, [1], "sent in the new chat");
  assert.equal(globalThis.__chat.newChats, 1, "only one new chat");
});

test("Esc on an idle window starts a new chat; over a running reply it only stops the reply", async (t) => {
  const view = await mountWindow(t);
  const escape = () =>
    React.act(async () =>
      view.happyWindow.document.dispatchEvent(
        new view.happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ busy: true, messages: [user, reply([], "Here is")] });
  await escape();
  assert.equal(globalThis.__chat.cancels, 1);
  assert.equal(globalThis.__chat.newChats, 0, "the reply stops, the chat stays");

  await view.chat({ busy: false, messages: [user, finished] });
  await escape();
  await view.settle();
  assert.equal(globalThis.__chat.newChats, 1);
});

test("Esc over selected text clears the selection and keeps the chat", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ busy: false, messages: [user, finished] });
  const { document } = view.happyWindow;
  const selection = view.happyWindow.getSelection();
  selection.selectAllChildren(document.body);
  assert.equal(selection.isCollapsed, false);

  await React.act(async () =>
    document.dispatchEvent(
      new view.happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
  );
  await view.settle();
  assert.equal(globalThis.__chat.newChats, 0, "the chat stays");
  assert.equal(selection.isCollapsed, true);
});

test("main's dismiss starts a new chat; Minimize keeps it", async (t) => {
  const view = await mountWindow(t);
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await view.chat({ messages: [user, finished] });

  await React.act(async () => view.button("Minimize").click());
  await view.settle();
  assert.equal(globalThis.__chat.newChats, 0);

  await React.act(async () => view.main.handlers.dismiss());
  await view.settle();
  assert.equal(globalThis.__chat.newChats, 1);
});

const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const write = async (view, text) => {
  const field = view.host.querySelector("textarea");
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      view.happyWindow.HTMLTextAreaElement.prototype,
      "value"
    ).set.call(field, text);
    field.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
  });
  await React.act(async () => view.button("Send").click());
};
test("late press capture cannot enter the next request", async (t) => {
  const view = await mountWindow(t);
  const settings = await view.vite.ssrLoadModule("/stores/settingsStore.ts");
  settings.useSettingsStore.setState({ voiceAgentScreenContext: true });
  const selection = defer(),
    screen = defer();
  view.happyWindow.electronAPI.captureSelectedText = () => selection.promise;
  let screenCaptures = 0;
  view.happyWindow.electronAPI.captureScreenContext = () =>
    ++screenCaptures === 1 ? screen.promise : Promise.resolve(null);
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await view.wait(20);
  await React.act(async () =>
    globalThis.__voice.callbacks.onTranscript("first unrelated request", "submit")
  );
  await view.wait(3150);
  assert.equal(globalThis.__chat.sent.length, 1);
  assert.equal(globalThis.__chat.sentOptions[0].attachment, undefined);
  await React.act(async () => {
    selection.resolve({ status: "selected", text: "OLD PRIVATE SELECTION" });
    screen.resolve({ data: "OLD_SCREEN_IMAGE", mediaType: "image/jpeg" });
  });
  await React.act(async () => view.main.handlers.open({ layout: "typing" }));
  await view.settle();
  await write(view, "second unrelated request");
  assert.equal(globalThis.__chat.sentOptions[1].selectedContext, undefined);
  assert.equal(globalThis.__chat.sentOptions[1].attachment, undefined);
});

for (const result of ["A fuller introduction.", null]) {
  test(`selected-text voice ${result === null ? "questions stay in chat" : "edits replace the selection"}`, async (t) => {
    const view = await mountWindow(t);
    const replacements = [];
    view.happyWindow.electronAPI.captureSelectedText = async () => ({
      status: "selected",
      sessionId: "selection-1",
      text: "Short introduction.",
      characterCount: 19,
    });
    view.happyWindow.electronAPI.replaceSelectedText = async (...args) => {
      replacements.push(args);
      return { success: true };
    };
    globalThis.__selectionEdits.result = result;
    await React.act(async () => view.main.handlers.hotkey({ external: true }));
    const instruction = result === null ? "What does this mean?" : "Elaborate this introduction";
    await React.act(async () => globalThis.__voice.callbacks.onTranscript(instruction, "submit"));
    if (result === null) {
      assert.deepEqual(replacements, []);
      assert.deepEqual(globalThis.__chat.sent, [instruction]);
      assert.equal(globalThis.__chat.sentOptions[0].selectedContext.text, "Short introduction.");
      assert.equal("sessionId" in globalThis.__chat.sentOptions[0].selectedContext, false);
    } else {
      assert.deepEqual(replacements, [
        ["selection-1", result, { restoreClipboard: true, allowClipboardFallback: false }],
      ]);
      assert.deepEqual(globalThis.__chat.sent, []);
    }
  });
}

test("a changed native selection keeps the replacement available without an unguarded paste", async (t) => {
  const view = await mountWindow(t);
  view.happyWindow.electronAPI.captureSelectedText = async () => ({
    status: "selected",
    sessionId: "stale",
    text: "Original",
  });
  const calls = [];
  view.happyWindow.electronAPI.replaceSelectedText = async (...args) => {
    calls.push(args);
    return { success: false, code: "selection_changed" };
  };
  globalThis.__selectionEdits.result = "Rewritten";
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () => globalThis.__voice.callbacks.onTranscript("Rewrite this", "submit"));
  assert.equal(calls.length, 1);
  assert.deepEqual(globalThis.__chat.sent, []);
  assert.equal(view.host.querySelector("textarea").value, "Rewritten");
  await view.waitForLayout("typing");
});

test("closing during a selection edit aborts it and cannot replace text later", async (t) => {
  const view = await mountWindow(t);
  const edit = defer();
  globalThis.__selectionEdits.result = edit.promise;
  view.happyWindow.electronAPI.captureSelectedText = async () => ({
    status: "selected",
    sessionId: "s1",
    text: "Original",
  });
  const replacements = [];
  view.happyWindow.electronAPI.replaceSelectedText = async (...args) => {
    replacements.push(args);
    return { success: true };
  };
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () => globalThis.__voice.callbacks.onTranscript("Rewrite this", "submit"));
  await React.act(async () => view.main.handlers.dismiss());
  assert.equal(globalThis.__selectionEdits.calls[0].signal.aborted, true);
  await React.act(async () => edit.resolve("Late replacement"));
  assert.deepEqual(replacements, []);
  assert.deepEqual(globalThis.__chat.sent, []);
});

test("closing cancels the captured session while native replacement is still pending", async (t) => {
  const view = await mountWindow(t);
  const replacement = defer();
  const cancelled = [];
  globalThis.__selectionEdits.result = "Edited";
  view.happyWindow.electronAPI.captureSelectedText = async () => ({
    status: "selected",
    sessionId: "pending-native",
    text: "Original",
  });
  view.happyWindow.electronAPI.replaceSelectedText = () => replacement.promise;
  view.happyWindow.electronAPI.cancelSelectionEdit = async (sessionId) => cancelled.push(sessionId);
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () => globalThis.__voice.callbacks.onTranscript("Rewrite this", "submit"));
  await React.act(async () => view.main.handlers.dismiss());
  assert.deepEqual(cancelled, ["pending-native"]);
  await React.act(async () => replacement.resolve({ success: false, code: "cancelled" }));
  assert.deepEqual(globalThis.__chat.sent, []);
});

test("composer Stop cancels a selection edit after switching to the keyboard", async (t) => {
  const view = await mountWindow(t);
  const edit = defer();
  globalThis.__selectionEdits.result = edit.promise;
  view.happyWindow.electronAPI.captureSelectedText = async () => ({
    status: "selected",
    sessionId: "s1",
    text: "Original",
  });
  const replacements = [];
  view.happyWindow.electronAPI.replaceSelectedText = async (...args) => {
    replacements.push(args);
    return { success: true };
  };
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () => globalThis.__voice.callbacks.onTranscript("Rewrite this", "submit"));
  await React.act(async () => view.button("Type").click());
  await view.settle();
  await React.act(async () => view.button("Stop").click());
  const aborted = globalThis.__selectionEdits.calls[0].signal.aborted;
  await React.act(async () => edit.resolve("Late replacement"));
  assert.equal(aborted, true);
  assert.deepEqual(replacements, []);
  assert.equal(globalThis.__chat.cancels, 0, "only the selection edit is cancelled");
});

for (const verb of ["email", "slackPost"]) {
  for (const stale of [false, true]) {
    test(`voice edits a selected ${verb} card line${stale ? " only while its draft is unchanged" : " without sending it"}`, async (t) => {
      const view = await mountWindow(t);
      await React.act(async () => view.main.handlers.open({ layout: "modal" }));
      await view.chat({ busy: true, messages: [user, reply([slackCall])] });
      await view.askApproval("c5");
      const key = "a1::c5";
      if (verb === "email") {
        await React.act(async () =>
          view.approvals.useConnectorApprovalStore.setState(({ entries }) => ({
            entries: {
              ...entries,
              [key]: {
                ...entries[key],
                preview: { ...entries[key].preview, verbKey: "email" },
                draft: {
                  ...entries[key].draft,
                  fields: {
                    to: ["qa@example.test"],
                    cc: [],
                    subject: "Draft",
                    body: SLACK_PREVIEW.body,
                  },
                },
              },
            },
          }))
        );
      }
      await view.settle();
      const field = view.host.querySelector("[data-approval-card] textarea");
      field.focus();
      field.setSelectionRange(4, 12); // homepage
      const edit = defer();
      globalThis.__selectionEdits.result = edit.promise;
      globalThis.__voice.events.length = 0;
      await React.act(async () => view.main.handlers.hotkey({ external: false }));
      assert.ok(
        globalThis.__voice.events.includes("start"),
        "the approval wait allows this selected field's take"
      );
      await React.act(async () =>
        globalThis.__voice.callbacks.onTranscript("Change it to landing page", "submit")
      );
      assert.equal(globalThis.__selectionEdits.calls[0].selectedText, "homepage");
      assert.equal(
        globalThis.__selectionEdits.calls[0].appCategory,
        verb === "email" ? "email" : "work"
      );
      if (stale)
        await React.act(async () =>
          view.approvals.updateApprovalDraft(
            key,
            verb === "email"
              ? { fields: { body: "Newer typed draft" } }
              : { body: "Newer typed draft" }
          )
        );
      await React.act(async () => edit.resolve("landing page"));
      const entry = view.approvals.useConnectorApprovalStore.getState().entries[key];
      assert.equal(
        entry.draft.fields?.body ?? entry.draft.body,
        stale ? "Newer typed draft" : "The landing page draft is ready."
      );
      assert.equal(entry.state, "pending");
      assert.equal(entry.actionId, "act-1");
      assert.deepEqual(globalThis.__chat.sent, []);
      assert.equal(globalThis.__chat.cancels, 0);
      await view.settle();
    });
  }
}

test("each assistant request gets a fresh screenshot, including a spoken follow-up inside the window", async (t) => {
  const view = await mountWindow(t);
  const settings = await view.vite.ssrLoadModule("/stores/settingsStore.ts");
  settings.useSettingsStore.setState({ voiceAgentScreenContext: true });
  let captures = 0;
  view.happyWindow.electronAPI.captureScreenContext = async () => ({
    data: `screen-${++captures}`,
    mediaType: "image/jpeg",
  });
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await React.act(async () =>
    globalThis.__voice.callbacks.onTranscript("Translate this email", "submit")
  );
  assert.equal(globalThis.__chat.sentOptions[0].attachment?.image, "screen-1");
  await React.act(async () => view.main.handlers.open({ layout: "typing" }));
  await view.settle();
  await write(view, "What else is on screen?");
  assert.equal(globalThis.__chat.sentOptions[1].attachment?.image, "screen-2");
});
test("New chat drops the previous press capture", async (t) => {
  const view = await mountWindow(t);
  const selection = defer();
  view.happyWindow.electronAPI.captureSelectedText = () => selection.promise;
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await React.act(async () => view.button("New chat").click());
  await React.act(async () =>
    selection.resolve({ status: "selected", text: "PREVIOUS CHAT CONTEXT" })
  );
  await write(view, "new chat request");
  assert.equal(globalThis.__chat.newChats, 1);
  assert.equal(globalThis.__chat.sentOptions[0].selectedContext, undefined);
});

test("an account boundary drops a transcript already waiting on press capture", async (t) => {
  const view = await mountWindow(t);
  const selection = defer();
  view.happyWindow.electronAPI.captureSelectedText = () => selection.promise;
  const auth = await view.vite.ssrLoadModule("/lib/authRequestContext.ts");
  await React.act(async () => auth.observeAuthTokenStateEvent({ generation: 1, hasToken: true }));
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () =>
    globalThis.__voice.callbacks.onTranscript("previous account task", "submit")
  );
  await React.act(async () => {
    auth.observeAuthTokenStateEvent({ generation: 2, hasToken: true });
    selection.resolve({ status: "selected", text: "previous account selection" });
  });
  assert.deepEqual(globalThis.__chat.sent, []);
});

test("an unsuccessful agent fork leaves the current take intact", async (t) => {
  const view = await mountWindow(t);
  await view.chat({
    messages: [
      { id: "saved", dbId: 1, role: "assistant", content: "Saved reply", isStreaming: false },
    ],
  });
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.settle();
  await React.act(async () => globalThis.__voice.set("recording"));
  const cancelled = globalThis.__voice.cancels;
  await React.act(async () => view.button("Fork").click());
  assert.equal(globalThis.__voice.cancels, cancelled);
});

test("a delayed transcript cannot edit the next take's selected text", async (t) => {
  const view = await mountWindow(t);
  const first = defer();
  let captures = 0;
  view.happyWindow.electronAPI.captureSelectedText = () =>
    ++captures === 1
      ? first.promise
      : Promise.resolve({
          status: "selected",
          sessionId: "new-session",
          text: "NEW SELECTED TEXT",
        });
  const replacements = [];
  view.happyWindow.electronAPI.replaceSelectedText = async (...args) => {
    replacements.push(args);
    return { success: true };
  };
  globalThis.__selectionEdits.result = "REPLACEMENT FROM OLD INSTRUCTION";
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () =>
    globalThis.__voice.callbacks.onTranscript("OLD INSTRUCTION", "submit")
  );
  await React.act(async () => view.main.handlers.hotkey({ external: true }));
  await React.act(async () => first.resolve({ status: "none" }));
  assert.deepEqual(
    replacements,
    [],
    "a first transcript must not replace a second capture's session"
  );
  globalThis.__selectionEdits.result = "Replacement from the new instruction";
  await React.act(async () =>
    globalThis.__voice.callbacks.onTranscript("NEW INSTRUCTION", "submit")
  );
  assert.equal(globalThis.__selectionEdits.calls.at(-1).selectedText, "NEW SELECTED TEXT");
  assert.equal(replacements.at(-1)[0], "new-session");
  assert.equal(replacements.at(-1)[1], "Replacement from the new instruction");
});
test("a typed request awaiting a screenshot stays available if a voice take supersedes it", async (t) => {
  const view = await mountWindow(t);
  const settings = await view.vite.ssrLoadModule("/stores/settingsStore.ts");
  settings.useSettingsStore.setState({ voiceAgentScreenContext: true });
  const screen = defer();
  let captures = 0;
  view.happyWindow.electronAPI.captureScreenContext = () =>
    ++captures === 1 ? screen.promise : Promise.resolve(null);
  await React.act(async () => view.main.handlers.open({ layout: "typing" }));
  await view.settle();
  const field = view.host.querySelector("textarea");
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      view.happyWindow.HTMLTextAreaElement.prototype,
      "value"
    ).set.call(field, "Original typed request");
    field.dispatchEvent(new view.happyWindow.Event("input", { bubbles: true }));
  });
  await React.act(async () => view.button("Send").click());
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await React.act(async () => screen.resolve({ data: "typed-screen", mediaType: "image/jpeg" }));
  await React.act(async () => view.main.handlers.open({ layout: "typing" }));
  await view.settle();
  assert.ok(
    globalThis.__chat.sent.includes("Original typed request") ||
      view.host.querySelector("textarea")?.value === "Original typed request",
    "the first request must be sent or restored"
  );
});

test("a newer follow-up selection survives an older send awaiting its screenshot", async (t) => {
  const view = await mountWindow(t);
  const settings = await view.vite.ssrLoadModule("/stores/settingsStore.ts");
  await React.act(async () =>
    settings.useSettingsStore.setState({ voiceAgentScreenContext: true })
  );
  const screen = defer();
  view.happyWindow.electronAPI.captureScreenContext = () => screen.promise;
  await React.act(async () => view.main.handlers.open({ layout: "modal" }));
  await view.chat({
    messages: [
      { id: "answer", role: "assistant", content: "New follow-up context.", isStreaming: false },
    ],
  });
  await view.settle();
  await setDraft(view, view.host.querySelector(COMPOSER), "Initial typed request");
  await React.act(async () => view.button("Send").click());
  const range = view.happyWindow.document.createRange();
  range.selectNodeContents(view.host.querySelector("[data-agent-answer]"));
  view.happyWindow.getSelection().addRange(range);
  await React.act(async () =>
    view.happyWindow.document.dispatchEvent(
      new view.happyWindow.MouseEvent("mouseup", { bubbles: true })
    )
  );
  await React.act(async () => view.host.querySelector('[role="toolbar"] button').click());
  const hasContext = () =>
    [...view.host.querySelectorAll("button")].some((button) =>
      /remove.*context/i.test(button.getAttribute("aria-label") ?? "")
    );
  assert.equal(hasContext(), true);
  await React.act(async () => screen.resolve({ data: "screen", mediaType: "image/jpeg" }));
  assert.equal(hasContext(), true, "the older send must not consume the newer context");
  assert.equal(globalThis.__chat.sentOptions[0].selectedContext, undefined);
  await setDraft(view, view.host.querySelector(COMPOSER), "Explain this selected part");
  await React.act(async () => view.button("Send").click());
  assert.equal(globalThis.__chat.sentOptions.at(-1).selectedContext.text, "New follow-up context.");
});
