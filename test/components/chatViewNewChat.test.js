const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { setupChatTurns, deferred, until } = require("../lib/chatTurnHarness");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MOCKS = {
  "/ui/useToast": `export const useToast = () => ({ toast: (toast) => (globalThis.__toasts ??= []).push(toast) });`,
  "/ChatInput": `import { createElement } from "react"; export function ChatInput(props) { globalThis.__chatInput = props; return createElement("textarea"); }`,
  "/ConversationList": `export default function ConversationList(props) { globalThis.__conversationList = props; return null; }`,
  "/ChatMessages": `export function ChatMessages(props) { globalThis.__chatMessages = props; return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; } export function AlertDialog() { return null; }`,
};
async function renderChatView(t, electronAPI = {}) {
  t.after(() => {
    delete globalThis.__toasts;
    delete globalThis.__chatMessages;
  });
  const fixture = await setupChatTurns(t, electronAPI, MOCKS);
  globalThis.window.addEventListener = (type, listener) => {
    if (type === "keydown")
      globalThis.__keydown = (init) => listener({ preventDefault() {}, ...init });
  };
  const container = installInteractiveDom(t);
  const { default: ChatView } = await fixture.vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const root = createRoot(container);
  fixture.unmounts.push(async () => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(ChatView)));
  return fixture;
}
for (const [leave, leaveConversation] of Object.entries({
  "New chat": (list) => list.onNewChat(),
  "switching conversation": (list) => list.onSelectConversation(7),
})) {
  test(`${leave} leaves the reply running and frees the new composer immediately`, async (t) => {
    const fixture = await renderChatView(t);
    await React.act(async () => {
      globalThis.__chatInput.onTextSubmit("Search the web for flights");
      await until(() => fixture.streams.length === 1);
    });
    await React.act(async () => leaveConversation(globalThis.__conversationList));
    assert.equal(fixture.streams[0].signal.aborted, false);
    assert.equal(globalThis.__chatInput.agentState, "idle");
    await React.act(async () => {
      globalThis.__chatInput.onTextSubmit("Second question");
      await until(() => fixture.streams.length === 2);
    });
    assert.equal(fixture.streams[0].signal.aborted, false);
  });
}
test("a follow-up after reopening a deleted conversation starts a new one", async (t) => {
  const fixture = await renderChatView(t, {
    getAgentConversation: async (id) => (id === 7 ? null : { id, messages: [] }),
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  await React.act(async () => {
    globalThis.__chatInput.onTextSubmit("A follow-up");
    await until(() => fixture.streams.length === 1);
  });
  assert.equal(fixture.rows.size, 1);
});
for (const [way, startNewChat] of Object.entries({
  "the New chat button": () => globalThis.__conversationList.onNewChat(),
  "the shortcut": () => globalThis.__keydown({ key: "n", metaKey: true, ctrlKey: true }),
})) {
  test(`starting a new chat with ${way} puts the cursor in the composer`, async (t) => {
    await renderChatView(t);
    assert.equal(globalThis.document.activeElement, null);
    await React.act(async () => startNewChat());
    assert.equal(globalThis.document.activeElement?.tagName, "TEXTAREA");
  });
}
test("a fork made from selected text sends it with its first request only", async (t) => {
  const fixture = await renderChatView(t, {
    getAgentConversation: async (id) => ({
      id,
      title: "Plan",
      parent_conversation_id: 3,
      parent_title: "Plan",
      fork_context: " Draft one. ",
      messages: [],
    }),
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(30));
  for (const [index, text] of ["Shorter", "Again"].entries()) {
    await React.act(async () => {
      globalThis.__chatInput.onTextSubmit(text);
      await until(() => fixture.streams.length === index + 1);
    });
    await React.act(async () => {
      fixture.streams[index].resolve("Done");
      await until(() => !fixture.state().entries["conversation:30"]);
    });
  }

  const quoted = (stream) => JSON.stringify(stream.messages).split("Draft one.").length - 1;
  assert.deepEqual(
    fixture.streams.map(quoted),
    [1, 1],
    "the second request quotes it from history"
  );
  assert.deepEqual(
    fixture.writes
      .filter((write) => write.role === "user")
      .map((write) => write.metadata?.selectedContext),
    ["Draft one.", undefined],
    "the user message keeps the text it was about"
  );
});

test("a fork the user left for another chat first shows no error", async (t) => {
  const forks = [];
  await renderChatView(t, {
    getAgentConversation: async (id) => ({
      id,
      title: `Chat ${id}`,
      messages:
        id === 7
          ? [{ id: 5, conversation_id: 7, role: "assistant", content: "Draft", created_at: "" }]
          : [],
    }),
    forkAgentConversation: (...args) => {
      const fork = deferred();
      forks.push({ args, ...fork });
      return fork.promise;
    },
  });
  const forkFirstReply = async (result, beforeResult = async () => {}) => {
    await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
    let forking;
    await React.act(async () => {
      forking = globalThis.__chatMessages.onForkMessage(globalThis.__chatMessages.messages[0].id);
    });
    await beforeResult();
    await React.act(async () => {
      forks.at(-1).resolve(result);
      await forking;
    });
  };

  await forkFirstReply({ id: 40, title: "Chat 7", messages: [] }, () =>
    React.act(async () => globalThis.__conversationList.onSelectConversation(8))
  );
  assert.deepEqual(forks[0].args, [7, 5, null]);
  assert.equal(globalThis.__toasts, undefined);
  assert.equal(globalThis.__conversationList.activeConversationId, 8, "nothing opens");

  await forkFirstReply(null);
  assert.equal(globalThis.__toasts.length, 1);

  await forkFirstReply({ id: 41, title: "Chat 7", messages: [] });
  assert.equal(globalThis.__conversationList.activeConversationId, 41, "the fork opens");
});

test("a reply sent in this chat can be forked", async (t) => {
  const forks = [];
  const fixture = await renderChatView(t, {
    forkAgentConversation: async (...args) => {
      forks.push(args);
      return { id: 40, title: "Chat 7", messages: [] };
    },
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  await React.act(async () => {
    globalThis.__chatInput.onTextSubmit("Draft a plan");
    await until(() => fixture.streams.length === 1);
  });
  await React.act(async () => {
    fixture.streams[0].resolve("Plan");
    await until(() => !fixture.state().entries["conversation:7"]);
  });
  const { messages } = globalThis.__chatMessages;
  assert.deepEqual(
    messages.map((message) => message.dbId),
    [1, 2],
    "both messages carry their saved rows"
  );
  await React.act(async () => globalThis.__chatMessages.onForkMessage(messages[1].id));
  assert.deepEqual(forks, [[7, 2, null]]);
});

test("Chat is marked while one of its turns waits on the user, and only then", async (t) => {
  const fixture = await setupChatTurns(t);
  const container = installInteractiveDom(t);
  const { useChatNeedsAttention } = await fixture.vite.ssrLoadModule(
    "/components/chat/useChatNeedsAttention.ts"
  );
  const interactions = await fixture.vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  const approvals = await fixture.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const attention = [];
  function Probe() {
    attention.push(useChatNeedsAttention());
    return null;
  }
  const root = createRoot(container);
  fixture.unmounts.push(async () => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(Probe)));
  // A turn of the main chat runs in the background, its reply holding a card.
  const entry = {
    submissionId: "s1",
    conversationId: 1,
    running: true,
    settling: false,
    messages: [{ id: "chat-reply", role: "assistant", content: "", toolCalls: [{ id: "card" }] }],
  };
  await React.act(async () =>
    fixture.store.useChatTurnStore.setState({ entries: { "conversation:1": entry } })
  );
  const context = (messageId) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    return { messageId, toolCallId: "card", signal: controller.signal, onInteraction() {} };
  };
  const payload = {
    kind: "questions",
    questions: [{ id: "city", kind: "text", prompt: "Which city?" }],
  };
  const elsewhere = interactions.requestInteraction(context("note-reply"), payload);
  assert.equal(attention.at(-1), false, "a card in another chat isn't this one's");
  let question;
  await React.act(async () => {
    question = interactions.requestInteraction(context("chat-reply"), payload);
  });
  assert.equal(attention.at(-1), true);
  await React.act(async () => interactions.cancelInteraction("chat-reply::card"));
  await question;
  assert.equal(attention.at(-1), false);
  globalThis.window.electronAPI.connectorCommit = async () => ({ state: "sent" });
  let approval;
  await React.act(async () => {
    approval = approvals.requestApproval(
      context("chat-reply"),
      {
        actionId: "action",
        connectorId: "slack",
        preview: { destinationLabel: "#eng", body: "Hello" },
      },
      async () => undefined
    );
  });
  assert.equal(attention.at(-1), true);
  await React.act(async () =>
    fixture.store.useChatTurnStore.setState({
      entries: { "conversation:1": { ...entry, running: false } },
    })
  );
  assert.equal(attention.at(-1), false, "a turn that ended waits on nothing");
  await React.act(async () => approvals.approveAction("chat-reply::card"));
  await approval;
  interactions.cancelInteraction("note-reply::card");
  await elsewhere;
});

test("Chat navigation exposes the localized waiting marker", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    mockModules: {
      "/WorkspaceSwitcher": "export default function WorkspaceSwitcher() { return null; }",
      "/ui/SupportDropdown": "export default function SupportDropdown() { return null; }",
      "/controlPanelNav": `
        export const useControlPanelNavItems = () => [
          { id: "chat", label: "Chat", icon: () => null }
        ];
      `,
    },
  });
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const { default: Sidebar } = await vite.ssrLoadModule("/components/ControlPanelSidebar.tsx");
  const { renderToStaticMarkup } = require("react-dom/server");
  const render = (chatNeedsAttention) =>
    renderToStaticMarkup(
      React.createElement(Sidebar, { activeView: "home", upsell: "hide", chatNeedsAttention })
    );
  assert.match(render(true), /role="status" aria-label="Waiting for answer"/);
  assert.doesNotMatch(render(false), /role="status"/);
});

