const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const SAVED = { id: "saved", role: "user", content: "Saved question", isStreaming: false };
const MOCKS = {
  "/chat/useChatStreaming": `
    export function useChatStreaming() {
      return {
        agentState: "idle",
        sendToAI: async (text) => { globalThis.__sent.push(text); },
        cancelStream() { globalThis.__cancelled += 1; },
      };
    }
  `,
  "/chat/useChatPersistence": `
    import { useState } from "react";
    export function useChatPersistence() {
      const [messages, setMessages] = useState([]);
      return {
        messages,
        setMessages,
        createConversation: async () => 2,
        saveUserMessage: async () => {},
        saveAssistantMessage() {},
        loadConversation: async () => { setMessages(globalThis.__saved); return true; },
        handleNewChat: () => setMessages([]),
      };
    }
  `,
};

async function setup(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__sent;
    delete globalThis.__saved;
    delete globalThis.__cancelled;
  });
  globalThis.__sent = [];
  globalThis.__saved = [SAVED];
  globalThis.__cancelled = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { getConversationsForNote: async () => [] } },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-embedded-chat-main-turn-test-",
    mockModules: MOCKS,
  });
  const store = await vite.ssrLoadModule("/stores/chatTurnStore.ts");
  const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
  let chat;
  function Harness() {
    chat = useEmbeddedChat({ noteId: 5, folderId: null, noteTitle: "Kickoff", noteContent: "" });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return { store, chat: () => chat };
}

const liveEntry = (overrides = {}) => ({
  submissionId: "s1",
  conversationId: 1,
  accountGeneration: 0,
  messages: [
    SAVED,
    { id: "a1", role: "assistant", content: "Streaming from Chat", isStreaming: true },
  ],
  agentState: "streaming",
  toolStatus: "",
  activeToolName: "",
  running: true,
  settling: false,
  skills: { attached: null, pickOff: false, removed: [] },
  ...overrides,
});

test("a conversation answering in Chat shows live here and can't start a second turn", async (t) => {
  const { store, chat } = await setup(t);
  store.useChatTurnStore.setState({ entries: { "conversation:1": liveEntry() } });
  await React.act(async () => chat().switchConversation(1));
  assert.equal(chat().messages.at(-1).content, "Streaming from Chat");
  assert.equal(chat().agentState, "streaming");
  await React.act(async () => chat().sendMessage("second turn"));
  assert.deepEqual(globalThis.__sent, []);
});

test("when Chat's turn ends here the chat keeps its messages and the store lets go", async (t) => {
  const { store, chat } = await setup(t);
  store.useChatTurnStore.setState({ entries: { "conversation:1": liveEntry() } });
  await React.act(async () => chat().switchConversation(1));
  const finished = liveEntry({
    running: false,
    agentState: "idle",
    messages: [SAVED, { id: "a1", role: "assistant", content: "Final answer", isStreaming: false }],
  });
  await React.act(async () =>
    store.useChatTurnStore.setState({ entries: { "conversation:1": finished } })
  );
  assert.equal(chat().messages.at(-1).id, "a1");
  assert.equal(chat().messages.at(-1).content, "Final answer");
  assert.equal(chat().agentState, "idle");
  assert.equal(store.useChatTurnStore.getState().entries["conversation:1"], undefined);
  await React.act(async () => chat().sendMessage("follow-up"));
  assert.deepEqual(globalThis.__sent, ["follow-up"]);
});

test("opening a finished, unseen conversation takes its outcome, so Chat can't hide later writes", async (t) => {
  const { store, chat } = await setup(t);
  const error = { technicalDetails: "401" };
  const finished = liveEntry({
    running: false,
    agentState: "idle",
    messages: [
      SAVED,
      { id: "e1", role: "assistant", content: "Error: boom", isStreaming: false, error },
    ],
  });
  store.useChatTurnStore.setState({ entries: { "conversation:1": finished } });
  await React.act(async () => chat().switchConversation(1));
  assert.equal(chat().messages.at(-1).content, "Error: boom");
  assert.equal(store.useChatTurnStore.getState().entries["conversation:1"], undefined);
});

test("Stop here stops Chat's turn, and only that turn's chat reads busy while it settles", async (t) => {
  const { store, chat } = await setup(t);
  store.useChatTurnStore.setState({
    entries: { "conversation:1": liveEntry(), "conversation:9": liveEntry({ conversationId: 9 }) },
  });
  await React.act(async () => chat().switchConversation(1));
  const ownCancels = globalThis.__cancelled;
  await React.act(async () => chat().cancelStream());
  assert.equal(globalThis.__cancelled, ownCancels, "this chat's own stream isn't the one running");
  const entries = store.useChatTurnStore.getState().entries;
  assert.equal(entries["conversation:1"]?.running ?? false, false);
  assert.equal(entries["conversation:9"].running, true);
});

test("a New chat from here doesn't stop the turn in Chat", async (t) => {
  const { store, chat } = await setup(t);
  store.useChatTurnStore.setState({ entries: { "conversation:1": liveEntry() } });
  await React.act(async () => chat().switchConversation(1));
  await React.act(async () => chat().startNewChat());
  assert.equal(store.useChatTurnStore.getState().entries["conversation:1"].running, true);
  assert.equal(chat().messages.length, 0);
  assert.equal(chat().agentState, "idle");
});
