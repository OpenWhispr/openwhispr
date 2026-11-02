const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const SPACE = {
  id: "s1",
  name: "Design",
  workspace_id: "w1",
  cloud_space_id: "cloud-1",
  teams: [],
};

test("Upgrade from the Members tab closes the dialog, so it isn't left under Settings", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__panelProps;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-space-settings-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key, i18n: {} });`,
      "/ui/dialog": `
        import React from "react";
        const box = ({ children }) => React.createElement("div", null, children);
        export const Dialog = box;
        export const DialogContent = box;
        export const DialogHeader = box;
        export const DialogTitle = box;
        export const ConfirmDialog = () => null;
      `,
      "/ui/tabs": `
        import React from "react";
        const box = ({ children }) => React.createElement("div", null, children);
        export const Tabs = box;
        export const TabsList = box;
        export const TabsTrigger = box;
        export const TabsContent = box;
      `,
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/hooks/useAuth": `export const useAuth = () => ({ user: { id: "u1" } });`,
      "/services/spaceActions": `
        export const leaveSpace = async () => ({ success: true });
        export const leaveTeam = async () => ({ success: true });
        export const renameSpace = async () => ({ success: true });
      `,
      "/stores/workspaceStore": `export const useWorkspaceStore = (selector) => selector({ workspaces: [] });`,
      "/DeleteSpaceDialog": `export default function Mock() { return null; }`,
      "/SpaceNameField": `export default function Mock() { return null; }`,
      "/SpaceMembersPanel": `
        export default function Mock(props) {
          globalThis.__panelProps = props;
          return null;
        }
      `,
    },
  });
  const { default: SpaceSettingsDialog } = await vite.ssrLoadModule(
    "/components/notes/SpaceSettingsDialog.tsx"
  );
  const opens = [];
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(SpaceSettingsDialog, {
        space: SPACE,
        open: true,
        onOpenChange: (open) => opens.push(open),
        initialTab: "members",
      })
    )
  );

  await React.act(async () => globalThis.__panelProps.onOpeningBilling());

  assert.deepEqual(opens, [false]);
});

test("the members panel hands the invite dialog's Upgrade up to the space dialog", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__inviteProps;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-space-members-panel-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key, i18n: {} });`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/hooks/useAuth": `export const useAuth = () => ({ user: { id: "u1" } });`,
      "/hooks/useMemberRoster": `
        const empty = [];
        const busy = new Set();
        export const useMemberRoster = () => ({
          members: empty,
          loading: false,
          loadFailed: false,
          reload: async () => {},
          busyIds: busy,
          mutate: async () => {},
        });
      `,
      "/stores/workspaceStore": `
        const state = {
          workspaces: [{ id: "w1", name: "Acme", role: "owner" }],
          members: [],
          membersWorkspaceId: "w1",
          refreshMembers: async () => {},
        };
        export const useWorkspaceStore = (selector) => selector(state);
      `,
      "/services/SpacesService": `export const SpacesService = { listMembers: async () => [] };`,
      "/services/spaceActions": `
        export const addSpaceMembers = async () => {};
        export const removeSpaceMember = async () => {};
        export const setSpaceMemberRole = async () => {};
      `,
      "/MemberRoster": `export default function Mock() { return null; }`,
      "/SpaceGroupsSection": `export default function Mock() { return null; }`,
      "/InviteTeammateDialog": `
        export default function Mock(props) {
          globalThis.__inviteProps = props;
          return null;
        }
      `,
    },
  });
  const { default: SpaceMembersPanel } = await vite.ssrLoadModule(
    "/components/notes/SpaceMembersPanel.tsx"
  );
  const onOpeningBilling = () => {};
  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(SpaceMembersPanel, { space: SPACE, onOpeningBilling }))
  );

  assert.equal(globalThis.__inviteProps.onOpeningBilling, onOpeningBilling);
});
