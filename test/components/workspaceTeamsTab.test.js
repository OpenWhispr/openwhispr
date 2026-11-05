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

const KEY = "settingsPage.workspace.teams";

const capabilities = ({ manageTeams, createTeams = true }) => ({
  manage_members: manageTeams,
  manage_teams: manageTeams,
  create_teams: createTeams,
  create_spaces: false,
  manage_settings: false,
  manage_billing: false,
  delete_workspace: false,
  transfer_ownership: false,
  leave: true,
});

// The role is deliberately not what decides anything: capabilities do.
const ADMIN = {
  id: "w1",
  name: "Acme",
  role: "admin",
  capabilities: capabilities({ manageTeams: true }),
};
const FREE_ADMIN = {
  id: "w1",
  name: "Acme",
  role: "owner",
  capabilities: capabilities({ manageTeams: true, createTeams: false }),
};
const MEMBER = {
  id: "w1",
  name: "Acme",
  role: "member",
  capabilities: capabilities({ manageTeams: false }),
};

const team = (id, name, overrides = {}) => ({
  id,
  workspace_id: "w1",
  name,
  slug: id,
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  member_count: 3,
  spaces: [],
  ...overrides,
});

const person = (id, name, email) => ({
  user_id: id,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  email,
  name,
  image: null,
});

const mountedRoots = new Map();

async function loadTab(t, { workspace = ADMIN, status = "ready", teams = [], stale = false } = {}) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-teams-tab-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/i18n": "export default { t: (key) => key };",
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options) =>
            options
              ? key + "|" + Object.entries(options).map(([name, value]) => name + "=" + value).join(",")
              : key,
        });
      `,
      "/hooks/useWorkspaceTeams": `
        export const useWorkspaceTeams = (workspaceId, enabled) => {
          globalThis.__teamsArgs = { workspaceId, enabled };
          return globalThis.__teamsState;
        };
      `,
      "/services/TeamsService": `
        export const TeamsService = {
          listMembers: (teamId) => {
            globalThis.__memberReads.push(teamId);
            return globalThis.__listMembers(teamId);
          },
        };
      `,
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
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
      "/TeamMembersDialog": `
        export default function TeamMembersDialog(props) {
          globalThis.__membersDialog = props;
          return null;
        }
      `,
      "/notes/SpaceNameField": `
        import React from "react";
        export const TileGlyph = ({ emoji, name }) =>
          React.createElement("span", { "data-glyph": emoji ?? name });
        export default function SpaceNameField() { return null; }
      `,
      "/MemberAvatar": `
        import React from "react";
        export default function MemberAvatar({ name, email }) {
          return React.createElement("span", { "data-avatar": name ?? email });
        }
      `,
      // Menus render open, so a test reads their items; their open handlers ride on a node.
      "/ui/popover": `
        import React from "react";
        const h = React.createElement;
        export const Popover = ({ children, onOpenChange }) =>
          h("div", { "data-popover": "", onToggle: onOpenChange }, children);
        export const PopoverTrigger = ({ children, "aria-label": label }) => h("button", { "data-trigger": "", "aria-label": label }, children);
        export const PopoverContent = ({ children }) => h("div", { "data-popover-content": "" }, children);
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceTeamsTab.tsx");
  t.after(() => {
    for (const name of [
      "__teamsState",
      "__teamsArgs",
      "__toasts",
      "__memberReads",
      "__listMembers",
      "__createDialog",
      "__paywallDialog",
      "__membersDialog",
      "__reloads",
    ]) {
      delete globalThis[name];
    }
  });
  globalThis.__reloads = 0;
  globalThis.__teamsState = {
    status,
    teams,
    stale,
    loads: 1,
    reload: async () => {
      globalThis.__reloads += 1;
      return teams;
    },
  };
  globalThis.__toasts = [];
  globalThis.__memberReads = [];
  globalThis.__listMembers = async () => [];
  const setState = (next) => {
    globalThis.__teamsState = { ...globalThis.__teamsState, ...next };
  };
  return { Tab: module.default, setState, workspace };
}

const tabElement = (Tab, workspace) => React.createElement(Tab, { workspace });

const render = (Tab, workspace) => renderToStaticMarkup(tabElement(Tab, workspace));

