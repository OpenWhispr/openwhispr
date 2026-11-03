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

const KEY = "settingsPage.workspace.teamspaces";

const capabilities = (createSpaces) => ({
  manage_members: false,
  manage_teams: false,
  create_spaces: createSpaces,
  manage_settings: false,
  manage_billing: false,
  delete_workspace: false,
  transfer_ownership: false,
  leave: true,
});

// The role is deliberately not what decides anything: capabilities do.
const ADMIN = { id: "w1", name: "Acme", role: "admin", capabilities: capabilities(true) };
const MEMBER = { id: "w1", name: "Acme", role: "member", capabilities: capabilities(false) };

const contact = (userId, name, email = `${userId}@example.com`) => ({
  user_id: userId,
  name,
  email,
  image: null,
});

// A directory row the way the current API sends it; tests override what they care about.
const space = (id, name, overrides = {}) => ({
  id,
  workspace_id: "w1",
  name,
  description: null,
  emoji: null,
  member_count: 3,
  teams: [],
  is_default: false,
  is_open: false,
  admins: [contact(`admin-${id}`, `Admin of ${name}`)],
  my_role: null,
  my_direct_role: null,
  capabilities: null,
  can_join: false,
  sole_admin: false,
  ...overrides,
});

const ME = { id: "me", name: "Ronnie", email: "ronnie@openronnie.com", image: null };

const mountedRoots = new Map();
const servers = new Map();

