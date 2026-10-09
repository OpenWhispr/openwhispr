const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

for (const surface of ["note", "container"]) {
  test(`${surface} chat can recover an earlier history after a missing conversation`, async (t) => {
    let root;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
    });
    const loads = [];
    const saves = [];
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          getConversationsForNote: async () => [],
          getConversationsForContainer: async () => [],
          getAgentConversation: async (id) => {
            loads.push(id);
            return id === 99
              ? null
              : { id, messages: [{ role: "user", content: "Earlier question" }] };
          },
          addAgentMessage: async (...args) => saves.push(args),
        },
      },
    });
    const container = installInteractiveDom(t);
    const vite = await createRendererServer(t, {
      mockModules: {
        "/chat/useChatStreaming": `
        export function useChatStreaming() {
          return { agentState: "idle", sendToAI: async () => {}, cancelStream() {} };
        }
      `,
      },
    });
    const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
    const { useContainerChat } = await vite.ssrLoadModule("/hooks/useContainerChat.ts");
    let chat;
    function Harness() {
      chat =
        surface === "note"
          ? useEmbeddedChat({
              noteId: 7,
              folderId: null,
              noteTitle: "Workshop",
              noteContent: "Personal notes",
            })
          : useContainerChat({ space: { id: 1, name: "Personal" }, folder: null, notes: [] });
      return null;
    }
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    await React.act(async () => chat.switchConversation(1));
    assert.equal(chat.activeConversationId, 1);
    await React.act(async () => chat.switchConversation(99));
    assert.equal(chat.activeConversationId, null);
    assert.deepEqual(chat.messages, []);
    await React.act(async () => chat.switchConversation(1));
    assert.deepEqual(loads, [1, 99, 1]);
    assert.equal(chat.activeConversationId, 1);
    assert.equal(chat.messages[0].content, "Earlier question");
    await React.act(async () => chat.sendMessage("A follow-up"));
    assert.ok(
      saves.some(([id, role, text]) => id === 1 && role === "user" && text === "A follow-up")
    );
  });
}