async function mount(t, Tab, workspace) {
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => {
    root.render(tabElement(Tab, workspace));
  });
  return container;
}

// The host DOM has no event dispatch, so a handler is read from the props React stores on a node.
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

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

const buttonWithText = (root, text) =>
  findNode(root, (node) => node.tagName === "BUTTON" && textOf(node).trim() === text);

const rowNode = (container, name) =>
  findNode(container, (node) => node.tagName === "TR" && textOf(node).includes(name));

function rowMarkup(markup, name) {
  const row = markup.split("<tr").find((chunk) => chunk.includes(name));
  assert.ok(row, `row for ${name}`);
  return row;
}

test("loading, failed and Try again", async (t) => {
  const { Tab, setState, workspace } = await loadTab(t, { status: "loading" });

  const loading = render(Tab, workspace);
  // The table frame and its headers stay while the rows load.
  assert.match(loading, /<table/);
  assert.match(loading, new RegExp(`${KEY}\\.columns\\.name`));
  assert.match(loading, new RegExp(`${KEY}\\.columns\\.members`));
  assert.match(loading, new RegExp(`${KEY}\\.columns\\.teamspaces`));
  assert.match(loading, new RegExp(`${KEY}\\.loadingTitle`));
  assert.match(loading, new RegExp(`${KEY}\\.loadingBody`));
  assert.doesNotMatch(loading, /type="checkbox"/);

  setState({ status: "failed" });
  const container = await mount(t, Tab, workspace);
  assert.match(textOf(container), new RegExp(`${KEY}\\.failedTitle`));
  assert.match(textOf(container), new RegExp(`${KEY}\\.failedBody`));
  const retry = buttonWithText(container, `${KEY}.retry`);
  assert.ok(retry, "the failed view offers Try again");
  assert.equal(globalThis.__reloads, 0);
  await React.act(async () => propsOf(retry).onClick());
  assert.equal(globalThis.__reloads, 1);
});

test("a failed reload keeps the rows and says the list may be out of date", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    teams: [team("t1", "Designers")],
    stale: true,
  });
  const markup = render(Tab, workspace);

  assert.match(markup, /Designers/);
  assert.match(markup, /settingsPage\.workspace\.teams\.refreshFailed/);
  assert.match(markup, /workspaces\.exit\.tryAgain/);
});

test("an admin sees the table with Create in the empty state", async (t) => {
  const { Tab, workspace } = await loadTab(t, { teams: [] });
  const empty = render(Tab, workspace);

  assert.doesNotMatch(empty, /<table/);
  assert.match(empty, new RegExp(`${KEY}\\.emptyTitle`));
  assert.match(empty, new RegExp(`${KEY}\\.emptyBody<`));
  assert.doesNotMatch(empty, new RegExp(`${KEY}\\.emptyBodyMember`));

  const container = await mount(t, Tab, workspace);
  const create = buttonWithText(container, `${KEY}.create`);
  assert.ok(create, "the empty state offers Create team");
  assert.equal(globalThis.__createDialog.open, false);
  await React.act(async () => propsOf(create).onClick());
  assert.equal(globalThis.__createDialog.open, true);
  assert.equal(globalThis.__createDialog.workspace, workspace);
  assert.equal(globalThis.__paywallDialog.open, false);
});

test("an admin's table has the three columns, no checkboxes and no Create", async (t) => {
  const { Tab, workspace } = await loadTab(t, { teams: [team("t1", "Designers")] });
  const markup = render(Tab, workspace);

  assert.match(markup, /<table/);
  assert.doesNotMatch(markup, /type="checkbox"/);
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.create<`));
  assert.match(rowMarkup(markup, "Designers"), /dir="auto"/);
});

test("a member sees no Create and their own empty copy", async (t) => {
  const { Tab, workspace } = await loadTab(t, { workspace: MEMBER, teams: [] });
  const markup = render(Tab, workspace);

  assert.match(markup, new RegExp(`${KEY}\\.emptyTitle`));
  assert.match(markup, new RegExp(`${KEY}\\.emptyBodyMember`));
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.create<`));
  assert.doesNotMatch(markup, /<button/);
});