// Another window (the agent window, a note's chat) runs the conversation or holds its question.
const busyElsewhere = (claims) => async (id, ownerId) => {
  claims.push(ownerId);
  return { owned: claims.length === 1, conversation: { id, title: `Chat ${id}`, messages: [] } };
};

test("a peer refusal keeps the submitted draft and explains that nothing was sent", async (t) => {
  const claims = [];
  const fixture = await renderChatView(t, { claimAgentConversation: busyElsewhere(claims) });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  await React.act(async () => globalThis.__chatInput.onTextSubmit("Keep this question"));
  assert.equal(claims.length, 2, "the open, then the send");
  assert.equal(globalThis.__chatInput.draftText, "Keep this question");
  assert.match(globalThis.__toasts.at(-1).title, /message wasn't sent/);
  assert.equal(fixture.streams.length, 0);
  assert.deepEqual(fixture.writes, [], "nothing is saved");
});

for (const replacement of ["new draft", "new chat"]) {
  test(`a late peer refusal does not overwrite a ${replacement}`, async (t) => {
    const refusal = deferred();
    let claims = 0;
    await renderChatView(t, {
      claimAgentConversation: async (id) => {
        claims += 1;
        if (claims > 1) await refusal.promise;
        return { owned: claims === 1, conversation: { id, title: "Chat", messages: [] } };
      },
    });
    await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
    let sending;
    await React.act(async () => {
      sending = globalThis.__chatInput.onTextSubmit("Old question");
    });
    if (replacement === "new chat")
      await React.act(async () => globalThis.__conversationList.onNewChat());
    await React.act(async () => globalThis.__chatInput.onDraftChange("Newer question"));
    await React.act(async () => {
      refusal.resolve();
      await sending;
    });
    // The question that wasn't sent goes back after what the user typed since, as the
    // store returns any question; a new chat keeps its own draft.
    assert.equal(
      globalThis.__chatInput.draftText,
      replacement === "new chat" ? "Newer question" : "Newer question\n\nOld question"
    );
  });
}

test("a conversation another window holds opens as saved and reloads once it lets go", async (t) => {
  let released;
  const saved = (content) => ({
    id: 7,
    title: "Chat 7",
    messages: [{ id: 3, conversation_id: 7, role: "assistant", content, created_at: "" }],
  });
  let owner = "agent-window";
  let row = saved("Working on it");
  await renderChatView(t, {
    claimAgentConversation: async () => ({ owned: owner === null, conversation: row }),
    onAgentConversationReleased: (callback) => {
      released = callback;
      return () => {};
    },
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  assert.equal(globalThis.__chatMessages.messages[0].content, "Working on it");
  const shownId = globalThis.__chatMessages.messages[0].id;
  owner = null;
  row = saved("Done");
  await React.act(async () => released({ conversationId: 7 }));
  await until(() => globalThis.__chatMessages.messages[0]?.content === "Done");
  assert.equal(globalThis.__chatMessages.messages[0].id, shownId, "a card keeps its message id");
});

test("a fork leaves the running parent running, whether it opens or fails", async (t) => {
  let forkResult = null;
  const fixture = await renderChatView(t, {
    getAgentConversation: async (id) => ({
      id,
      title: `Chat ${id}`,
      messages:
        id === 7
          ? [{ id: 5, conversation_id: 7, role: "assistant", content: "Draft", created_at: "" }]
          : [],
    }),
    forkAgentConversation: async () => forkResult,
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  const savedReply = globalThis.__chatMessages.messages[0].id;
  await React.act(async () => {
    globalThis.__chatInput.onTextSubmit("Shorter");
    await until(() => fixture.streams.length === 1);
  });
  await React.act(async () => globalThis.__chatMessages.onForkMessage(savedReply));
  assert.equal(globalThis.__toasts.length, 1, "a failed fork says so");
  assert.equal(globalThis.__conversationList.activeConversationId, 7);
  forkResult = { id: 40, title: "Chat 7", messages: [] };
  await React.act(async () => globalThis.__chatMessages.onForkMessage(savedReply));
  assert.equal(globalThis.__conversationList.activeConversationId, 40);
  assert.equal(fixture.streams[0].signal.aborted, false);
});

test("a deleted chat picked from the list leaves the open one, and its turn, in place", async (t) => {
  const fixture = await renderChatView(t, {
    getAgentConversation: async (id) => (id === 7 ? null : { id, title: "Chat", messages: [] }),
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(8));
  await React.act(async () => {
    globalThis.__chatInput.onTextSubmit("Plan the trip");
    await until(() => fixture.streams.length === 1);
  });
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  assert.equal(globalThis.__conversationList.activeConversationId, 8);
  assert.match(globalThis.__toasts.at(-1).title, /no longer available/);
  assert.equal(fixture.streams[0].signal.aborted, false);
});
