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

const HOUR_MS = 60 * 60 * 1000;

const MEMBERS = [
  { user_id: "u1", name: "Olivia Owner", email: "Olivia@Example.com", role: "owner" },
  { user_id: "u2", name: "Mia Member", email: "mia@example.com", role: "member" },
];

const invitation = (email, expiresInMs) => ({
  id: `inv-${email}`,
  email,
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
});

const INVITATIONS = [
  invitation("Pending@Example.com", 48 * HOUR_MS),
  invitation("expired@example.com", -48 * HOUR_MS),
];

const ADMIN = { id: "w1", name: "Acme", role: "admin" };
const MEMBER = { id: "w1", name: "Acme", role: "member" };

const mountedRoots = new Map();

async function loadSection(t, { storedTab, realTeamsTab = false } = {}) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    initialStorage: storedTab ? { "settings.workspacePeopleTab": JSON.stringify(storedTab) } : {},
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-people-section-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({ t: (key) => key });
      `,
      "/stores/workspaceStore": `
        const state = () => ({
          workspaces: [globalThis.__workspace],
          members: globalThis.__roster,
          membersWorkspaceId: globalThis.__rosterWorkspaceId,
          refreshMembers: globalThis.__refreshMembers,
          refresh: async () => {},
        });
        export const useWorkspaceStore = (selector) => selector(state());
        useWorkspaceStore.getState = state;
      `,
      "/SettingsWorkspaceFrame": `
        export default function Frame({ children }) {
          return globalThis.__workspace ? children(globalThis.__workspace) : null;
        }
      `,
      "/useSettingsWorkspace": `
        export const useSettingsWorkspace = () => ({
          status: "ready",
          workspace: globalThis.__workspace,
          workspaces: [globalThis.__workspace],
          retry: () => {},
        });
      `,
      "/useWorkspaceInvitations": `
        export const useWorkspaceInvitations = (workspaceId, enabled) => {
          globalThis.__invitationsArgs = { workspaceId, enabled };
          return globalThis.__invitationsState;
        };
      `,
      "/WorkspaceMembersTab": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__membersProps = props;
          return React.createElement("div", { "data-tab-panel": "members" });
        }
      `,
      "/WorkspaceGuestsTab": `
        import React from "react";
        export default function Mock() {
          return React.createElement("div", { "data-tab-panel": "guests" });
        }
      `,
      "/WorkspaceInvitationsTab": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__invitationsTabProps = props;
          return React.createElement("div", { "data-tab-panel": "invitations" });
        }
      `,
      ...(realTeamsTab
        ? {
            "/i18n": "export default { t: (key) => key };",
            "/services/TeamsService": "export const TeamsService = {};",
            "/hooks/useWorkspaceTeams": `
              export const useWorkspaceTeams = () => ({
                status: "ready",
                teams: [],
                stale: false,
                loads: 1,
                reload: async () => [],
              });
            `,
            "/CreateTeamDialog": `
              export default function CreateTeamDialog(props) {
                globalThis.__createDialog = props;
                return null;
              }
            `,
            "/TeamPaywallDialog": `
              export default function TeamPaywallDialog(props) {
                globalThis.__paywallDialog = props;
                return null;
              }
            `,
            "/TeamSettingsDialog": "export default function TeamSettingsDialog() { return null; }",
            "/ui/useToast": "export const useToast = () => ({ toast: () => {} });",
          }
        : {
            "/WorkspaceTeamsTab": `
              import React from "react";
              export default function Mock(props) {
                globalThis.__teamsTabProps = props;
                return React.createElement("div", { "data-tab-panel": "teams" });
              }
            `,
          }),
      // Menus render open, so a test reads their items; their handlers ride on the nodes.
      "/ui/dropdown-menu": `
        import React from "react";
        const h = React.createElement;
        export const DropdownMenu = ({ children }) => h("div", { "data-menu": "" }, children);
        export const DropdownMenuTrigger = ({ children }) => children;
        export const DropdownMenuContent = ({ children }) => h("div", { "data-menu-content": "" }, children);
        export const DropdownMenuItem = ({ children, onSelect }) =>
          h("button", { "data-menu-item": "", onClick: onSelect }, children);
      `,
      "/InviteTeammateDialog": `
        import React from "react";
        import InviteTeammateDialog from "/components/InviteTeammateDialog.tsx";
        export default function Mock(props) {
          globalThis.__dialogProps = props;
          return React.createElement(InviteTeammateDialog, props);
        }
      `,
      "/InvitePeopleView": `
        export function InvitePeopleView(props) {
          globalThis.__inviteViewProps = props;
          return null;
        }
      `,
      "/ui/dialog": `
        export const Dialog = ({ children }) => children;
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = { previewSeats: async () => null };
      `,
      "/services/invitePeople": `
        export const invitePeople = {
          sendInvitations: async (input) => {
            globalThis.__sendCalls.push(input.emails);
            for (const email of input.emails) {
              input.onResult(email, { ok: true, emailSent: true });
            }
          },
        };
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspacePeopleSection.tsx");
  const reload = async () => {
    globalThis.__reloadCalls = (globalThis.__reloadCalls ?? 0) + 1;
  };
  t.after(() => {
    for (const key of [
      "__roster",
      "__rosterWorkspaceId",
      "__refreshMembers",
      "__refreshMembersCalls",
      "__workspace",
      "__invitationsArgs",
      "__invitationsState",
      "__membersProps",
      "__invitationsTabProps",
      "__dialogProps",
      "__inviteViewProps",
      "__sendCalls",
      "__reloadCalls",
      "__teamsTabProps",
      "__createDialog",
      "__paywallDialog",
    ]) {
      delete globalThis[key];
    }
  });
  globalThis.__roster = MEMBERS;
  globalThis.__rosterWorkspaceId = "w1";
  globalThis.__refreshMembersCalls = [];
  globalThis.__refreshMembers = async (workspaceId) => {
    globalThis.__refreshMembersCalls.push(workspaceId);
  };
  globalThis.__reloadCalls = 0;
  globalThis.__sendCalls = [];
  globalThis.__invitationsState = {
    status: "ready",
    invitations: INVITATIONS,
    reload,
  };
  return module.default;
}

