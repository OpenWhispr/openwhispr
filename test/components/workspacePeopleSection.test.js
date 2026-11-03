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

async function loadSection(t, { storedTab } = {}) {
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
        export const useWorkspaceStore = (selector) =>
          selector({
            members: globalThis.__roster,
            membersWorkspaceId: globalThis.__rosterWorkspaceId,
            refreshMembers: globalThis.__refreshMembers,
          });
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
      "/WorkspaceInvitationsTab": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__invitationsTabProps = props;
          return React.createElement("div", { "data-tab-panel": "invitations" });
        }
      `,
      "/WorkspaceTeamsTab": `
        import React from "react";
        export default function Mock() {
          return React.createElement("div", { "data-tab-panel": "teams" });
        }
      `,
      "/InviteTeammateDialog": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__dialogProps = props;
          return React.createElement("div", { "data-invite-dialog": String(props.open) });
        }
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
      "__reloadCalls",
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

async function mount(t, WorkspacePeopleSection, workspace) {
  globalThis.__workspace = workspace;
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => {
    root.render(React.createElement(WorkspacePeopleSection));
  });
  return container;
}

test("member sees Members and Groups only, with the view subtitle", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, MEMBER);

  assert.deepEqual(tabLabels(markup), [
    "settingsPage.workspace.tab.members",
    "settingsPage.workspace.tab.teams",
  ]);
  assert.match(markup, /settingsPage\.workspace\.people\.subtitleView/);
  assert.doesNotMatch(markup, /settingsPage\.workspace\.people\.description/);
  assert.equal(globalThis.__invitationsArgs.enabled, false);
});

test("admin sees Invitations between Members and Groups", async (t) => {
  const Section = await loadSection(t);
  const markup = render(Section, ADMIN);

  assert.deepEqual(tabLabels(markup), [
    "settingsPage.workspace.tab.members",
    "settingsPage.workspace.tab.invitations",
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

  await React.act(async () => globalThis.__dialogProps.onInvited(["new@example.com"]));
  assert.equal(globalThis.__reloadCalls, 1);
  await React.act(async () => globalThis.__dialogProps.onOpenChange(false));

  assert.ok(findNode(container, (node) => node.getAttribute?.("data-tab-panel") === "invitations"));
  assert.equal(localStorage.getItem("settings.workspacePeopleTab"), '"invitations"');
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

  assert.deepEqual(globalThis.__dialogProps.knownEmails.members, []);
});

async function openAdd(container) {
  const addButton = findNode(
    container,
    (node) => node.getAttribute?.("title") === "settingsPage.workspace.people.addLabel"
  );
  await React.act(async () => propsOf(addButton).onClick());
}

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
