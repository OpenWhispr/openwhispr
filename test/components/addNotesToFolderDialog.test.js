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
  const updatedAt = new Date().toISOString();
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNotes: async () => [
          {
            id: 1,
            title: "Personal plan",
            content: "",
            space_id: 1,
            folder_id: null,
            updated_at: updatedAt,
          },
          {
            id: 2,
            title: "Acme roadmap",
            content: "",
            space_id: 2,
            folder_id: null,
            updated_at: updatedAt,
          },
        ],
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
        export const useSpaces = () => [
          { id: 1, kind: "private", workspace_id: null },
          { id: 2, kind: "team", workspace_id: "acme" },
        ];
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
