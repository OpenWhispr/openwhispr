const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const chat = (id, title) => ({
  id,
  title,
  last_message: "Booked",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
});

test("a chat deleted elsewhere drops out of the list", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let active = [chat(1, "Trip planning"), chat(2, "Budget review")];
  const listeners = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
          isArchived ? [] : active,
        onConversationsDeleted: (callback) => {
          listeners.push(callback);
          return () => {};
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-conversation-list-deleted-test-",
  });
  const { default: ConversationList } = await vite.ssrLoadModule(
    "/components/chat/ConversationList.tsx"
  );
  root = createRoot(container);
  const noop = () => {};
  await React.act(async () =>
    root.render(
      React.createElement(ConversationList, {
        activeConversationId: null,
        onSelectConversation: noop,
        onNewChat: noop,
        onOpenSearch: noop,
        onArchive: noop,
        onDelete: noop,
        refreshKey: 0,
      })
    )
  );
  assert.match(container.textContent, /Trip planning/);

  active = [chat(2, "Budget review")];
  await React.act(async () => {
    for (const listener of listeners) listener({ ids: [1] });
  });

  assert.doesNotMatch(container.textContent, /Trip planning/);
  assert.match(container.textContent, /Budget review/);
});
