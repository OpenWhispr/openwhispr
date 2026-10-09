const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  SIGNED_OUT_AUTH_MOCK,
} = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

test("switching notes while an edit reads its target cancels the write and the success reply", async (t) => {
  let root;
  let reasoning;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    reasoning?.destroy();
  });
  const notes = new Map(
    [7, 8].map((id) => [
      id,
      {
        id,
        title: `Note ${id}`,
        content: `Personal ${id}`,
        enhanced_content: "## Decisions Made\nKeep me",
        transcript: "Source",
      },
    ])
  );
  let releaseRead;
  let readStarted;
  const started = new Promise((resolve) => {
    readStarted = resolve;
  });
  const writes = [];
  const replies = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getConversationsForNote: async () => [],
        createAgentConversation: async () => ({ id: 1 }),
        addAgentMessage: async (_id, role, text) => {
          if (role === "assistant") replies.push(text);
        },
        getNote: async (id) => {
          readStarted();
          await new Promise((resolve) => {
            releaseRead = resolve;
          });
          return notes.get(id);
        },
        updateNote: async (id, updates) => {
          writes.push({ id, updates });
          Object.assign(notes.get(id), updates);
          return { success: true };
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, { mockModules: SIGNED_OUT_AUTH_MOCK });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({ isSignedIn: true, chatAgentMode: "openwhispr" });
  reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { syncService } = await vite.ssrLoadModule("/services/SyncService.ts");
  t.mock.method(syncService, "debouncedPush", () => {});
  t.mock.method(reasoning, "processTextStreamingCloud", (_messages, config) =>
    (async function* () {
      await config.executeToolCall("update_note", JSON.stringify({ id: 7, summary: "" }), "edit");
      yield { type: "content", text: "Removed it." };
      yield { type: "done", finishReason: "stop" };
    })()
  );
  const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
  let chat;
  function Harness({ id }) {
    const note = notes.get(id);
    chat = useEmbeddedChat({
      noteId: id,
      folderId: null,
      noteTitle: note.title,
      noteContent: note.content,
      noteSummary: note.enhanced_content,
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness, { id: 7 })));
  let sending;
  await React.act(async () => {
    sending = chat.sendMessage("Remove Decisions Made from this summary.");
    await started;
  });
  await React.act(async () => root.render(React.createElement(Harness, { id: 8 })));
  await React.act(async () => {
    releaseRead();
    await sending;
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(replies, []);
  assert.deepEqual(chat.messages, []);
  assert.equal(chat.activeConversationId, null);
  for (const note of notes.values())
    assert.equal(note.enhanced_content, "## Decisions Made\nKeep me");
});
