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

test("Add existing never offers a note from a workspace Personal hides", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const note = (id, title, spaceId) => ({
    id,
    title,
    content: "",
    space_id: spaceId,
    folder_id: null,
    updated_at: new Date().toISOString(),
  });
  // Newest first, as the query orders them: enough Acme notes to fill the dialog's limit.
  const notes = [
    ...Array.from({ length: 500 }, (_, i) => note(100 + i, "Acme roadmap", 2)),
    note(1, "Personal plan", 1),
  ];
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
        const spaces = [
          { id: 1, kind: "private", workspace_id: null },
          { id: 2, kind: "team", workspace_id: "acme" },
        ];
        export const useSpaces = () => spaces;
      `,
      "/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
      "/stores/workspaceStore": `
        const state = {
          workspaces: [{ id: "acme", name: "Acme", role: "member" }],
          activeWorkspaceId: null,
          personalSelected: true,
          loaded: true,
          error: false,
          refresh: async () => {},
          setActiveWorkspaceId() {},
          selectPersonal() {},
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

  const text = textOf(container);
  assert.match(text, /Personal plan/);
  assert.doesNotMatch(text, /Acme roadmap/, "moving it here would pull it into Personal");
});
