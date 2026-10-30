const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MEMBERS = [
  { user_id: "u-owner", name: "Olivia Owner", email: "olivia@example.com", role: "owner" },
  { user_id: "u-admin", name: "Adam Admin", email: "adam@example.com", role: "admin" },
  { user_id: "u-member", name: "Mia Member", email: "mia@example.com", role: "member" },
];

const WORKSPACE = {
  id: "w1",
  name: "Acme",
  seats: 5,
};

async function loadMembersTab(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-members-tab-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({ members: globalThis.__workspaceMembers, refreshMembers: async () => {}, refresh: async () => {} });
      `,
      "/services/WorkspacesService": "export const WorkspacesService = {};",
      "/services/InvitationsService": "export const InvitationsService = {};",
      "/hooks/useDialogs": `
        export const useDialogs = () => ({
          confirmDialog: { open: false },
          showConfirmDialog: () => {},
          hideConfirmDialog: () => {},
        });
      `,
      "/ui/useToast": "export const useToast = () => ({ toast: () => {} });",
      "/ui/dialog": "export const ConfirmDialog = () => null;",
      "/InviteTeammateDialog": "export default function Mock() { return null; }",
      "/MemberAvatar": "export default function Mock() { return null; }",
      "/ui/dropdown-menu": `
        import React from "react";
        const passThrough = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuContent = passThrough;
        export const DropdownMenuTrigger = () =>
          React.createElement("button", { "data-member-actions": "" });
        export const DropdownMenuItem = ({ children }) =>
          React.createElement("div", { role: "menuitem" }, children);
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceMembersTab.tsx");
  t.after(() => {
    delete globalThis.__workspaceMembers;
  });
  globalThis.__workspaceMembers = MEMBERS;
  return module.default;
}

// The markup of each member's row, from its name to the next member's name.
function rowsByName(markup) {
  return Object.fromEntries(
    MEMBERS.map((member, index) => {
      const start = markup.indexOf(member.name);
      const next = MEMBERS[index + 1];
      const end = next ? markup.indexOf(next.name) : markup.length;
      assert.ok(start >= 0 && end > start, `row for ${member.name}`);
      return [member.role, markup.slice(start, end)];
    })
  );
}

function render(WorkspaceMembersTab, workspace) {
  return renderToStaticMarkup(React.createElement(WorkspaceMembersTab, { workspace }));
}

test("admin keeps actions on other admins", async (t) => {
  const WorkspaceMembersTab = await loadMembersTab(t);
  const markup = render(WorkspaceMembersTab, { ...WORKSPACE, role: "admin" });
  const rows = rowsByName(markup);

  assert.doesNotMatch(rows.owner, /data-member-actions/);
  assert.match(rows.admin, /data-member-actions/);
  assert.match(rows.member, /data-member-actions/);
  // Only the owner can hand ownership over.
  assert.doesNotMatch(markup, /settingsPage\.workspace\.members\.transferOwnership/);
});

test("member actions follow the server's capabilities, not the viewer's role name", async (t) => {
  const WorkspaceMembersTab = await loadMembersTab(t);
  const capabilities = (granted) => ({
    manage_members: granted,
    manage_teams: granted,
    create_spaces: granted,
    manage_settings: granted,
    manage_billing: granted,
    delete_workspace: granted,
    transfer_ownership: granted,
    leave: !granted,
  });

  // An owner whose session doesn't satisfy Require SSO manages nobody.
  const blocked = render(WorkspaceMembersTab, {
    ...WORKSPACE,
    role: "owner",
    capabilities: capabilities(false),
  });
  assert.doesNotMatch(blocked, /data-member-actions/);
  assert.doesNotMatch(blocked, /settingsPage\.workspace\.members\.invite"?</);

  const granted = render(WorkspaceMembersTab, {
    ...WORKSPACE,
    role: "member",
    capabilities: capabilities(true),
  });
  const rows = rowsByName(granted);
  assert.doesNotMatch(rows.owner, /data-member-actions/);
  assert.match(rows.admin, /data-member-actions/);
  assert.match(rows.admin, /settingsPage\.workspace\.members\.transferOwnership/);
});
