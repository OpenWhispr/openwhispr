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

// Mounts the dialog over `spaces` and `notes`, with the workspace store in `workspaceState`, and
// returns its text.
async function renderDialog(t, { spaces, notes, workspaceState }) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNotes: async (_type, limit, _folderId, _spaceId, spaceIds) =>
          notes.filter((n) => !spaceIds || spaceIds.includes(n.space_id)).slice(0, limit),
      },
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-add-notes-to-folder-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export const useTranslation = () => ({ t });`,
      "/hooks/useUiLocale": `export const useUiLocale = () => "en";`,
      "/ui/dialog": `
        import React from "react";
        const Pass = ({ children }) => React.createElement("div", null, children);
        export const Dialog = ({ open, children }) => (open ? Pass({ children }) : null);
        export const DialogContent = Pass;
        export const DialogTitle = Pass;
      `,
      "/stores/noteStore": `
        const spaces = ${JSON.stringify(spaces)};
        export const useSpaces = () => spaces;
      `,
      "/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
      "/stores/workspaceStore": `
        const state = {
          ...${JSON.stringify(workspaceState)},
          error: false,
          refresh: async () => {},
          setActiveWorkspaceId() {},
        };
        export const useWorkspaceStore = (selector) => selector(state);
      `,
    },
  });
  const { default: AddNotesToFolderDialog } = await vite.ssrLoadModule(
    "/components/notes/AddNotesToFolderDialog.tsx"
  );

  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(AddNotesToFolderDialog, {
        open: true,
        onOpenChange: () => {},
        targetFolderId: 7,
        onNotesAdded: () => {},
      })
    )
  );
  return textOf(container);
}

const acmeAndOther = [
  { id: "acme", name: "Acme", role: "member", is_default: true },
  { id: "other", name: "Other", role: "member", is_default: false },
];

test("Add existing never offers a note from a workspace the switcher hides", async (t) => {
  // Newest first, as the query orders them: enough Acme notes to fill the dialog's limit.
  const text = await renderDialog(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: null },
      { id: 2, kind: "team", workspace_id: "acme" },
    ],
    notes: [
      ...Array.from({ length: 500 }, (_, i) => note(100 + i, "Acme roadmap", 2)),
      note(1, "Personal plan", 1),
    ],
    workspaceState: {
      workspaces: acmeAndOther,
      activeWorkspaceId: "other",
      defaultWorkspaceId: "other",
      loaded: true,
    },
  });
  assert.match(text, /Personal plan/);
  assert.doesNotMatch(text, /Acme roadmap/, "moving it here would pull it out of Acme");
});

test("the Add existing picker offers only the active workspace's notes", async (t) => {
  const text = await renderDialog(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: "acme" },
      { id: 2, kind: "team", workspace_id: "acme" },
      { id: 3, kind: "private", workspace_id: "other" },
      { id: 4, kind: "team", workspace_id: "other" },
    ],
    notes: [
      note(1, "Acme private", 1),
      note(2, "Acme roadmap", 2),
      note(3, "Other private", 3),
      note(4, "Other plan", 4),
    ],
    workspaceState: {
      workspaces: acmeAndOther,
      activeWorkspaceId: "other",
      defaultWorkspaceId: "acme",
      loaded: true,
    },
  });
  assert.match(text, /Other private/);
  assert.match(text, /Other plan/);
  assert.doesNotMatch(text, /Acme private/, "another workspace's Private stays in that workspace");
  assert.doesNotMatch(text, /Acme roadmap/);
});

test("Add existing offers the saved workspace's Private while the list loads", async (t) => {
  // The launch before the workspace list answers: the active workspace comes from storage and the
  // default isn't known yet.
  const text = await renderDialog(t, {
    spaces: [
      { id: 1, kind: "private", workspace_id: "acme", is_default_private: 1 },
      { id: 3, kind: "private", workspace_id: "other" },
    ],
    notes: [note(1, "Acme private", 1), note(3, "Other private", 3)],
    workspaceState: {
      workspaces: [],
      activeWorkspaceId: "other",
      defaultWorkspaceId: null,
      loaded: false,
    },
  });
  assert.match(text, /Other private/);
  assert.doesNotMatch(text, /Acme private/);
});
