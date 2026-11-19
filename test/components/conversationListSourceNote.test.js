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

async function renderConversationList(t, api = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
          isArchived ? [] : CHATS,
        ...api,
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
        onUnarchive: noop,
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
  assert.match(text, /Deleted/);
});

test("an untitled note's row drops the Untitled suffix and shows the note as untitled", async (t) => {
  const container = await renderConversationList(t);
  const text = rowText(container, "Draft a reply");
  assert.doesNotMatch(text, /· Untitled/);
  assert.match(text, /Untitled Note/);
});

test("a plain chat's row keeps its preview", async (t) => {
  const container = await renderConversationList(t);
  assert.match(rowText(container, "Summarize my week"), /Here's a recap/);
});

for (const [event, changes, expected] of [
  ["onNoteUpdated", { note_title: "Renamed planning sync" }, /Renamed planning sync/],
  ["onNoteSynced", { note_title: "Synced planning sync" }, /Synced planning sync/],
  ["onNoteDeleted", { note_deleted_at: "2026-11-02T10:00:00Z" }, /Deleted/],
  ["onFolderDeleted", { note_title: null }, /three decisions/],
  ["onSpacePurged", { note_title: null }, /three decisions/],
]) {
  test(`${event} refreshes source metadata without remounting the list`, async (t) => {
    let chats = CHATS;
    let refresh;
    let disposed = false;
    const container = await renderConversationList(t, {
      getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
        isArchived ? [] : chats,
      [event]: (callback) => {
        refresh = callback;
        return () => {
          disposed = true;
        };
      },
    });
    chats = CHATS.map((chat) => (chat.id === 1 ? { ...chat, ...changes } : chat));
    await React.act(async () => refresh?.(event === "onSpacePurged" ? { spaceId: 1 } : { id: 5 }));
    assert.match(rowText(container, "Onboarding decisions"), expected);
    t.after(() => assert.equal(disposed, true, "the subscription is disposed on unmount"));
  });
}

// M6: a chat about a note outside the active workspace's scope stays out of the list, as the
// note stays out of that chat's grounding: its earlier replies would reach the model as history.
// Root chats, and chats whose note is gone, stay listed.
test("a chat whose note sits outside the active workspace is left out of the list", async (t) => {
  const chats = [
    row({ id: 20, title: "In this workspace", note_id: 30, note_title: "Here", note_space_id: 3 }),
    row({
      id: 21,
      title: "In another workspace",
      note_id: 31,
      note_title: "There",
      note_space_id: 9,
    }),
    row({ id: 22, title: "A plain chat", last_message: "Hi" }),
    row({ id: 23, title: "Its note is gone", note_id: 32, note_title: null, note_space_id: null }),
  ];
  const container = await renderConversationList(t, {
    getAgentConversationsWithPreview: async (_limit, _offset, isArchived) =>
      isArchived ? [] : chats,
    getPrivateSpaceId: async () => 3,
    getSpaces: async () => [
      { id: 3, kind: "private", workspace_id: null },
      { id: 9, kind: "private", workspace_id: "other" },
    ],
  });
  assert.ok(rowText(container, "In this workspace"));
  assert.equal(rowText(container, "In another workspace"), undefined);
  assert.ok(rowText(container, "A plain chat"));
  assert.ok(rowText(container, "Its note is gone"));
});
