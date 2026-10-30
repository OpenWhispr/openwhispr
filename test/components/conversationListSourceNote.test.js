const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { findAll } = require("../lib/skillsHarness");

const row = (overrides) => ({
  created_at: "2026-10-30T09:00:00.000Z",
  updated_at: "2026-10-30T09:00:00.000Z",
  archived_at: null,
  message_count: 2,
  note_id: null,
  note_title: null,
  note_deleted_at: null,
  ...overrides,
});

const CHATS = [
  row({
    id: 1,
    title: "Onboarding decisions · Q3 planning sync",
    last_message: "The note records three decisions",
    note_id: 5,
    note_title: "Q3 planning sync",
  }),
  row({
    id: 2,
    title: "Open questions · Daily standup",
    last_message: "Two are still open",
    note_id: 6,
    note_title: "Daily standup",
    note_deleted_at: "2026-10-29T10:00:00.000Z",
  }),
  row({ id: 3, title: "Summarize my week", last_message: "Here's a recap" }),
  row({
    id: 4,
    title: "Draft a reply · Untitled",
    last_message: "Sure",
    note_id: 7,
    note_title: "",
  }),
];

async function renderConversationList(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
          isArchived ? [] : CHATS,
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-conversation-list-source-note-test-",
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

const rowText = (container, title) =>
  findAll(container, (node) => node.nodeName === "BUTTON" && node.textContent.includes(title))[0]
    ?.textContent;

test("a note chat's row names its note instead of repeating it in the title", async (t) => {
  const container = await renderConversationList(t);
  const text = rowText(container, "Onboarding decisions");
  assert.ok(text, "the row renders");
  assert.match(text, /Q3 planning sync/);
  assert.doesNotMatch(text, /· Q3 planning sync/, "the title suffix is dropped");
  assert.doesNotMatch(text, /three decisions/, "the note takes the preview's place");
});

test("a row whose note was deleted says so", async (t) => {
  const container = await renderConversationList(t);
  const text = rowText(container, "Open questions");
  assert.match(text, /Daily standup/);
  assert.match(text, /chat\.sourceNote\.deletedShort/);
});

test("an untitled note's row drops the Untitled suffix and shows the note as untitled", async (t) => {
  const container = await renderConversationList(t);
  const text = rowText(container, "Draft a reply");
  assert.doesNotMatch(text, /· Untitled/);
  assert.match(text, /notes\.list\.untitledNote/);
});

test("a plain chat's row keeps its preview", async (t) => {
  const container = await renderConversationList(t);
  assert.match(rowText(container, "Summarize my week"), /Here's a recap/);
});