function render(WorkspacePeopleSection, workspace, props = {}) {
  globalThis.__workspace = workspace;
  return renderToStaticMarkup(React.createElement(WorkspacePeopleSection, props));
}

function tabLabels(markup) {
  return [...markup.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((match) => match[1]);
}

function findNode(node, predicate) {
  if (node.nodeType === 1 && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function propsOf(node) {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

async function mount(t, WorkspacePeopleSection, workspace, props = {}) {
  globalThis.__workspace = workspace;
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => {
    root.render(React.createElement(WorkspacePeopleSection, props));
  });
  return container;
}

test("member sees Members, Guests and Teams, with the view subtitle", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, MEMBER);

  assert.deepEqual(tabLabels(markup), [
    "settingsPage.workspace.tab.members",
    "settingsPage.workspace.tab.guests",
    "settingsPage.workspace.tab.teams",
  ]);
  assert.match(markup, /settingsPage\.workspace\.people\.subtitleView/);
  assert.doesNotMatch(markup, /settingsPage\.workspace\.people\.description/);
  assert.equal(globalThis.__invitationsArgs.enabled, false);
});

test("Guests sits between Invitations and Teams", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, ADMIN);

  assert.deepEqual(tabLabels(markup), [
    "settingsPage.workspace.tab.members",
    "settingsPage.workspace.tab.invitations",
    "settingsPage.workspace.tab.guests",
    "settingsPage.workspace.tab.teams",
  ]);
  assert.match(markup, /settingsPage\.workspace\.people\.description/);
  assert.doesNotMatch(markup, /settingsPage\.workspace\.people\.subtitleView/);
  assert.deepEqual(globalThis.__invitationsArgs, { workspaceId: "w1", enabled: true });
});

test("a stored invitations tab falls back to members without manage_members", async (t) => {
  const Section = await loadSection(t, { storedTab: "invitations" });
  const memberMarkup = render(Section, MEMBER);

  assert.match(memberMarkup, /data-tab-panel="members"/);
  assert.doesNotMatch(memberMarkup, /data-tab-panel="invitations"/);
  // The stored choice survives, so the same person lands on Invitations once they can manage.
  assert.equal(localStorage.getItem("settings.workspacePeopleTab"), '"invitations"');

  const adminMarkup = render(Section, ADMIN);
  assert.match(adminMarkup, /data-tab-panel="invitations"/);
  assert.equal(globalThis.__invitationsTabProps.invitations, globalThis.__invitationsState);
});

