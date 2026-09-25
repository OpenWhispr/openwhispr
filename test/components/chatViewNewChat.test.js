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
    export function useChatStreaming() {
      const [agentState, setAgentState] = useState("idle");
      const cancelStream = useCallback(() => {
        globalThis.__cancelCount += 1;
        setAgentState("idle");
      }, []);
      const sendToAI = useCallback(() => {
        setAgentState("tool-executing");
        return globalThis.__pendingSend;
      }, []);
      return { agentState, toolStatus: "", activeToolName: "", sendToAI, cancelStream };
    }
  `,
  "/useChatPersistence": `
    export function useChatPersistence() {
      return {
        conversationId: null,
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
  "/ChatInput": `
    export function ChatInput(props) {
      globalThis.__chatInput = props;
      return null;
    }
  `,
  "/ConversationList": `
    export default function ConversationList(props) {
      globalThis.__conversationList = props;
      return null;
    }
  `,
  "/ChatMessages": `export function ChatMessages() { return null; }`,
  "/ChatEmptyIllustration": `export function ChatEmptyIllustration() { return null; }`,
  "/EmptyChatState": `export default function EmptyChatState() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; }`,
  "/hooks/useDialogs": `
    export function useDialogs() {
      return { confirmDialog: { open: false }, showConfirmDialog() {}, hideConfirmDialog() {} };
    }
  `,
};

// Each way of leaving the conversation cancels its running reply.
const LEAVE_CONVERSATION = {
  "New chat": (list) => list.onNewChat(),
  "switching conversation": (list) => list.onSelectConversation(7),
};

for (const [leave, leaveConversation] of Object.entries(LEAVE_CONVERSATION)) {
  test(`${leave} cancels the reply, and the input stays busy until it lets go`, async (t) => {
    let root = null;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
      delete globalThis.__pendingSend;
      delete globalThis.__chatInput;
      delete globalThis.__conversationList;
      delete globalThis.__cancelCount;
    });
    installBrowserGlobals(t);
    const container = installInteractiveDom(t);
    let settleSend;
    globalThis.__pendingSend = new Promise((resolve) => {
      settleSend = resolve;
    });
    globalThis.__cancelCount = 0;
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-chat-view-new-chat-test-",
      mockModules: MOCKS,
    });
    const { default: ChatView } = await vite.ssrLoadModule("/components/chat/ChatView.tsx");
    const { createRoot } = require("react-dom/client");
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(ChatView)));

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
