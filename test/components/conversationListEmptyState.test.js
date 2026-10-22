const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const ARCHIVED_CHAT = {
  id: 1,
  title: "Trip planning",
  last_message: "Booked",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  archived_at: "2026-09-02T00:00:00.000Z",
};

async function renderConversationList(t, { active, archived }) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
          isArchived ? archived : active,
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-conversation-list-empty-test-",
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
  return container;
}

test("with every chat archived, the list says so instead of showing nothing", async (t) => {
  const container = await renderConversationList(t, { active: [], archived: [ARCHIVED_CHAT] });
  assert.match(container.textContent, /chat\.allArchived/);
  assert.doesNotMatch(container.textContent, /chat\.noConversations/);
});

test("with no chats at all, the list shows its empty state", async (t) => {
  const container = await renderConversationList(t, { active: [], archived: [] });
  assert.match(container.textContent, /chat\.noConversations/);
});
