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

async function mountOverview(t, cachePrefix) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__overviewNotes;
    delete globalThis.__overviewNotesByContainer;
    delete globalThis.__overviewAskMounts;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  globalThis.__overviewNotesByContainer = {};
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/stores/workspaceStore":
        "export const useWorkspaceStore = (selector) => selector({ workspaces: [] });",
      "/stores/noteStore": `
        export const useNotes = () => globalThis.__overviewNotes ?? [];
        export const useNotesByContainer = () => globalThis.__overviewNotesByContainer;
        export const useFolders = () => [];
        export const useFolderCounts = () => ({});
        export const useSpaceRootCounts = () => ({});
        export const folderContainerKey = (id) => "f:" + id;
        export const ensureContainerLoaded = () => Promise.reject(new Error("offline"));
      `,
      "/hooks/useContainerChat": "export const useContainerChat = () => ({});",
      "/lib/spacePermissions": "export const canManageSpace = () => false;",
      "/InviteTeammateDialog": "export default function Mock() { return null; }",
      "/OverviewExplainerBanner": "export const OverviewExplainerBanner = () => null;",
      "/OverviewAskSection": `
        import { useEffect } from "react";
        export const OverviewAskSection = () => {
          useEffect(() => {
            globalThis.__overviewAskMounts = (globalThis.__overviewAskMounts ?? 0) + 1;
          }, []);
          return null;
        };
      `,
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
  const render = () =>
    React.act(async () => root.render(React.createElement(ContainerOverview, props)));
  return { container, render };
}

test("a folder load error clears once the folder's notes arrive", async (t) => {
  const { container, render } = await mountOverview(t, "openwhispr-container-overview-load-error-");

  await render();
  assert.match(textOf(container), /common\.retry/, "a failed load offers a retry");

  globalThis.__overviewNotesByContainer = { "f:7": [] };
  await render();
  const text = textOf(container);
  assert.doesNotMatch(text, /common\.retry/, "notes loaded elsewhere replace the error");
  assert.match(text, /Projects/);
});

test("the ask composer keeps its state when the note count crosses zero", async (t) => {
  const { render } = await mountOverview(t, "openwhispr-container-overview-ask-identity-");
  globalThis.__overviewNotesByContainer = { "f:7": [] };

  await render();
  // A chat reply that creates the folder's first note moves the composer above the list.
  globalThis.__overviewNotes = [{ id: 1, title: "First" }];
  await render();
  globalThis.__overviewNotes = [];
  await render();

  assert.equal(globalThis.__overviewAskMounts, 1, "a remount would drop the draft and focus");
});