test("a stored guests tab reopens it, for members too", async (t) => {
  const Section = await loadSection(t, { storedTab: "guests" });
  assert.match(render(Section, MEMBER), /data-tab-panel="guests"/);
  assert.match(render(Section, ADMIN), /data-tab-panel="guests"/);
});

test("a deep-linked invitations tab shows members without manage_members", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, MEMBER, { initialSubTab: "invitations" });
  assert.match(markup, /data-tab-panel="members"/);
});

test("Add appears only with manage_members", async (t) => {
  const Section = await loadSection(t);

  const adminMarkup = render(Section, ADMIN);
  assert.match(adminMarkup, /title="settingsPage\.workspace\.people\.addLabel"/);
  assert.match(adminMarkup, /settingsPage\.workspace\.people\.add</);
  assert.ok(globalThis.__dialogProps, "the dialog is rendered for admins");

  delete globalThis.__dialogProps;
  const memberMarkup = render(Section, MEMBER);
  assert.doesNotMatch(memberMarkup, /settingsPage\.workspace\.people\.addLabel/);
  assert.equal(globalThis.__dialogProps, undefined);
});

test("the Members tab is told where Open teamspace goes", async (t) => {
  const Section = await loadSection(t);
  const onOpenTeamspace = () => {};

  render(Section, ADMIN, { onOpenTeamspace });
  assert.equal(globalThis.__membersProps.onOpenTeamspace, onOpenTeamspace);
});

test("Add hands the roster and pending invitations to the invite dialog", async (t) => {
  const Section = await loadSection(t);
  render(Section, ADMIN);

  assert.equal(globalThis.__dialogProps.workspaceId, "w1");
  assert.equal(globalThis.__dialogProps.workspaceName, "Acme");
  assert.equal(globalThis.__dialogProps.open, false);
  assert.deepEqual(globalThis.__dialogProps.knownEmails, {
    members: ["olivia@example.com", "mia@example.com"],
    invited: ["pending@example.com"],
  });
});

test("inviting reloads the list and closing the dialog afterwards opens Invitations", async (t) => {
  const Section = await loadSection(t);
  const container = await mount(t, Section, ADMIN);

  const addButton = findNode(
    container,
    (node) => node.getAttribute?.("title") === "settingsPage.workspace.people.addLabel"
  );
  assert.ok(addButton, "Add button");
  await React.act(async () => propsOf(addButton).onClick());
  assert.equal(globalThis.__dialogProps.open, true);

  await React.act(async () => {
    globalThis.__dialogProps.onInvited(["new@example.com"]);
    globalThis.__dialogProps.onInvitationsChanged();
  });
  assert.equal(globalThis.__reloadCalls, 1);
  await React.act(async () => globalThis.__dialogProps.onOpenChange(false));

  assert.ok(findNode(container, (node) => node.getAttribute?.("data-tab-panel") === "invitations"));
  assert.equal(localStorage.getItem("settings.workspacePeopleTab"), '"invitations"');
});

test("a send that found invitations already there reloads the list and keeps the current tab", async (t) => {
  const Section = await loadSection(t);
  const container = await mount(t, Section, ADMIN);

  const addButton = findNode(
    container,
    (node) => node.getAttribute?.("title") === "settingsPage.workspace.people.addLabel"
  );
  await React.act(async () => propsOf(addButton).onClick());

  await React.act(async () => globalThis.__dialogProps.onInvitationsChanged());
  assert.equal(globalThis.__reloadCalls, 1);
  await React.act(async () => globalThis.__dialogProps.onOpenChange(false));

  assert.ok(findNode(container, (node) => node.getAttribute?.("data-tab-panel") === "members"));
  assert.equal(localStorage.getItem("settings.workspacePeopleTab"), '"members"');
});

test("closing the dialog without inviting anyone keeps the current tab", async (t) => {
  const Section = await loadSection(t);
  const container = await mount(t, Section, ADMIN);

  const addButton = findNode(
    container,
    (node) => node.getAttribute?.("title") === "settingsPage.workspace.people.addLabel"
  );
  await React.act(async () => propsOf(addButton).onClick());
  await React.act(async () => globalThis.__dialogProps.onOpenChange(false));

  assert.ok(findNode(container, (node) => node.getAttribute?.("data-tab-panel") === "members"));
  assert.equal(
    findNode(container, (node) => node.getAttribute?.("data-tab-panel") === "invitations"),
    null
  );
});

