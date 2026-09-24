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

test("a folder load error clears once the folder's notes arrive", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__overviewNotesByContainer;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  globalThis.__overviewNotesByContainer = {};
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-container-overview-load-error-",
    mockModules: {
      "/stores/workspaceStore":
        "export const useWorkspaceStore = (selector) => selector({ workspaces: [] });",
      "/stores/noteStore": `
        export const useNotes = () => [];
        export const useNotesByContainer = () => globalThis.__overviewNotesByContainer;
        export const useFolders = () => [];
        export const useFolderCounts = () => ({});
        export const useSpaceRootCounts = () => ({});
        export const useIsTreeLoading = () => false;
        export const folderContainerKey = (id) => "f:" + id;
        export const ensureContainerLoaded = () => Promise.reject(new Error("offline"));
      `,
      "/hooks/useContainerChat": "export const useContainerChat = () => ({});",
      "/lib/spacePermissions": "export const canManageSpace = () => false;",
      "/InviteTeammateDialog": "export default function Mock() { return null; }",
      "/OverviewExplainerBanner": "export const OverviewExplainerBanner = () => null;",
      "/OverviewAskSection": "export const OverviewAskSection = () => null;",
      "/OverviewNoteList": "export const OverviewNoteList = () => null;",
    },
  });
  const { ContainerOverview } = await vite.ssrLoadModule(
    "/components/notes/overview/ContainerOverview.tsx"
  );
  const props = {
    space: { id: 1, kind: "private", name: "Personal", sync_status: "synced" },
    folder: { id: 7, space_id: 1, name: "Projects", is_default: 0 },
    onOpenNote: () => {},
    onNewNote: () => {},
  };
  root = createRoot(container);

  await React.act(async () => root.render(React.createElement(ContainerOverview, props)));
  assert.match(textOf(container), /common\.retry/, "a failed load offers a retry");

  globalThis.__overviewNotesByContainer = { "f:7": [] };
  await React.act(async () => root.render(React.createElement(ContainerOverview, props)));
  const text = textOf(container);
  assert.doesNotMatch(text, /common\.retry/, "notes loaded elsewhere replace the error");
  assert.match(text, /Projects/);
});
