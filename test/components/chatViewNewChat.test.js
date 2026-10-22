const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// ChatView with its real message sender (and its submission lock), the
// streaming hook replaced by one whose send stays pending until the test
// settles it: a turn still waiting on a tool when the user starts a new chat.
const MOCKS = {
  "/useChatStreaming": `
    import { useCallback, useState } from "react";
    export function useChatStreaming(options) {
      globalThis.__chatStreamingOptions = options;
      const [agentState, setAgentState] = useState("idle");
      const cancelStream = useCallback(() => {
        globalThis.__cancelCount += 1;
        setAgentState("idle");
      }, []);
      const sendToAI = useCallback((...args) => {
        (globalThis.__sends ??= []).push(args);
        setAgentState("tool-executing");
        return globalThis.__pendingSend;
      }, []);
      return { agentState, toolStatus: "", activeToolName: "", sendToAI, cancelStream };
    }
  `,
  "/useChatPersistence": `
    import { useState } from "react";
    export function useChatPersistence() {
      const [messages, setMessages] = useState(globalThis.__initialMessages ?? []);
      return {
        conversationId: null,
        messages,
        setMessages,
        forkOrigin: globalThis.__forkOrigin ?? null,
        createConversation: async () => {
          globalThis.__createCount += 1;
          return 1;
        },
        saveUserMessage: async (text, options) => {
          (globalThis.__savedUserMessages ??= []).push(options);
        },
        saveAssistantMessage() {},
        loadConversation: async () => globalThis.__loadResult,
        forkConversation: async () => globalThis.__forkResult,
        handleNewChat() {
          globalThis.__newChatCount = (globalThis.__newChatCount ?? 0) + 1;
        },
      };
    }
  `,
  "/ChatInput": `
    import { createElement } from "react";
    export function ChatInput(props) {
      globalThis.__chatInput = props;
      return createElement("textarea");
    }
  `,
  "/ConversationList": `
    export default function ConversationList(props) {
      globalThis.__conversationList = props;
      return null;
    }
  `,
  "/ChatMessages": `
    export function ChatMessages(props) {
      globalThis.__chatMessages = props;
      return null;
    }
  `,
  "/ui/useToast": `
    export function useToast() {
      return { toast: (toast) => (globalThis.__toasts ??= []).push(toast) };
    }
  `,
  "/ui/dialog": `export function ConfirmDialog() { return null; }`,
  "/hooks/useDialogs": `
    export function useDialogs() {
      return { confirmDialog: { open: false }, showConfirmDialog() {}, hideConfirmDialog() {} };
    }
  `,
};

const GLOBALS = [
  "__sends",
  "__initialMessages",
  "__forkOrigin",
  "__savedUserMessages",
  "__forkResult",
  "__newChatCount",
  "__chatMessages",
  "__toasts",
];

async function renderChatView(t, props = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const name of GLOBALS) delete globalThis[name];
    delete globalThis.__pendingSend;
    delete globalThis.__chatInput;
    delete globalThis.__conversationList;
    delete globalThis.__cancelCount;
    delete globalThis.__createCount;
    delete globalThis.__loadResult;
    delete globalThis.__chatStreamingOptions;
    delete globalThis.__keydown;
  });
  installBrowserGlobals(t, {
    window: {
      addEventListener(type, listener) {
        if (type === "keydown") {
          globalThis.__keydown = (init) => listener({ preventDefault() {}, ...init });
        }
      },
      removeEventListener() {},
    },
  });
  const container = installInteractiveDom(t);
  globalThis.__cancelCount = 0;
  globalThis.__createCount = 0;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-view-new-chat-test-",
    mockModules: MOCKS,
  });
  const { default: ChatView } = await vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  const render = (next) => React.act(async () => root.render(React.createElement(ChatView, next)));
  await render(props);
  return { rerender: render };
}

test("typed chat offers the connector tools", async (t) => {
  await renderChatView(t);
  assert.equal(globalThis.__chatStreamingOptions.allowConnectors, true);
});

// Each way of leaving the conversation cancels its running reply.
const LEAVE_CONVERSATION = {
  "New chat": (list) => list.onNewChat(),
  "switching conversation": (list) => list.onSelectConversation(7),
};

