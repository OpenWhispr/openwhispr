const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

const note = (id, title, spaceId) => ({
  id,
  title,
  content: "",
  space_id: spaceId,
  folder_id: null,
  updated_at: new Date().toISOString(),
});

const passThrough = `
  import React from "react";
  const Pass = React.forwardRef(({ children }, _ref) => React.createElement("div", null, children));
`;

const otherActive = { activeWorkspaceId: "other", defaultWorkspaceId: "acme" };

// Opens command search with main holding `spaces` and `notes` and the workspace store choosing
// `workspaceState`, and returns its text, its scope choices and the space lists the note queries
// named. `api` adds to main's IPC; `mode` is CommandSearch's.
async function openSearch(t, { spaces, notes, workspaceState = otherActive, mode, api = {} }) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const queriedSpaceIds = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getFolders: async () => [],
        getSpaces: async () => spaces,
        getNotes: async (_type, limit, _folderId, _spaceId, spaceIds) => {
          queriedSpaceIds.push(spaceIds);
          return notes.filter((n) => !spaceIds || spaceIds.includes(n.space_id)).slice(0, limit);
        },
        ...api,
      },
    },
  });
  const container = installHostDom(t);
  // The result list looks up the highlighted row to scroll it into view.
  Object.getPrototypeOf(container).querySelector = () => null;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-command-search-scope-",
    noExternal: ["react-i18next", "@radix-ui/react-dialog"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export const useTranslation = () => ({ t });`,
      "/hooks/useUiLocale": `export const useUiLocale = () => "en";`,
      "@radix-ui/react-dialog": `${passThrough}
        export const Root = ({ open, children }) => (open ? React.createElement("div", null, children) : null);
        export const Portal = Pass;
        export const Overlay = Pass;
        export const Content = Pass;
        export const Title = Pass;
        export const Description = Pass;
      `,
      "/ui/dropdown-menu": `${passThrough}
        export const DropdownMenu = Pass;
        export const DropdownMenuTrigger = Pass;
        export const DropdownMenuContent = Pass;
        export const DropdownMenuItem = ({ children }) => React.createElement("li", null, children);
        export const DropdownMenuSeparator = () => null;
      `,
      "/ui/useDismissGuard": `
        export const useDismissGuard = () => ({ registerContent() {}, shouldBlockDismiss: () => false });
      `,
      "/ui/overlayBlur": `export const blurBehindOverlays = false;`,
      "/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
      "/stores/workspaceStore": `
        const state = {
          workspaces: [
            { id: "acme", name: "Acme", role: "member", is_default: true },
            { id: "other", name: "Other", role: "member", is_default: false },
          ],
          ...${JSON.stringify(workspaceState)},
          loaded: true,
          error: false,
          refresh: async () => {},
          setActiveWorkspaceId() {},
        };
        export const useWorkspaceStore = (selector) => selector(state);
        useWorkspaceStore.getState = () => state;
        export const readActiveWorkspaceId = () => state.activeWorkspaceId;
        export const readCachedDefaultWorkspaceId = () => null;
      `,
    },
  });
  const { default: CommandSearch } = await vite.ssrLoadModule("/components/CommandSearch.tsx");

  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(CommandSearch, { open: true, onOpenChange: () => {}, mode }))
  );
  await React.act(async () => {
    for (let i = 0; i < 6; i++) await new Promise(setImmediate);
  });
  const scopeChoices = [];
  const collect = (node) => {
    if (node.nodeName === "LI") scopeChoices.push(textOf(node));
    (node.childNodes ?? []).forEach(collect);
  };
  collect(container);
  return { text: textOf(container), scopeChoices, queriedSpaceIds, container };
}

function findNode(node, nodeName) {
  if (node.nodeName === nodeName) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, nodeName);
    if (found) return found;
  }
  return null;
}

const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))];

test("command search lists only the active workspace's notes", async (t) => {
  const { text, queriedSpaceIds } = await openSearch(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: "acme", name: "Personal" },
      { id: 2, kind: "team", workspace_id: "acme", name: "Acme team" },
      { id: 3, kind: "private", workspace_id: "other", name: "Personal" },
      { id: 4, kind: "team", workspace_id: "other", name: "Other team" },
    ],
    notes: [
      note(1, "Acme private", 1),
      note(2, "Acme roadmap", 2),
      note(3, "Other private", 3),
      note(4, "Other plan", 4),
    ],
  });
  assert.match(text, /Other private/);
  assert.match(text, /Other plan/);
  assert.doesNotMatch(text, /Acme private/, "another workspace's Private stays out of search");
  assert.doesNotMatch(text, /Acme roadmap/);
  assert.ok(queriedSpaceIds.length > 0);
  for (const ids of queriedSpaceIds) assert.deepEqual(ids, [3, 4]);
});

test("command search never asks for notes unscoped, even with nothing to hide", async (t) => {
  // Main holds a Private the list read on open doesn't (made since, or another workspace's).
  const { text, queriedSpaceIds } = await openSearch(t, {
    spaces: [{ id: 3, kind: "private", workspace_id: "other", name: "Personal" }],
    notes: [note(3, "Other private", 3), note(9, "Unlisted private", 9)],
  });
  assert.match(text, /Other private/);
  assert.doesNotMatch(text, /Unlisted private/);
  for (const ids of queriedSpaceIds) assert.deepEqual(ids, [3]);
});

test("command search offers the Private once while the pending one shows beside the workspace's own", async (t) => {
  // The default workspace isn't known yet, so the pending Private shows in this workspace too.
  const { text, scopeChoices } = await openSearch(t, {
    spaces: [
      { id: 3, kind: "private", workspace_id: "other", name: "Personal" },
      { id: 9, kind: "private", workspace_id: null, name: "Personal" },
      { id: 4, kind: "team", workspace_id: "other", name: "Other team" },
    ],
    notes: [note(3, "Other private", 3), note(9, "Pending private", 9), note(4, "Other plan", 4)],
    workspaceState: { activeWorkspaceId: "other", defaultWorkspaceId: null },
  });
  assert.deepEqual(scopeChoices, [
    "commandSearch.allSpaces",
    "notes.spaces.personal",
    "Other team",
  ]);
  assert.match(text, /Other private/);
  assert.match(text, /Pending private/);
  assert.match(text, /Other plan/);
});

const chat = (id, title, noteSpaceId, noteId = noteSpaceId == null ? null : id + 100) => ({
  id,
  title,
  last_message: "",
  updated_at: new Date().toISOString(),
  note_id: noteId,
  note_space_id: noteSpaceId,
});

// M6's rule, as in the Chat list: a chat about a note outside the active workspace stays out of
// the recent chats and of search results, since opening it would bring that note's replies back
// as history. Root chats and chats whose note is gone stay.
test("conversations mode leaves out chats about another workspace's notes", async (t) => {
  const chats = [
    chat(20, "About this workspace's note", 3),
    chat(21, "About another workspace's note", 1),
    chat(22, "A plain chat", null),
    chat(23, "Its note is gone", null, 32),
  ];
  const searched = [];
  const { text, container } = await openSearch(t, {
    mode: "conversations",
    spaces: [
      { id: 1, kind: "private", workspace_id: "acme", name: "Personal" },
      { id: 2, kind: "team", workspace_id: "acme", name: "Acme team" },
      { id: 3, kind: "private", workspace_id: "other", name: "Personal" },
      { id: 4, kind: "team", workspace_id: "other", name: "Other team" },
    ],
    notes: [],
    api: {
      getPrivateSpaceId: async () => 3,
      getAgentConversationsWithPreview: async () => chats,
      semanticSearchConversations: async (query) => {
        searched.push(query);
        return chats;
      },
    },
  });
  const assertScoped = (shown, label) => {
    assert.match(shown, /About this workspace's note/, label);
    assert.doesNotMatch(shown, /About another workspace's note/, label);
    assert.match(shown, /A plain chat/, label);
    assert.match(shown, /Its note is gone/, label);
  };
  assertScoped(text, "recent chats");

  const input = findNode(container, "INPUT");
  await React.act(async () => reactProps(input).onChange({ target: { value: "note" } }));
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (let i = 0; i < 6; i++) await new Promise(setImmediate);
  });
  assert.deepEqual(searched, ["note"]);
  assertScoped(textOf(container), "search results");
});
