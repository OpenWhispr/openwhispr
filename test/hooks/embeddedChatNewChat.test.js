const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// Persistence keeps its messages in state, as the real hook does, and the stream records
// the history each send hands the model.
const MOCKS = {
  "/chat/useChatStreaming": `
    export function useChatStreaming() {
      return {
        agentState: "idle",
        sendToAI: async (text, history) => {
          globalThis.__sent.push(history.map((message) => message.content));
        },
        cancelStream() {},
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
        createConversation: async (title) => {
          if (globalThis.__failCreate) throw new Error("offline");
          globalThis.__created.push(title);
          return 2;
        },
        saveUserMessage: async () => {},
        saveAssistantMessage() {},
        loadConversation: async () =>
          setMessages([{ id: "m0", role: "user", content: "Earlier question", isStreaming: false }]),
        handleNewChat: () => setMessages([]),
      };
    }
  `,
};

test("a message sent into a new chat leaves the open conversation behind", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__sent;
    delete globalThis.__created;
  });
  globalThis.__sent = [];
  globalThis.__created = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getConversationsForNote: async () => [{ id: 1, title: "Earlier", updated_at: "" }],
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-embedded-chat-new-chat-test-",
    mockModules: MOCKS,
  });
  const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
  let chat;
  function Harness() {
    chat = useEmbeddedChat({ noteId: 5, folderId: null, noteTitle: "Kickoff", noteContent: "" });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(chat.activeConversationId, null, "the note opens on a new conversation");

  await React.act(async () => chat.switchConversation(1));
  assert.equal(chat.activeConversationId, 1);

  await React.act(async () => chat.sendMessage("Follow-up"));
  assert.deepEqual(globalThis.__sent, [["Earlier question", "Follow-up"]]);
  assert.deepEqual(globalThis.__created, [], "a plain send continues it");

  await React.act(async () => chat.sendInNewChat("New question"));
  assert.deepEqual(
    globalThis.__sent.at(-1),
    ["New question"],
    "no earlier messages reach the model"
  );
  assert.deepEqual(
    globalThis.__created,
    ["New question · Kickoff"],
    "and the message starts a conversation of its own, named after it and the note"
  );
});

test("a question that could not start a new chat goes back to the caller as a draft", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__sent;
    delete globalThis.__created;
    delete globalThis.__failCreate;
  });
  globalThis.__sent = [];
  globalThis.__created = [];
  globalThis.__failCreate = true;
  installBrowserGlobals(t, {
    window: { electronAPI: { getConversationsForNote: async () => [] } },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-embedded-chat-unsent-test-",
    mockModules: MOCKS,
  });
  const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
  const unsent = [];
  let chat;
  function Harness() {
    chat = useEmbeddedChat({
      noteId: 5,
      folderId: null,
      noteTitle: "Kickoff",
      noteContent: "",
      onNewChatUnsent: (text) => unsent.push(text),
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  await React.act(async () => chat.sendInNewChat("Will this go?"));
  assert.deepEqual(unsent, ["Will this go?"]);
  assert.deepEqual(globalThis.__sent, [], "nothing reached the model");
});
