const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The streaming hook reads idle throughout, as it does right after Stop, while
// sendToAI stays pending, as a cancelled turn does until its in-flight tool returns.
// Every call that matters to ordering lands in globalThis.__calls.
const MOCKS = {
  "/chat/useChatStreaming": `
    export function useChatStreaming() {
      return {
        agentState: "idle",
        sendToAI: () => new Promise((resolve) => { globalThis.__finishSend = resolve; }),
        cancelStream() { globalThis.__calls.push("cancel"); },
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
        loadConversation: async (id) => { globalThis.__calls.push("load:" + id); },
        handleNewChat() { globalThis.__calls.push("new"); },
      };
    }
  `,
};

async function renderContainerChat(t) {
  let root;
  globalThis.__calls = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__finishSend;
    delete globalThis.__calls;
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-container-chat-test-",
    mockModules: MOCKS,
  });
  const { useContainerChat } = await vite.ssrLoadModule("/hooks/useContainerChat.ts");
  const space = { id: 7, name: "Research" };
  const notes = [];
  const handle = { current: null };
  function Harness() {
    handle.current = useContainerChat({ space, folder: null, notes });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return handle;
}

test("switching container conversations cancels the running reply before loading the next", async (t) => {
  const chat = await renderContainerChat(t);

  await React.act(async () => {
    await chat.current.switchConversation(42);
  });

  // A reply still streaming would otherwise save into conversation 42 when it settles.
  assert.deepEqual(globalThis.__calls, ["cancel", "load:42"]);
});

test("picking the open container conversation leaves its reply running", async (t) => {
  const chat = await renderContainerChat(t);
  await React.act(async () => {
    await chat.current.switchConversation(42);
  });
  globalThis.__calls.length = 0;

  await React.act(async () => {
    await chat.current.switchConversation(42);
  });

  assert.deepEqual(globalThis.__calls, []);
});

test("a new container chat cancels the running reply before clearing the conversation", async (t) => {
  const chat = await renderContainerChat(t);

  await React.act(async () => {
    chat.current.startNewChat();
  });

  assert.deepEqual(globalThis.__calls, ["cancel", "new"]);
});

test("a container chat reads busy until a send lets go of the send lock", async (t) => {
  const chat = await renderContainerChat(t);
  assert.equal(chat.current.agentState, "idle");

  let firstSend;
  await React.act(async () => {
    firstSend = chat.current.sendMessage("What changed this week?");
  });
  // A question sent now would be refused by the lock, so the composer must
  // treat the chat as busy and keep the draft.
  assert.notEqual(chat.current.agentState, "idle");

  await React.act(async () => {
    globalThis.__finishSend();
    await firstSend;
  });
  assert.equal(chat.current.agentState, "idle");
});
