const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

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

const team = (id, name) => ({ id, name });

// Roots mounted by each test. Unmounting is registered before the browser globals, so it runs
// while `window` still exists (after hooks run in the order they were added).
const mountedRoots = new Map();

async function loadMembersTab(t, { members = MEMBERS, refreshMembers } = {}) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-members-tab-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options) => (options && "count" in options ? key + "#" + options.count : key),
        });
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({
            members: globalThis.__workspaceMembers,
            refreshMembers: globalThis.__refreshMembers,
          });
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          listJoinRequests: async () => [],
        };
      `,
      "/hooks/useAuth": "export const useAuth = () => ({ user: globalThis.__authUser ?? null });",
      "/ui/useToast": "export const useToast = () => ({ toast: () => {} });",
      "/TransferOwnershipDialog": "export const TransferOwnershipDialog = () => null;",
      "/RemoveMemberDialog": "export const RemoveMemberDialog = () => null;",
      "/MemberAvatar": "export default function Mock() { return null; }",
      "/ui/dropdown-menu": `
        import React from "react";
        const h = React.createElement;
        const passThrough = ({ children }) => h(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuContent = passThrough;
        export const DropdownMenuRadioGroup = passThrough;
        export const DropdownMenuTrigger = ({ disabled }) =>
          h("button", { "data-member-actions": "", disabled });
        export const DropdownMenuRadioItem = ({ children }) =>
          h("div", { role: "menuitemradio" }, children);
        export const DropdownMenuSeparator = () => null;
        export const DropdownMenuItem = ({ children }) =>
          h("div", { role: "menuitem" }, children);
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceMembersTab.tsx");
  t.after(() => {
    delete globalThis.__workspaceMembers;
    delete globalThis.__refreshMembers;
    delete globalThis.__authUser;
  });
  globalThis.__workspaceMembers = members;
  globalThis.__refreshMembers = refreshMembers ?? (async () => {});
  return module.default;
}

// The markup of each member's row, from its name to the next member's name.
function rowsByName(markup, members = MEMBERS) {
  return Object.fromEntries(
    members.map((member, index) => {
      const start = markup.indexOf(member.name);
      const next = members[index + 1];
      const end = next ? markup.indexOf(next.name) : markup.length;
      assert.ok(start >= 0 && end > start, `row for ${member.name}`);
      return [member.role, markup.slice(start, end)];
    })
  );
}

function tabElement(WorkspaceMembersTab, workspace) {
  return React.createElement(WorkspaceMembersTab, {
    workspace,
    searchQuery: "",
    onSearchQueryChange: () => {},
  });
}

function render(WorkspaceMembersTab, workspace) {
  return renderToStaticMarkup(tabElement(WorkspaceMembersTab, workspace));
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

// Mounts the tab so its load effect runs, which the static render skips.
async function mount(t, WorkspaceMembersTab, workspace) {
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => {
    root.render(tabElement(WorkspaceMembersTab, workspace));
  });
  return container;
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
  assert.doesNotMatch(blocked, /settingsPage\.workspace\.members\.description/);

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

test("member view shows roles as text and no actions", async (t) => {
  const WorkspaceMembersTab = await loadMembersTab(t);
  globalThis.__authUser = { id: "u-member" };
  const markup = render(WorkspaceMembersTab, { ...WORKSPACE, role: "member" });
  const rows = rowsByName(markup);

  assert.doesNotMatch(markup, /data-member-actions/);
  assert.doesNotMatch(markup, /role="menuitem/);
  assert.doesNotMatch(markup, /settingsPage\.workspace\.members\.description/);
  assert.match(rows.owner, /settingsPage\.workspace\.role\.owner/);
  assert.match(rows.admin, /settingsPage\.workspace\.role\.admin/);
  assert.match(rows.member, /settingsPage\.workspace\.role\.member/);
  // Your own row carries the You pill, and only yours.
  assert.match(rows.member, /settingsPage\.workspace\.people\.you/);
  assert.doesNotMatch(rows.admin, /settingsPage\.workspace\.people\.you/);
  assert.match(markup, /settingsPage\.workspace\.people\.columns\.name/);
  assert.match(markup, /settingsPage\.workspace\.people\.columns\.role/);
});

test("team column shows two teams and a count", async (t) => {
  const members = [
    {
      ...MEMBERS[1],
      teams: [
        team("t1", "Sales"),
        team("t2", "Support"),
        team("t3", "Design"),
        team("t4", "Legal"),
      ],
    },
    { ...MEMBERS[2], teams: [] },
  ];
  const WorkspaceMembersTab = await loadMembersTab(t, { members });
  const markup = render(WorkspaceMembersTab, { ...WORKSPACE, role: "admin" });
  const rows = rowsByName(markup, members);

  assert.match(markup, /settingsPage\.workspace\.people\.columns\.team/);
  assert.match(rows.admin, /Sales · Support/);
  assert.match(rows.admin, /settingsPage\.workspace\.people\.teamsMore#2/);
  assert.match(rows.admin, /title="Sales · Support · Design · Legal"/);
  assert.match(rows.member, /settingsPage\.workspace\.people\.teamsNone/);
});

test("team column hides when the API sends no teams", async (t) => {
  const WorkspaceMembersTab = await loadMembersTab(t);
  const markup = render(WorkspaceMembersTab, { ...WORKSPACE, role: "admin" });

  assert.doesNotMatch(markup, /settingsPage\.workspace\.people\.columns\.team/);
  assert.doesNotMatch(markup, /settingsPage\.workspace\.people\.teamsNone/);
});

test("loading shows the loading copy", async (t) => {
  const WorkspaceMembersTab = await loadMembersTab(t, {
    members: [],
    refreshMembers: () => new Promise(() => {}),
  });
  const container = await mount(t, WorkspaceMembersTab, { ...WORKSPACE, role: "admin" });
  const text = textOf(container);

  assert.match(text, /settingsPage\.workspace\.people\.loading\.title/);
  assert.match(text, /settingsPage\.workspace\.people\.loading\.body/);
  assert.doesNotMatch(text, /settingsPage\.workspace\.people\.columns\.name/);
});

test("failed shows Try again", async (t) => {
  let calls = 0;
  const WorkspaceMembersTab = await loadMembersTab(t, {
    members: [],
    refreshMembers: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  const container = await mount(t, WorkspaceMembersTab, { ...WORKSPACE, role: "admin" });
  const text = textOf(container);

  assert.equal(calls, 1);
  assert.match(text, /settingsPage\.workspace\.people\.failed\.title/);
  assert.match(text, /settingsPage\.workspace\.people\.failed\.body/);
  assert.match(text, /workspaces\.exit\.tryAgain/);
  assert.doesNotMatch(text, /settingsPage\.workspace\.people\.columns\.name/);
});
