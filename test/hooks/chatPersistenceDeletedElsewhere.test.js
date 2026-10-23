const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A chat can be deleted while it is open: by its retention period, from another
// window, or by a sync. The session must notice, or every later save silently
// no-ops against the missing row.
async function mountPersistence(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = new Set();
  const saved = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversation: async (id) => ({
          id,
          messages: [{ role: "user", content: "Plan the offsite" }],
        }),
        addAgentMessage: async (id, role, content) => {
          saved.push({ id, role, content });
          return { id: saved.length };
        },
        onConversationsDeleted: (callback) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-persistence-deleted-test-",
  });
  const { useChatPersistence } = await vite.ssrLoadModule(
    "/components/chat/useChatPersistence.ts"
  );
  const handle = { current: null };
  const notified = [];
  function Harness() {
    handle.current = useChatPersistence({ onConversationDeleted: () => notified.push("deleted") });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => {
    await handle.current.loadConversation(5);
  });
  return {
    handle,
    saved,
    notified,
    deleteElsewhere: (id) =>
      React.act(async () => {
        for (const listener of listeners) listener({ ids: [id] });
      }),
  };
}

test("an open chat deleted elsewhere starts over instead of saving into it", async (t) => {
  const chat = await mountPersistence(t);
  assert.equal(chat.handle.current.conversationId, 5);

  await chat.deleteElsewhere(5);

  assert.equal(chat.handle.current.conversationId, null);
  assert.deepEqual(chat.handle.current.messages, []);
  assert.deepEqual(chat.notified, ["deleted"]);
  await React.act(async () => {
    await chat.handle.current.saveUserMessage("Still there?");
  });
  assert.deepEqual(chat.saved, []);
});

test("deleting another chat leaves the open one alone", async (t) => {
  const chat = await mountPersistence(t);

  await chat.deleteElsewhere(6);

  assert.equal(chat.handle.current.conversationId, 5);
  assert.equal(chat.handle.current.messages.length, 1);
  assert.deepEqual(chat.notified, []);
});