async function loadSection(
  t,
  { workspace = ADMIN, status = "ready", spaces = [], localIds = {}, mirror = [] } = {}
) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-teamspaces-section-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/i18n": "export default { t: (key) => key };",
      // The key, then the values it was given, so a test sees both without the real strings.
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options) =>
            options
              ? key + "|" + Object.entries(options).map(([name, value]) => name + "=" + value).join(",")
              : key,
        });
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({
            members: globalThis.__roster,
            membersWorkspaceId: globalThis.__rosterWorkspaceId,
            refreshMembers: (...args) => globalThis.__refreshMembers(...args),
          });
      `,
      "/stores/noteStore": `
        export const useSpaces = () => globalThis.__mirror;
        export const getSpacesValue = () => globalThis.__mirror;
        export const loadSpaces = async () => globalThis.__mirror;
      `,
      "/SettingsWorkspaceFrame": `
        export default function Frame({ children }) {
          return children(globalThis.__workspace);
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
      "/hooks/useWorkspaceSpaces": `
        export const useWorkspaceSpaces = (workspaceId, enabled) => {
          globalThis.__directoryArgs = { workspaceId, enabled };
          return globalThis.__directory;
        };
      `,
      "/hooks/useAuth": "export const useAuth = () => ({ user: globalThis.__authUser });",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/services/spaceActions": `
        export const joinSpace = (id) => globalThis.__joinSpace(id);
        export const localSpaceIdFor = (id) => globalThis.__localSpaceIdFor(id);
      `,
      "/notes/CreateSpaceDialog": `
        export default function CreateSpaceDialog(props) {
          globalThis.__createDialog = props;
          return null;
        }
      `,
      "/notes/SpaceSettingsDialog": `
        export default function SpaceSettingsDialog(props) {
          globalThis.__settingsDialog = props;
          return null;
        }
      `,
      "/notes/DeleteSpaceDialog": `
        export default function DeleteSpaceDialog(props) {
          globalThis.__deleteDialog = props;
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
        export const PopoverTrigger = ({ children }) => h("button", { "data-trigger": "" }, children);
        export const PopoverContent = ({ children }) => h("div", { "data-popover-content": "" }, children);
      `,
      "/ui/dropdown-menu": `
        import React from "react";
        const h = React.createElement;
        const passThrough = ({ children }) => h(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuContent = passThrough;
        export const DropdownMenuTrigger = ({ children }) =>
          h("button", { "data-row-actions": "" }, children);
        export const DropdownMenuItem = ({ children, onSelect }) =>
          h("div", { role: "menuitem", onClick: onSelect }, children);
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceTeamspacesSection.tsx");
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");
  servers.set(t, vite);
  t.after(() => {
    servers.delete(t);
    for (const name of [
      "__workspace",
      "__directory",
      "__directoryArgs",
      "__authUser",
      "__toasts",
      "__roster",
      "__rosterWorkspaceId",
      "__refreshMembers",
      "__joinSpace",
      "__localSpaceIdFor",
      "__mirror",
      "__createDialog",
      "__settingsDialog",
      "__deleteDialog",
      "__reloads",
      "__localLookups",
    ]) {
      delete globalThis[name];
    }
  });
  globalThis.__workspace = workspace;
  globalThis.__reloads = 0;
  globalThis.__directory = {
    status,
    spaces,
    stale: false,
    reload: async () => {
      globalThis.__reloads += 1;
      return spaces;
    },
  };
  globalThis.__authUser = ME;
  globalThis.__toasts = [];
  globalThis.__roster = [];
  globalThis.__rosterWorkspaceId = "w1";
  globalThis.__refreshMembers = async () => {};
  globalThis.__joinSpace = async () => ({ joined: true });
  globalThis.__localLookups = [];
  globalThis.__localSpaceIdFor = async (cloudSpaceId) => {
    globalThis.__localLookups.push(cloudSpaceId);
    return localIds[cloudSpaceId] ?? null;
  };
  globalThis.__mirror = mirror;
  // What the page reads on its next render, for tests that look at more than one state.
  const setState = ({ workspace: nextWorkspace, status: nextStatus, spaces: nextSpaces }) => {
    if (nextWorkspace) globalThis.__workspace = nextWorkspace;
    if (nextStatus || nextSpaces) {
      globalThis.__directory = {
        ...globalThis.__directory,
        status: nextStatus ?? globalThis.__directory.status,
        spaces: nextSpaces ?? globalThis.__directory.spaces,
      };
    }
  };
  return { Section: module.default, CloudApiError, setState };
}

function sectionElement(Section, { onOpenTeamspace } = {}) {
  return React.createElement(Section, { onOpenTeamspace });
}

function render(Section, props) {
  return renderToStaticMarkup(sectionElement(Section, props));
}

async function mount(t, Section, props) {
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => {
    root.render(sectionElement(Section, props));
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

function findNodes(node, predicate, found = []) {
  if (node.nodeType === 1 && predicate(node)) found.push(node);
  for (const child of node.childNodes ?? []) findNodes(child, predicate, found);
  return found;
}

function propsOf(node) {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

const rowNode = (container, name) =>
  findNode(container, (node) => node.tagName === "TR" && textOf(node).includes(name));

const buttonWithText = (root, text) =>
  findNode(root, (node) => node.tagName === "BUTTON" && textOf(node).trim() === text);

const noEvent = { stopPropagation() {} };

// The markup of the table row for a name, from its <tr to the next one.
function rowMarkup(markup, name) {
  const row = markup.split("<tr").find((chunk) => chunk.includes(name));
  assert.ok(row, `row for ${name}`);
  return row;
}

test("loading, failed with a working retry, and empty states", async (t) => {
  const { Section, setState } = await loadSection(t, { status: "loading" });

  const loading = render(Section);
  // The table frame and its headers stay while the rows load.
  assert.match(loading, /<table/);
  assert.match(loading, new RegExp(`${KEY}\\.columns\\.name`));
  assert.match(loading, new RegExp(`${KEY}\\.loadingTitle`));
  assert.match(loading, new RegExp(`${KEY}\\.loadingBody`));
  assert.doesNotMatch(loading, new RegExp(`${KEY}\\.failedTitle`));

  setState({ status: "failed" });
  const container = await mount(t, Section);
  assert.match(textOf(container), new RegExp(`${KEY}\\.failedTitle`));
  assert.match(textOf(container), new RegExp(`${KEY}\\.failedBody`));
  assert.match(textOf(container), new RegExp(`${KEY}\\.columns\\.name`));
  const retry = buttonWithText(container, `${KEY}.retry`);
  assert.ok(retry, "the failed view offers Try again");
  assert.equal(globalThis.__reloads, 0);
  await React.act(async () => propsOf(retry).onClick());
  assert.equal(globalThis.__reloads, 1);

  // The directory loaded and was empty: no table, a tile with the way forward.
  setState({ status: "ready", spaces: [] });
  const empty = render(Section);
  assert.doesNotMatch(empty, /<table/);
  assert.match(empty, new RegExp(`${KEY}\\.emptyTitle`));
  assert.match(empty, new RegExp(`${KEY}\\.emptyBody<`));
  assert.match(empty, new RegExp(`${KEY}\\.create<`));
});

test("an empty directory tells members to ask an admin, with no button", async (t) => {
  const { Section } = await loadSection(t, { workspace: MEMBER, status: "ready", spaces: [] });
  const markup = render(Section);

  assert.match(markup, new RegExp(`${KEY}\\.emptyBodyMember`));
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.emptyBody<`));
  assert.doesNotMatch(markup, /<button/);
  assert.match(markup, new RegExp(`${KEY}\\.subtitleView`));
});

test("admins see Actions and Create; members see Members and no Create", async (t) => {
  const { Section, setState } = await loadSection(t, {
    spaces: [space("s1", "Alpha", { my_role: "admin" })],
  });

  const admin = render(Section);
  assert.match(admin, new RegExp(`${KEY}\\.columns\\.actions`));
  assert.doesNotMatch(admin, new RegExp(`${KEY}\\.columns\\.members`));
  assert.match(admin, new RegExp(`${KEY}\\.create<`));
  assert.match(admin, new RegExp(`${KEY}\\.subtitleManage`));
  assert.match(admin, /data-row-actions/);

  setState({ workspace: MEMBER });
  const member = render(Section);
  assert.match(member, new RegExp(`${KEY}\\.columns\\.members`));
  assert.doesNotMatch(member, new RegExp(`${KEY}\\.columns\\.actions`));
  assert.doesNotMatch(member, new RegExp(`${KEY}\\.create<`));
  assert.match(member, new RegExp(`${KEY}\\.subtitleView`));
  assert.doesNotMatch(member, /data-row-actions/);

  // Only the capability decides: a member who may create sees the admin columns, and an admin
  // role without it sees the member ones.
  setState({ workspace: { ...MEMBER, capabilities: capabilities(true) } });
  assert.match(render(Section), new RegExp(`${KEY}\\.columns\\.actions`));
  setState({ workspace: { ...ADMIN, capabilities: capabilities(false) } });
  const restricted = render(Section);
  assert.match(restricted, new RegExp(`${KEY}\\.columns\\.members`));
  assert.doesNotMatch(restricted, new RegExp(`${KEY}\\.create<`));
});

test("two admins open a list with names and emails", async (t) => {
  const { Section } = await loadSection(t, {
    spaces: [
      space("s1", "Engineering", {
        admins: [contact("rav", "Rav", "rav@openronnie.com"), contact("anita", "Anita")],
      }),
    ],
  });
  const markup = rowMarkup(render(Section), "Engineering");

  assert.match(markup, new RegExp(`${KEY}\\.adminCount\\|count=2`));
  assert.match(markup, />Rav</);
  assert.match(markup, /<bdi dir="ltr">rav@openronnie\.com<\/bdi>/);
  assert.match(markup, />Anita</);
  assert.match(markup, /<bdi dir="ltr">anita@example\.com<\/bdi>/);
});

test("one admin shows inline", async (t) => {
  const { Section } = await loadSection(t, {
    spaces: [space("s1", "Customer Calls", { admins: [contact("ronnie", "Ronnie Admin")] })],
  });
  const markup = rowMarkup(render(Section), "Customer Calls");

  assert.match(markup, /data-avatar="Ronnie Admin"/);
  assert.match(markup, /<span dir="auto"[^>]*>Ronnie Admin<\/span>/);
  assert.doesNotMatch(markup, /adminCount/);
  assert.doesNotMatch(markup, /data-popover/);
});

test("a person with no name is shown by address, isolated left to right", async (t) => {
  const { Section } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [
      space("s1", "Alpha", {
        my_role: "member",
        admins: [contact("a1", null, "solo@example.com")],
      }),
      space("s2", "Bravo", {
        admins: [contact("b1", null, "one@example.com"), contact("b2", "Named", "two@example.com")],
      }),
    ],
  });
  globalThis.__authUser = { id: "me", name: null, email: "me@example.com", image: null };

  const markup = render(Section);
  // Your own row, the inline admin, and a list entry: each address sits in a <bdi>.
  const alpha = rowMarkup(markup, "Alpha");
  assert.equal(alpha.match(/<bdi dir="ltr">solo@example\.com<\/bdi>/g)?.length, 1);
  assert.equal(alpha.match(/<bdi dir="ltr">me@example\.com<\/bdi>/g)?.length, 1);
  const bravo = rowMarkup(markup, "Bravo");
  assert.match(bravo, /<p dir="auto"[^>]*><bdi dir="ltr">one@example\.com<\/bdi><\/p>/);
  // A named contact keeps the name on top and the address beneath, as before.
  assert.match(bravo, />Named<\/p>/);
  assert.match(bravo, /<bdi dir="ltr">two@example\.com<\/bdi>/);
  assert.doesNotMatch(bravo, /dir="auto"[^>]*>one@example\.com/);
});

test("no admins lists the workspace's admins, read fresh when it opens", async (t) => {
  const { Section } = await loadSection(t, { spaces: [space("s1", "Orphan", { admins: [] })] });
  globalThis.__roster = [
    { user_id: "m1", role: "member", name: "Mia Member", email: "mia@example.com", image: null },
    { user_id: "a1", role: "admin", name: "Adam Admin", email: "adam@example.com", image: null },
    {
      user_id: "o1",
      role: "owner",
      name: "Olivia Owner",
      email: "olivia@example.com",
      image: null,
    },
  ];
  const refreshes = [];
  globalThis.__refreshMembers = async (workspaceId) => {
    refreshes.push(workspaceId);
  };

  const container = await mount(t, Section);
  const row = rowNode(container, "Orphan");
  const listed = textOf(row);
  assert.match(listed, new RegExp(`${KEY}\\.noAdmins`));
  assert.doesNotMatch(listed, /adminCount/);
  // Owner and admins only, owner first; a plain member is not someone to ask.
  assert.ok(listed.indexOf("Olivia Owner") >= 0);
  assert.ok(listed.indexOf("Adam Admin") > listed.indexOf("Olivia Owner"));
  assert.doesNotMatch(listed, /Mia Member/);
  assert.match(listed, /olivia@example\.com/);

  // The roster is read when the menu opens, not before.
  assert.deepEqual(refreshes, []);
  const popover = findNode(row, (node) => "onToggle" in propsOf(node));
  await React.act(async () => propsOf(popover).onToggle(true));
  assert.deepEqual(refreshes, ["w1"]);
  await React.act(async () => propsOf(popover).onToggle(false));
  assert.deepEqual(refreshes, ["w1"]);
});

test("Join shows only where can_join is true", async (t) => {
  const { Section } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [
      space("s1", "Alpha", { my_role: "member", my_direct_role: "member" }),
      space("s2", "Bravo", { is_open: true, can_join: true }),
      space("s3", "Charlie", { is_open: false, can_join: false }),
      // From an API before release 5: none of the new fields.
      {
        id: "s4",
        workspace_id: "w1",
        name: "Delta",
        description: null,
        emoji: null,
        member_count: 2,
        teams: [],
      },
    ],
  });
  const markup = render(Section);
  const join = new RegExp(`${KEY}\\.join<`);

  assert.match(rowMarkup(markup, "Bravo"), join);
  assert.doesNotMatch(rowMarkup(markup, "Charlie"), join);
  assert.doesNotMatch(rowMarkup(markup, "Delta"), join);
  assert.doesNotMatch(rowMarkup(markup, "Alpha"), join);
  // Your own row shows you, with the You chip, and only yours.
  const yours = rowMarkup(markup, "Alpha");
  assert.match(yours, /data-avatar="Ronnie"/);
  assert.match(yours, new RegExp(`${KEY}\\.you`));
  assert.doesNotMatch(rowMarkup(markup, "Bravo"), new RegExp(`${KEY}\\.you`));
  // A row from an older API renders: no admins to name, so it points at the workspace's.
  assert.match(rowMarkup(markup, "Delta"), new RegExp(`${KEY}\\.noAdmins`));
});

test("joining toasts, offers Open teamspace, and reloads", async (t) => {
  const opened = [];
  const { Section } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [
      space("s1", "Bravo", { is_open: true, can_join: true }),
      space("s2", "Charlie", { is_open: true, can_join: true }),
    ],
    localIds: { s1: 41 },
    mirror: [{ id: 41, cloud_space_id: "s1", name: "Bravo" }],
  });
  const joinCalls = [];
  let finishJoin;
  globalThis.__joinSpace = (id) => {
    joinCalls.push(id);
    return new Promise((resolve) => {
      finishJoin = () => resolve({ joined: true });
    });
  };

  const container = await mount(t, Section, { onOpenTeamspace: (id) => opened.push(id) });
  const join = buttonWithText(rowNode(container, "Bravo"), `${KEY}.join`);
  await React.act(async () => propsOf(join).onClick());

  // While it runs, that row's button reads Joining… and is off; the other row is untouched.
  assert.deepEqual(joinCalls, ["s1"]);
  const joining = buttonWithText(rowNode(container, "Bravo"), `${KEY}.joining`);
  assert.ok(joining, "the row shows Joining…");
  assert.equal(propsOf(joining).disabled, true);
  const other = buttonWithText(rowNode(container, "Charlie"), `${KEY}.join`);
  assert.notEqual(propsOf(other).disabled, true);
  assert.equal(globalThis.__reloads, 0);

  await React.act(async () => finishJoin());

  assert.equal(globalThis.__toasts.length, 1);
  const [toast] = globalThis.__toasts;
  assert.match(toast.title, new RegExp(`^${KEY}\\.joined\\|space=.*Bravo`));
  assert.notEqual(toast.variant, "destructive");
  assert.equal(globalThis.__reloads, 1);
  // The button is back for the next attempt.
  assert.ok(buttonWithText(rowNode(container, "Bravo"), `${KEY}.join`));

  assert.equal(toast.actions.length, 1);
  assert.equal(toast.actions[0].label, `${KEY}.openTeamspace`);
  await React.act(async () => toast.actions[0].onClick());
  assert.deepEqual(globalThis.__localLookups, ["s1"]);
  assert.deepEqual(opened, [41]);
});

test("a closed teamspace's refusal says so and reloads", async (t) => {
  const { Section, CloudApiError } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [space("s1", "Bravo", { is_open: true, can_join: true })],
  });
  globalThis.__joinSpace = async () => {
    throw new CloudApiError("Closed", 403, "space_not_open");
  };

  const container = await mount(t, Section);
  await React.act(async () => propsOf(buttonWithText(container, `${KEY}.join`)).onClick());

  assert.equal(globalThis.__toasts.length, 1);
  assert.match(globalThis.__toasts[0].title, new RegExp(`^${KEY}\\.joinClosed\\|space=.*Bravo`));
  assert.equal(globalThis.__reloads, 1);
});

test("a teamspace archived meanwhile leaves the list quietly, like one that is gone", async (t) => {
  const { Section, CloudApiError } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [space("s1", "Bravo", { is_open: true, can_join: true })],
  });
  // A member is told 410 space_archived; only an outsider gets 404 space_not_found.
  globalThis.__joinSpace = async () => {
    throw new CloudApiError("Archived", 410, "space_archived");
  };

  const container = await mount(t, Section);
  await React.act(async () => propsOf(buttonWithText(container, `${KEY}.join`)).onClick());

  assert.deepEqual(globalThis.__toasts, []);
  assert.equal(globalThis.__reloads, 1);
});

test("a teamspace deleted meanwhile reloads without a toast; other failures say so", async (t) => {
  const { Section, CloudApiError } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [space("s1", "Bravo", { is_open: true, can_join: true })],
  });
  const container = await mount(t, Section);

  globalThis.__joinSpace = async () => {
    throw new CloudApiError("Not found", 404, "space_not_found");
  };
  await React.act(async () => propsOf(buttonWithText(container, `${KEY}.join`)).onClick());
  assert.deepEqual(globalThis.__toasts, []);
  assert.equal(globalThis.__reloads, 1);

  globalThis.__joinSpace = async () => {
    throw new Error("offline");
  };
  await React.act(async () => propsOf(buttonWithText(container, `${KEY}.join`)).onClick());
  assert.equal(globalThis.__toasts.length, 1);
  assert.match(globalThis.__toasts[0].title, new RegExp(`^${KEY}\\.joinFailed\\|space=.*Bravo`));
  assert.equal(globalThis.__toasts[0].variant, "destructive");
  // Nothing changed on the server, so the list isn't read again.
  assert.equal(globalThis.__reloads, 1);
  assert.ok(buttonWithText(container, `${KEY}.join`), "Join is available to retry");
});

test("a row you belong to opens settings", async (t) => {
  const mirror = [{ id: 7, cloud_space_id: "s1", name: "Alpha" }];
  const { Section } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [space("s1", "Alpha", { my_role: "member", my_direct_role: "member" })],
    localIds: { s1: 7 },
    mirror,
  });

  const container = await mount(t, Section);
  assert.equal(globalThis.__settingsDialog, undefined);
  await React.act(async () => propsOf(rowNode(container, "Alpha")).onClick());

  assert.deepEqual(globalThis.__localLookups, ["s1"]);
  assert.equal(globalThis.__settingsDialog.open, true);
  assert.equal(globalThis.__settingsDialog.space, mirror[0]);

  await React.act(async () => globalThis.__settingsDialog.onOpenChange(false));
  assert.equal(globalThis.__settingsDialog.open, false);
  // What the dialog changed (a name, who can join) shows in the list.
  assert.equal(globalThis.__reloads, 1);
});

test("a row you don't belong to doesn't", async (t) => {
  const { Section } = await loadSection(t, {
    workspace: MEMBER,
    spaces: [
      space("s1", "Bravo", { is_open: true, can_join: true }),
      space("s2", "Charlie"),
      space("s3", "Delta", { my_role: undefined }),
    ],
  });

  const container = await mount(t, Section);
  for (const name of ["Bravo", "Charlie", "Delta"]) {
    assert.equal(propsOf(rowNode(container, name)).onClick, undefined, name);
  }
  assert.equal(globalThis.__settingsDialog, undefined);
  assert.deepEqual(globalThis.__localLookups, []);
});

test("the Create button opens the dialog for this workspace and reloads when it closes", async (t) => {
  const { Section } = await loadSection(t, { spaces: [space("s1", "Alpha")] });
  const container = await mount(t, Section);
  assert.equal(globalThis.__createDialog.open, false);
  assert.equal(globalThis.__createDialog.initialWorkspaceId, "w1");
  // The page sits behind the modal, so a new teamspace must not move the notes view.
  assert.equal(globalThis.__createDialog.revealOnCreate, false);

  await React.act(async () => propsOf(buttonWithText(container, `${KEY}.create`)).onClick());
  assert.equal(globalThis.__createDialog.open, true);
  assert.equal(globalThis.__reloads, 0);

  await React.act(async () => globalThis.__createDialog.onOpenChange(false));
  assert.equal(globalThis.__createDialog.open, false);
  assert.equal(globalThis.__reloads, 1);
});

test("a row's menu opens, configures and deletes through its local teamspace", async (t) => {
  const mirror = [{ id: 9, cloud_space_id: "s1", name: "Alpha" }];
  const opened = [];
  const { Section } = await loadSection(t, {
    spaces: [space("s1", "Alpha", { my_role: "admin" })],
    localIds: { s1: 9 },
    mirror,
  });
  const container = await mount(t, Section, { onOpenTeamspace: (id) => opened.push(id) });
  const items = findNodes(container, (node) => node.getAttribute("role") === "menuitem");
  assert.deepEqual(
    items.map((item) => textOf(item)),
    [`${KEY}.openTeamspace`, `${KEY}.rowMenu.settings`, `${KEY}.rowMenu.delete`]
  );

  await React.act(async () => propsOf(items[0]).onClick());
  assert.deepEqual(opened, [9]);

  await React.act(async () => propsOf(items[1]).onClick());
  assert.equal(globalThis.__settingsDialog.open, true);
  assert.equal(globalThis.__settingsDialog.space, mirror[0]);

  assert.equal(globalThis.__deleteDialog.space, null);
  await React.act(async () => propsOf(items[2]).onClick());
  assert.equal(globalThis.__deleteDialog.space, mirror[0]);
  await React.act(async () => globalThis.__deleteDialog.onClose());
  assert.equal(globalThis.__deleteDialog.space, null);

  assert.deepEqual(globalThis.__localLookups, ["s1", "s1", "s1"]);
});

test("a teamspace with no local copy says so instead of doing nothing", async (t) => {
  const { Section } = await loadSection(t, { spaces: [space("s1", "Alpha")], localIds: {} });
  const opened = [];
  const container = await mount(t, Section, { onOpenTeamspace: (id) => opened.push(id) });
  const [open] = findNodes(container, (node) => node.getAttribute("role") === "menuitem");

  await React.act(async () => propsOf(open).onClick());

  assert.deepEqual(opened, []);
  assert.equal(globalThis.__toasts.length, 1);
  assert.equal(globalThis.__toasts[0].variant, "destructive");
});

test("the directory reloads when the local mirror changes", async (t) => {
  const { Section } = await loadSection(t, {
    spaces: [space("s1", "Alpha")],
    mirror: [{ id: 1, workspace_id: "w1", cloud_space_id: "s1", name: "Alpha", emoji: null }],
  });
  await mount(t, Section);
  assert.equal(globalThis.__directoryArgs.workspaceId, "w1");
  assert.equal(globalThis.__reloads, 0);

  // A rename or a delete lands in the mirror; the directory rows are read again.
  globalThis.__mirror = [
    { id: 1, workspace_id: "w1", cloud_space_id: "s1", name: "Renamed", emoji: null },
  ];
  const root = mountedRoots.get(t);
  await React.act(async () => root.render(sectionElement(Section)));
  assert.equal(globalThis.__reloads, 1);

  // Another workspace's teamspaces don't matter here.
  globalThis.__mirror = [
    ...globalThis.__mirror,
    { id: 2, workspace_id: "w2", cloud_space_id: "x", name: "Elsewhere", emoji: null },
  ];
  await React.act(async () => root.render(sectionElement(Section)));
  assert.equal(globalThis.__reloads, 1);
});
