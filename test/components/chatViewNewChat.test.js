const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { setupChatTurns, deferred, until } = require("../lib/chatTurnHarness");

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