for (const [leave, leaveConversation] of Object.entries(LEAVE_CONVERSATION)) {
  test(`${leave} cancels the reply, and the input stays busy until it lets go`, async (t) => {
    let settleSend;
    globalThis.__pendingSend = new Promise((resolve) => {
      settleSend = resolve;
    });
    await renderChatView(t);

    await React.act(async () => {
      void globalThis.__chatInput.onTextSubmit("Search the web for flights");
    });
    await React.act(async () => leaveConversation(globalThis.__conversationList));

    assert.equal(globalThis.__cancelCount, 1);
    // The old send still holds the submission lock, so a message typed now
    // would be dropped; the input must not look ready for one.
    assert.notEqual(globalThis.__chatInput.agentState, "idle");

    await React.act(async () => settleSend());
    assert.equal(globalThis.__chatInput.agentState, "idle");
  });
}

test("a follow-up after reopening a deleted conversation starts a new one", async (t) => {
  globalThis.__loadResult = null;
  await renderChatView(t);

  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  await React.act(async () => globalThis.__chatInput.onTextSubmit("A follow-up"));

  assert.equal(globalThis.__createCount, 1);
});

// The composer stays collapsed until focused, so nothing focuses it when the page opens;
// starting a new chat is the moment the user means to type.
const START_NEW_CHAT = {
  "the New chat button": () => globalThis.__conversationList.onNewChat(),
  "the shortcut": () => globalThis.__keydown({ key: "n", metaKey: true, ctrlKey: true }),
};

for (const [way, startNewChat] of Object.entries(START_NEW_CHAT)) {
  test(`starting a new chat with ${way} puts the cursor in the composer`, async (t) => {
    await renderChatView(t);
    assert.equal(globalThis.document.activeElement, null);

    await React.act(async () => startNewChat());
    assert.equal(globalThis.document.activeElement?.tagName, "TEXTAREA");
  });
}

test("a fork made from selected text sends it with its first request only", async (t) => {
  globalThis.__forkOrigin = {
    parentConversationId: 3,
    parentTitle: "Plan",
    context: " Draft one. ",
  };
  await renderChatView(t);

  await React.act(async () => globalThis.__chatInput.onTextSubmit("Shorter"));
  await React.act(async () => globalThis.__chatInput.onTextSubmit("Again"));

  assert.deepEqual(
    globalThis.__sends.map(([, , options]) => options.selectedContext?.text),
    ["Draft one.", undefined]
  );
  assert.deepEqual(
    globalThis.__savedUserMessages.map((options) => options.selectedContext),
    ["Draft one.", undefined],
    "the user message keeps the text it was about"
  );
});

test("a fork the user left for another chat first shows no error", async (t) => {
  globalThis.__initialMessages = [
    { id: "m1", role: "assistant", content: "Draft", isStreaming: false, dbId: 1 },
  ];
  globalThis.__forkResult = false;
  await renderChatView(t);
  await React.act(async () => globalThis.__chatMessages.onForkMessage("m1"));
  assert.equal(globalThis.__toasts, undefined);
  assert.equal(globalThis.__conversationList.activeConversationId, null, "nothing opens");

  globalThis.__forkResult = null;
  await React.act(async () => globalThis.__chatMessages.onForkMessage("m1"));
  assert.equal(globalThis.__toasts.length, 1);
});

test("a chat kept open behind another view ignores the New chat shortcut until shown", async (t) => {
  const view = await renderChatView(t, { active: false });
  assert.equal(globalThis.__keydown, undefined, "no shortcut while hidden");

  await view.rerender({ active: true });
  await React.act(async () => globalThis.__keydown({ key: "n", metaKey: true, ctrlKey: true }));
  assert.equal(globalThis.__newChatCount, 1);
});

test("New chat from the menu starts a new chat in a chat that stayed open", async (t) => {
  const view = await renderChatView(t, { newChatRequest: 1 });
  assert.equal(globalThis.__newChatCount, undefined, "a chat opened by it is new already");
  await view.rerender({ newChatRequest: 2 });
  assert.equal(globalThis.__newChatCount, 1);
});