test("a member sees the same table without Create", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    workspace: MEMBER,
    teams: [team("t1", "Designers")],
  });
  const markup = render(Tab, workspace);

  assert.match(markup, /Designers/);
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.create<`));
});

test("a free workspace's table and dialog stay fully working", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    workspace: FREE_ADMIN,
    teams: [team("t1", "Designers")],
  });
  const markup = render(Tab, workspace);

  assert.match(markup, /Designers/);
  assert.doesNotMatch(markup, /disabled/);
  assert.doesNotMatch(markup, /aria-disabled/);

  const container = await mount(t, Tab, workspace);
  assert.equal(globalThis.__membersDialog, undefined);
  await React.act(async () => propsOf(rowNode(container, "Designers")).onClick());
  assert.equal(globalThis.__membersDialog.open, true);
  assert.equal(globalThis.__membersDialog.team.id, "t1");

  // Closing reads the list again, since the dialog can change it.
  await React.act(async () => globalThis.__membersDialog.onOpenChange(false));
  assert.equal(globalThis.__reloads, 1);
});

test("a free workspace's empty state still offers Create, which the opener answers", async (t) => {
  const { Tab, workspace } = await loadTab(t, { workspace: FREE_ADMIN, teams: [] });
  assert.match(render(Tab, workspace), new RegExp(`${KEY}\\.create<`));

  const container = await mount(t, Tab, workspace);
  await React.act(async () => propsOf(buttonWithText(container, `${KEY}.create`)).onClick());
  assert.equal(globalThis.__paywallDialog.open, true);
  assert.equal(globalThis.__createDialog.open, false);
});

test("the server's refusal swaps the form for the paywall", async (t) => {
  const { Tab, workspace } = await loadTab(t, { teams: [] });
  const container = await mount(t, Tab, workspace);
  await React.act(async () => propsOf(buttonWithText(container, `${KEY}.create`)).onClick());
  assert.equal(globalThis.__createDialog.open, true);

  await React.act(async () => globalThis.__createDialog.onPlanRequired());
  assert.equal(globalThis.__createDialog.open, false);
  assert.equal(globalThis.__paywallDialog.open, true);
});

test("a created team reloads the list", async (t) => {
  const { Tab, workspace } = await loadTab(t, { teams: [] });
  await mount(t, Tab, workspace);

  await React.act(async () =>
    globalThis.__createDialog.onCreated({ id: "t1", name: "Sales" }, { memberCount: 2 })
  );
  assert.equal(globalThis.__reloads, 1);
});

test("a request from People opens the opener once and says it was handled", async (t) => {
  let handled = 0;
  const { Tab, workspace } = await loadTab(t, { teams: [team("t1", "Designers")] });
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () =>
    root.render(
      React.createElement(Tab, {
        workspace,
        openCreateRequested: true,
        onCreateRequestHandled: () => (handled += 1),
      })
    )
  );
  assert.equal(globalThis.__createDialog.open, true);
  assert.equal(handled, 1);
});

test("the tab says when no team exists", async (t) => {
  const reports = [];
  const { Tab, workspace } = await loadTab(t, { teams: [] });
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () =>
    root.render(React.createElement(Tab, { workspace, onTeamsEmptyChange: (e) => reports.push(e) }))
  );
  assert.equal(reports.at(-1), true);
});

test("the Members cell reads the roster only when opened", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    teams: [team("t1", "Designers"), team("t2", "Sales", { member_count: 1 })],
  });
  globalThis.__listMembers = async () => [
    person("u1", "Ethan", "kai@openronnie.com"),
    person("u2", null, "noah@openronnie.com"),
  ];
  const container = await mount(t, Tab, workspace);

  assert.deepEqual(globalThis.__memberReads, []);
  const row = rowNode(container, "Designers");
  assert.match(textOf(row), new RegExp(`${KEY}\\.people\\|count=3`));

  const popover = findNode(row, (node) => "onToggle" in propsOf(node));
  await React.act(async () => propsOf(popover).onToggle(true));
  assert.deepEqual(globalThis.__memberReads, ["t1"]);

  const open = textOf(findNode(row, (node) => "data-popover-content" in propsOf(node)));
  assert.match(open, /Ethan/);
  assert.match(open, /kai@openronnie\.com/);
  assert.match(open, /noah@openronnie\.com/);
  // The other team's row stays unread.
  assert.ok(!globalThis.__memberReads.includes("t2"));
});

test("a failed roster read shows a retry line in the popover", async (t) => {
  const { Tab, workspace } = await loadTab(t, { teams: [team("t1", "Designers")] });
  globalThis.__listMembers = async () => {
    throw new Error("offline");
  };
  const container = await mount(t, Tab, workspace);
  const row = rowNode(container, "Designers");
  const popover = findNode(row, (node) => "onToggle" in propsOf(node));
  await React.act(async () => propsOf(popover).onToggle(true));

  assert.match(textOf(row), new RegExp(`${KEY}\\.failedBody`));
  globalThis.__listMembers = async () => [person("u1", "Ethan", "kai@openronnie.com")];
  const retry = buttonWithText(row, `${KEY}.retry`);
  await React.act(async () => propsOf(retry).onClick());
  assert.deepEqual(globalThis.__memberReads, ["t1", "t1"]);
  assert.match(textOf(row), /Ethan/);
});

test("Teamspaces reads None, a name, or a count", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    teams: [
      team("t1", "Designers"),
      // An older API leaves the field out.
      team("t2", "Legacy", { spaces: undefined }),
      team("t3", "Sales", {
        spaces: [{ id: "s1", name: "Customer Calls", emoji: "📞", access: "member" }],
      }),
      team("t4", "Eng", {
        spaces: [
          { id: "s1", name: "Roadmap", emoji: "🗺", access: "member" },
          { id: "s2", name: "Incidents", emoji: null, access: "admin" },
        ],
      }),
    ],
  });
  const markup = render(Tab, workspace);

  assert.match(rowMarkup(markup, "Designers"), new RegExp(`${KEY}\\.spacesNone`));
  assert.match(rowMarkup(markup, "Legacy"), new RegExp(`${KEY}\\.spacesNone`));
  const one = rowMarkup(markup, "Sales");
  assert.match(one, /Customer Calls/);
  assert.doesNotMatch(one, new RegExp(`${KEY}\\.spaces\\|`));
  const many = rowMarkup(markup, "Eng");
  assert.match(many, new RegExp(`${KEY}\\.spaces\\|count=2`));
  assert.match(
    many,
    new RegExp(
      `aria-label="${KEY}\\.cellMenuLabel\\|team=\u2068Eng\u2069,value=${KEY}\\.spaces\\|count=2"`
    )
  );
  assert.match(
    rowMarkup(markup, "Designers"),
    new RegExp(
      `aria-label="${KEY}\\.cellMenuLabel\\|team=\u2068Designers\u2069,value=${KEY}\\.people\\|count=3"`
    )
  );
  assert.match(many, /Roadmap/);
  assert.match(many, /Incidents/);
  assert.match(many, /🗺/);
});

test("pressing a cell's menu doesn't open the dialog", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    teams: [
      team("t1", "Eng", {
        spaces: [
          { id: "s1", name: "Roadmap", emoji: null, access: "member" },
          { id: "s2", name: "Incidents", emoji: null, access: "admin" },
        ],
      }),
    ],
  });
  const container = await mount(t, Tab, workspace);
  const row = rowNode(container, "Eng");
  const cells = [...row.childNodes].filter((node) => node.tagName === "TD");

  for (const cell of cells.slice(1)) {
    let stopped = false;
    propsOf(cell).onClick({
      stopPropagation() {
        stopped = true;
      },
    });
    assert.ok(stopped, "the cell keeps its click off the row");
  }
  assert.equal(globalThis.__membersDialog, undefined);

  // The name is a real button, so the keyboard reaches the row.
  const name = findNode(row, (node) => node.tagName === "BUTTON" && textOf(node) === "Eng");
  assert.ok(name);
  await React.act(async () => propsOf(row).onClick());
  assert.equal(globalThis.__membersDialog.open, true);
});

test("a team with an emoji shows it in its tile", async (t) => {
  const { Tab, workspace } = await loadTab(t, { teams: [team("t1", "Sales", { emoji: "💼" })] });
  assert.match(render(Tab, workspace), /data-glyph="💼"/);
});
