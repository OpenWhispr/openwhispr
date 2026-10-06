const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// The streaming hook reads idle throughout, as it does right after Stop, while
// sendToAI stays pending, as a cancelled turn does until its in-flight tool returns.
const MOCKS = {
  "/chat/useChatStreaming": `
    export function useChatStreaming() {
      return {
        agentState: "idle",
        sendToAI: () => new Promise((resolve) => { globalThis.__finishSend = resolve; }),
        cancelStream() {},
      };
    }
  `,
  "/chat/useChatPersistence": `
    export function useChatPersistence() {
      return {
        messages: [],
        setMessages() {},
        createConversation: async () => 1,
        saveUserMessage: async () => {},
        saveAssistantMessage() {},
        loadConversation: async () => {},
        handleNewChat() {},
      };
    }
  `,
};

test("a note chat reads busy until a cancelled send lets go of the send lock", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__finishSend;
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-embedded-chat-send-lock-test-",
    mockModules: MOCKS,
  });
  const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
  let chat;
  function Harness() {
    chat = useEmbeddedChat({ noteId: null, folderId: null, noteTitle: "", noteContent: "" });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(chat.agentState, "idle");

  let firstSend;
  await React.act(async () => {
    firstSend = chat.sendMessage("What did we decide?");
  });
  // A question sent now would be refused by the lock, so the composer and the
  // quick actions must treat the chat as busy and keep it.
  assert.notEqual(chat.agentState, "idle");

  await React.act(async () => {
    globalThis.__finishSend();
    await firstSend;
  });
  assert.equal(chat.agentState, "idle");
});
