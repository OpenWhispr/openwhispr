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

// Opens command search with main holding `spaces` and `notes`, and returns its text and the
// space lists the note queries named.
async function openSearch(t, { spaces, notes }) {
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
        export const DropdownMenuItem = Pass;
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
          activeWorkspaceId: "other",
          defaultWorkspaceId: "acme",
          loaded: true,
          error: false,
          refresh: async () => {},
          setActiveWorkspaceId() {},
        };
        export const useWorkspaceStore = (selector) => selector(state);
      `,
    },
  });
  const { default: CommandSearch } = await vite.ssrLoadModule("/components/CommandSearch.tsx");

  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(CommandSearch, { open: true, onOpenChange: () => {} }))
  );
  await React.act(async () => {
    for (let i = 0; i < 3; i++) await new Promise(setImmediate);
  });
  return { text: textOf(container), queriedSpaceIds };
}

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
