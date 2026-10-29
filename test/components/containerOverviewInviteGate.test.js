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

// Uses the real capabilities module so the gate is checked against the role
// fallback and against server capabilities, not a stub.
async function renderTeamSpaceOverview(t, cachePrefix, workspace) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__inviteGateWorkspaces;
  });
  installBrowserGlobals(t, { window: { electronAPI: { getSpaceNotes: async () => [] } } });
  const container = installHostDom(t);
  globalThis.__inviteGateWorkspaces = [workspace];
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/stores/workspaceStore":
        "export const useWorkspaceStore = (selector) => selector({ workspaces: globalThis.__inviteGateWorkspaces });",
      "/stores/noteStore": `
        const noNotes = [];
        const byContainer = {};
        const noFolders = [];
        const noCounts = {};
        export const useNotes = () => noNotes;
        export const useNotesByContainer = () => byContainer;
        export const useFolders = () => noFolders;
        export const useFolderCounts = () => noCounts;
        export const useSpaceRootCounts = () => noCounts;
        export const folderContainerKey = (id) => "f:" + id;
        export const ensureContainerLoaded = () => Promise.resolve();
      `,
      "/hooks/useContainerChat": "export const useContainerChat = () => ({});",
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
    space: {
      id: 2,
      kind: "team",
      name: "Design",
      cloud_space_id: "space-1",
      workspace_id: workspace.id,
      my_role: "admin",
      my_direct_role: "admin",
      teams: [],
      sync_status: "synced",
    },
    folder: null,
    onOpenNote: () => {},
    onNewNote: () => {},
  };
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(ContainerOverview, props)));
  return textOf(container);
}

test("a space admin who is only a workspace member gets no workspace invite", async (t) => {
  const text = await renderTeamSpaceOverview(t, "openwhispr-container-overview-invite-member-", {
    id: "ws-1",
    name: "Acme",
    role: "member",
  });
  assert.doesNotMatch(text, /notes\.overview\.invite/);
});

test("a workspace admin gets the workspace invite", async (t) => {
  const text = await renderTeamSpaceOverview(t, "openwhispr-container-overview-invite-admin-", {
    id: "ws-1",
    name: "Acme",
    role: "admin",
  });
  assert.match(text, /notes\.overview\.invite/);
});

test("the invite follows the server's manage_members over the role", async (t) => {
  const text = await renderTeamSpaceOverview(t, "openwhispr-container-overview-invite-caps-", {
    id: "ws-1",
    name: "Acme",
    role: "admin",
    capabilities: {
      manage_members: false,
      manage_teams: false,
      create_spaces: false,
      manage_settings: false,
      manage_billing: false,
      delete_workspace: false,
      transfer_ownership: false,
      leave: true,
    },
  });
  assert.doesNotMatch(text, /notes\.overview\.invite/);
});
