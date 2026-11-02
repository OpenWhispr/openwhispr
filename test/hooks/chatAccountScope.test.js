const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const MOCKS = {
  "/useChatStreaming": `
    import { useCallback } from "react";
    export function useChatStreaming(options) {
      globalThis.__accountChat.messages = options.messages;
      const cancelStream = useCallback(() => { globalThis.__accountChat.cancels++; }, []);
      const sendToAI = useCallback(async (_text, messages) => {
        globalThis.__accountChat.payloads.push(messages.map(message => message.content));
      }, []);
      return { agentState: "idle", toolStatus: "", activeToolName: "", sendToAI, cancelStream };
    }
  `,
  "/ChatInput": `
    export function ChatInput(props) { globalThis.__accountChat.input = props; return null; }
  `,
  "/ConversationList": `
    export default function ConversationList(props) {
      globalThis.__accountChat.list = props;
      return null;
    }
  `,
  "/ChatMessages": `export function ChatMessages() { return null; }`,
  "/ui/dialog": `export function ConfirmDialog() { return null; }`,
  "/hooks/useDialogs": `
    export function useDialogs() {
      return { confirmDialog: { open: false }, showConfirmDialog() {}, hideConfirmDialog() {} };
    }
  `,
  "/hooks/useWindowDrag": `
    export function useWindowDrag() { return { handleMouseDown() {}, handleMouseUp() {} }; }
  `,
  "/hooks/useCopyFeedback": `
    export function useCopyFeedback() {
      return { copied: false, copyText: async () => true, confirmCopied() {} };
    }
  `,
  "/stores/settingsStore": `
    export function useSettingsStore(selector) { return selector({ voiceAgentKey: [] }); }
  `,
  "/utils/hotkeys": `export function formatHotkeyListLabel() { return ""; }`,
  "/ui/MarkdownRenderer": `
    import { createElement } from "react";
    export function MarkdownRenderer({ content }) { return createElement("div", null, content); }
  `,
  "/ui/useToast": `export function useToast() { return { toast() {} }; }`,
  "/stores/connectorApprovalStore": `
    export function useConnectorApprovalStore(selector) { return selector({ entries: {} }); }
    export function approvalKey(messageId, callId) { return messageId + "::" + callId; }
  `,
};

for (const surface of ["typed", "assistant", "note", "container"]) {
  test(`${surface} chat drops the departed account's history before its next model request`, async (t) => {
    let root;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
      delete globalThis.__accountChat;
    });
    const recorded = { messages: [], payloads: [], cancels: 0 };
    globalThis.__accountChat = recorded;
    let scope = { accountId: "account-a", authGeneration: 1 };
    const listeners = new Set();
    const creates = [];
    let resolveOldList;
    let listReads = 0;
    const readList = async () => {
      if (++listReads === 1)
        return new Promise((resolve) => {
          resolveOldList = resolve;
        });
      return [{ id: 8, title: "B's chat" }];
    };
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          getActiveAccountScope: async () => scope,
          onActiveAccountScopeChanged: (callback) => {
            listeners.add(callback);
            return () => listeners.delete(callback);
          },
          getAgentConversation: async (id) => ({
            id,
            messages: [
              { role: "user", content: "A's private question" },
              { role: "assistant", content: "A's private answer" },
            ],
          }),
          createAgentConversation: async () => {
            creates.push(scope.accountId);
            return { id: 9 };
          },
          addAgentMessage: async () => ({}),
          getConversationsForNote: readList,
          getConversationsForContainer: readList,
        },
      },
    });
    const container = installInteractiveDom(t);
    const vite = await createRendererServer(t, { mockModules: MOCKS });
    const { default: ChatView } = await vite.ssrLoadModule("/components/chat/ChatView.tsx");
    const { AssistantPanel } = await vite.ssrLoadModule("/components/dictation/AssistantPanel.tsx");
    const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
    const { useContainerChat } = await vite.ssrLoadModule("/hooks/useContainerChat.ts");
    let chat;
    function Harness() {
      const [conversationId, setConversationId] = React.useState(7);
      if (surface === "typed") return React.createElement(ChatView);
      if (surface === "assistant") {
        return React.createElement(AssistantPanel, {
          initialConversationId: conversationId,
          onConversationIdChange: setConversationId,
          pendingCommand: null,
          open: true,
          voiceState: "idle",
          thinking: false,
          footerPhase: "actions",
          horizontalDirection: "right",
          onCommandConsumed() {},
          onCommandDiscarded() {},
          onCommandSettled() {},
          onClose() {},
          onBusyChange() {},
          onResponseReadyChange() {},
          onResponseContent() {},
          onConversationReset() {},
          onSelectionContextChange() {},
        });
      }
      chat =
        surface === "note"
          ? useEmbeddedChat({ noteId: 1, folderId: null, noteTitle: "Meeting", noteContent: "" })
          : useContainerChat({ space: { id: 1, name: "Personal" }, folder: null, notes: [] });
      return null;
    }
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    if (surface !== "assistant") {
      await React.act(async () =>
        surface === "typed" ? recorded.list.onSelectConversation(7) : chat.switchConversation(7)
      );
    }
    assert.equal(recorded.messages[0].content, "A's private question");
    const cancellations = recorded.cancels;
    scope = { accountId: "account-a", authGeneration: 2 };
    await React.act(async () => {
      for (const listener of listeners) listener(scope);
    });
    assert.equal(
      recorded.messages[0].content,
      "A's private question",
      "token rotation keeps history"
    );
    assert.equal(recorded.cancels, cancellations);

    scope = { accountId: "account-b", authGeneration: 3 };
    await React.act(async () => {
      for (const listener of listeners) listener(scope);
    });
    assert.deepEqual(recorded.messages, []);
    assert.ok(recorded.cancels > cancellations, "the departed reply is cancelled");
    assert.equal(container.textContent.includes("A's private answer"), false, "no stale preview");
    if (resolveOldList) {
      await React.act(async () => resolveOldList([{ id: 7, title: "A's chat" }]));
      assert.deepEqual(
        surface === "note" ? chat.noteConversations : chat.conversations,
        [{ id: 8, title: "B's chat" }],
        "the old history-list load cannot return"
      );
    }
    await React.act(async () =>
      surface === "typed" || surface === "assistant"
        ? recorded.input.onTextSubmit("B's follow-up")
        : chat.sendMessage("B's follow-up")
    );
    assert.deepEqual(creates, ["account-b"], "the parent conversation id was cleared too");
    assert.deepEqual(recorded.payloads, [["B's follow-up"]]);
  });
}

test("a conversation load from the departed account cannot refill the chat", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let onScopeChanged;
  let finishLoad;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getActiveAccountScope: async () => ({ accountId: "account-a", authGeneration: 1 }),
        onActiveAccountScopeChanged: (callback) => {
          onScopeChanged = callback;
          return () => {};
        },
        getAgentConversation: () =>
          new Promise((resolve) => {
            finishLoad = resolve;
          }),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t);
  const { useChatPersistence } = await vite.ssrLoadModule("/components/chat/useChatPersistence.ts");
  let chat;
  function Harness() {
    chat = useChatPersistence();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const loading = chat.loadConversation(7);
  await React.act(async () => onScopeChanged(null));
  await React.act(async () =>
    finishLoad({ id: 7, messages: [{ role: "user", content: "A's secret" }] })
  );
  assert.equal(await loading, false);
  assert.deepEqual(chat.messages, []);
  assert.equal(chat.conversationId, null);
});