test("a roster the store holds for another workspace isn't handed to the invite dialog", async (t) => {
  const Section = await loadSection(t);
  globalThis.__rosterWorkspaceId = "w-previous";
  render(Section, ADMIN);

  assert.equal(globalThis.__dialogProps.knownEmails, undefined);
});

async function openAdd(container) {
  const addButton = findNode(
    container,
    (node) => node.getAttribute?.("title") === "settingsPage.workspace.people.addLabel"
  );
  await React.act(async () => propsOf(addButton).onClick());
}

for (const [name, rosterWorkspaceId, status, stale, existing] of [
  ["unloaded members", null, "ready", false, "mia@example.com"],
  ["another workspace's members", "w-previous", "ready", false, "mia@example.com"],
  ["loading invitations", "w1", "loading", false, "pending@example.com"],
  ["failed invitations", "w1", "failed", false, "pending@example.com"],
  ["stale invitations", "w1", "ready", true, "pending@example.com"],
]) {
  test(`a valid mixed batch near the ceiling sends with ${name}`, async (t) => {
    const Section = await loadSection(t, { storedTab: "invitations" });
    globalThis.__rosterWorkspaceId = rosterWorkspaceId;
    globalThis.__invitationsState = {
      ...globalThis.__invitationsState,
      status,
      stale,
      invitations: status === "ready" && !stale ? INVITATIONS : [],
    };
    const container = await mount(t, Section, { ...ADMIN, seats_used: 499, seat_limit: 500 });
    await openAdd(container);
    await React.act(async () =>
      globalThis.__inviteViewProps.dispatch({
        type: "draft",
        text: `${existing}, new@example.com,`,
      })
    );

    await React.act(async () => globalThis.__inviteViewProps.onSend());

    assert.deepEqual(globalThis.__sendCalls, [[existing, "new@example.com"]]);
  });
}

test("complete rosters skip existing addresses and enforce the ceiling for new ones", async (t) => {
  const Section = await loadSection(t);
  const container = await mount(t, Section, { ...ADMIN, seats_used: 499, seat_limit: 500 });
  await openAdd(container);
  await React.act(async () =>
    globalThis.__inviteViewProps.dispatch({
      type: "draft",
      text: "mia@example.com, new@example.com, extra@example.com,",
    })
  );
  await React.act(async () => globalThis.__inviteViewProps.onSend());
  assert.deepEqual(globalThis.__sendCalls, []);

  await React.act(async () =>
    globalThis.__inviteViewProps.dispatch({ type: "remove", email: "extra@example.com" })
  );
  await React.act(async () => globalThis.__inviteViewProps.onSend());

  assert.deepEqual(globalThis.__sendCalls, [["new@example.com"]]);
});

test("opening Add reads the roster when the store doesn't hold this workspace's", async (t) => {
  const Section = await loadSection(t, { storedTab: "invitations" });
  globalThis.__rosterWorkspaceId = null;
  globalThis.__refreshMembers = async (workspaceId) => {
    globalThis.__refreshMembersCalls.push(workspaceId);
    throw new Error("offline");
  };
  const container = await mount(t, Section, ADMIN);
  assert.deepEqual(globalThis.__refreshMembersCalls, []);

  // A failed read leaves flagging to the server's already_member answer.
  await openAdd(container);
  assert.deepEqual(globalThis.__refreshMembersCalls, ["w1"]);
  assert.equal(globalThis.__dialogProps.open, true);
});

test("opening Add keeps a roster the store already holds for this workspace", async (t) => {
  const Section = await loadSection(t, { storedTab: "invitations" });
  const container = await mount(t, Section, ADMIN);

  await openAdd(container);
  assert.deepEqual(globalThis.__refreshMembersCalls, []);
});

test("Add sits beside the tab list, not inside it", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, ADMIN);

  const tablist = markup.match(/<div role="tablist"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(tablist, "tab list");
  assert.doesNotMatch(tablist[1], /settingsPage\.workspace\.people\.addLabel/);
  assert.match(markup, /title="settingsPage\.workspace\.people\.addLabel"/);
  // The visible "Add" is the button's accessible name, as voice control users say it.
  assert.doesNotMatch(markup, /aria-label="settingsPage\.workspace\.people\.addLabel"/);
});

test("Add wraps under the tabs rather than scroll a narrow pane sideways", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, ADMIN);

  const row = markup.match(/<div class="([^"]*)"><div role="tablist"/);
  assert.ok(row, "the row holding the tab list and Add");
  assert.ok(row[1].split(" ").includes("flex-wrap"));
});

// A workspace whose capabilities come from the server: the role is never what decides.
const withCapabilities = (overrides) => ({
  ...ADMIN,
  capabilities: {
    manage_members: true,
    manage_teams: true,
    create_teams: true,
    create_spaces: true,
    manage_settings: true,
    manage_billing: false,
    delete_workspace: false,
    transfer_ownership: false,
    leave: true,
    ...overrides,
  },
});

const menuItems = (container) => {
  const items = [];
  const walk = (node) => {
    if (node.nodeType === 1 && node.getAttribute?.("data-menu-item") === "") items.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(container);
  return items;
};
const itemTexts = (container) => menuItems(container).map((node) => textOfNode(node));
const textOfNode = (node) =>
  node.nodeType === 3 ? node.nodeValue : [...node.childNodes].map(textOfNode).join("");

test("every Create entry point opens the paywall below Business", async (t) => {
  const Section = await loadSection(t, { realTeamsTab: true });
  const container = await mount(t, Section, withCapabilities({ create_teams: false }));

  assert.deepEqual(itemTexts(container), [
    "settingsPage.workspace.people.addMenu.invite",
    "settingsPage.workspace.people.addMenu.createTeam",
  ]);
  const create = menuItems(container)[1];
  await React.act(async () => propsOf(create).onClick());

  assert.equal(localStorage.getItem("settings.workspacePeopleTab"), '"teams"');
  assert.equal(globalThis.__paywallDialog.open, true);
  assert.equal(globalThis.__createDialog.open, false);
});

test("every Create entry point opens the form on Business", async (t) => {
  const Section = await loadSection(t, { realTeamsTab: true });
  const container = await mount(t, Section, withCapabilities({}));

  await React.act(async () => propsOf(menuItems(container)[1]).onClick());

  assert.equal(localStorage.getItem("settings.workspacePeopleTab"), '"teams"');
  assert.equal(globalThis.__createDialog.open, true);
  assert.equal(globalThis.__paywallDialog.open, false);
});

test("the label still invites and the chevron holds the menu", async (t) => {
  const Section = await loadSection(t);
  const container = await mount(t, Section, withCapabilities({}));

  const chevron = findNode(
    container,
    (node) => node.getAttribute?.("aria-label") === "settingsPage.workspace.people.addMenu.label"
  );
  assert.ok(chevron, "the chevron is labelled");
  const label = findNode(
    container,
    (node) => node.getAttribute?.("title") === "settingsPage.workspace.people.addLabel"
  );
  await React.act(async () => propsOf(label).onClick());
  assert.equal(globalThis.__dialogProps.open, true);

  // Invite people from the menu does the same.
  await React.act(async () => globalThis.__dialogProps.onOpenChange(false));
  await React.act(async () => propsOf(menuItems(container)[0]).onClick());
  assert.equal(globalThis.__dialogProps.open, true);
});

test("a member has no Create", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, MEMBER);

  assert.doesNotMatch(markup, /addMenu/);
  assert.doesNotMatch(markup, /data-menu/);
  const container = await mount(
    t,
    Section,
    withCapabilities({ manage_members: false, manage_teams: false })
  );
  assert.deepEqual(itemTexts(container), []);
});

test("the menu is gone on the Teams tab while no team exists", async (t) => {
  const Section = await loadSection(t, { storedTab: "teams" });
  const container = await mount(t, Section, withCapabilities({}));
  assert.equal(itemTexts(container).length, 2);

  await React.act(async () => globalThis.__teamsTabProps.onTeamsEmptyChange(true));
  assert.deepEqual(itemTexts(container), []);
  assert.equal(
    findNode(
      container,
      (node) => node.getAttribute?.("title") === "settingsPage.workspace.people.addLabel"
    ),
    null,
    "the empty state has its own Create"
  );
});
