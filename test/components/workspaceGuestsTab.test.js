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

const KEY = "settingsPage.workspace.guests";

const capabilities = (manageMembers) => ({
  manage_members: manageMembers,
  manage_teams: false,
  create_teams: false,
  create_spaces: false,
  manage_settings: false,
  manage_billing: false,
  delete_workspace: false,
  transfer_ownership: false,
  leave: true,
});

const ADMIN = { id: "w1", name: "Acme", role: "admin", capabilities: capabilities(true) };
const MEMBER = { id: "w1", name: "Acme", role: "member", capabilities: capabilities(false) };

const note = (id, title, overrides = {}) => ({
  id,
  title,
  permission: "viewer",
  visibility: "invited",
  ...overrides,
});
const guest = (email, name, notes = []) => ({ email, name, image: null, notes });

const mountedRoots = new Map();

async function loadTab(t, { workspace = ADMIN, status = "ready", guests = [] } = {}) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-guests-tab-",
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
      "/hooks/useWorkspaceGuests": `
        export const useWorkspaceGuests = (workspaceId) => {
          globalThis.__guestsArgs = workspaceId;
          return globalThis.__guestsState;
        };
      `,
      "/MemberAvatar": `
        import React from "react";
        export default function MemberAvatar({ name, email }) {
          return React.createElement("span", { "data-avatar": name ?? email });
        }
      `,
      // The menu renders open, so a test reads its notes.
      "/ui/dropdown-menu": `
        import React from "react";
        const h = React.createElement;
        export const DropdownMenu = ({ children }) => h("div", { "data-menu": "" }, children);
        export const DropdownMenuTrigger = ({ children, "aria-label": label }) =>
          h("button", { "data-trigger": "", "aria-label": label }, children);
        export const DropdownMenuContent = ({ children }) => h("div", { "data-menu-content": "" }, children);
        export const DropdownMenuItem = ({ children, onSelect }) =>
          h("button", { "data-item": "", onSelect }, children);
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });
      `,
      "/InviteTeammateDialog": `
        export default function InviteTeammateDialog(props) {
          globalThis.__inviteProps = props;
          return null;
        }
      `,
      "/workspace/RemoveGuestsDialog": `
        export function RemoveGuestsDialog(props) {
          globalThis.__removeProps = props;
          return null;
        }
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceGuestsTab.tsx");
  t.after(() => {
    delete globalThis.__guestsState;
    delete globalThis.__guestsArgs;
    delete globalThis.__reloads;
    delete globalThis.__dropped;
    delete globalThis.__toasts;
    delete globalThis.__inviteProps;
    delete globalThis.__removeProps;
    delete globalThis.__clipboard;
  });
  globalThis.__reloads = 0;
  globalThis.__dropped = [];
  globalThis.__toasts = [];
  globalThis.__clipboard = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => void globalThis.__clipboard.push(text) } },
  });
  globalThis.__guestsState = {
    status,
    guests,
    error: status === "failed" ? { kind: "failed" } : null,
    reload: async () => {
      globalThis.__reloads += 1;
    },
    dropGuests: (emails) => globalThis.__dropped.push(emails),
  };
  return { Tab: module.default, workspace };
}

const render = (Tab, workspace) => renderToStaticMarkup(React.createElement(Tab, { workspace }));

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

test("shows the empty state", async (t) => {
  const { Tab, workspace } = await loadTab(t, { guests: [] });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.emptyTitle`));
  assert.match(markup, new RegExp(`${KEY}\\.emptyBody`));
  assert.doesNotMatch(markup, /<table/);
});

test("shows the loading state inside the table frame", async (t) => {
  const { Tab, workspace } = await loadTab(t, { status: "loading" });
  const markup = render(Tab, workspace);
  assert.match(markup, /<table/);
  assert.match(markup, new RegExp(`${KEY}\\.loadingTitle`));
  assert.match(markup, new RegExp(`${KEY}\\.loadingBody`));
});

test("lists name, email and note count", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    guests: [guest("jin@x.com", "Jin Park", [note("n1", "Plan"), note("n2", "Notes")])],
  });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.columns\\.name`));
  assert.match(markup, new RegExp(`${KEY}\\.columns\\.access`));
  assert.match(markup, /Jin Park/);
  assert.match(markup, /<bdi dir="ltr">jin@x\.com<\/bdi>/);
  assert.match(markup, new RegExp(`${KEY}\\.noteCount\\|count=2`));
  assert.equal(globalThis.__guestsArgs, "w1");
});

test("a guest without a name shows the email once", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    guests: [guest("ravi@x.com", null, [note("n1", "Plan")])],
  });
  // Visible text only: the menu trigger's accessible name legitimately carries the name too.
  const visible = render(Tab, workspace).replace(/ (aria-label|data-avatar)="[^"]*"/g, "");
  assert.equal(visible.split("ravi@x.com").length - 1, 1);
});

test("the Access menu lists titles, untitled ones as Untitled", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    guests: [
      guest("jin@x.com", "Jin", [note("n1", "Roadmap"), note("n2", null), note("n3", "  ")]),
    ],
  });
  const markup = render(Tab, workspace);
  assert.match(markup, /dir="auto"[^>]*>Roadmap</);
  assert.equal(markup.split("notes.list.untitled").length - 1, 2);
  assert.match(markup, new RegExp(`${KEY}\\.notesMenuLabel`));
});

test("a 404 from an older API shows Failed", async (t) => {
  const { Tab, workspace } = await loadTab(t, { status: "failed" });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.failedTitle`));
  assert.match(markup, new RegExp(`${KEY}\\.failedBody`));
});

test("Try again reloads", async (t) => {
  const { Tab, workspace } = await loadTab(t, { status: "failed" });
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => root.render(React.createElement(Tab, { workspace })));
  const retry = findNode(
    container,
    (node) => node.tagName === "BUTTON" && textOf(node).trim() === "workspaces.exit.tryAgain"
  );
  assert.ok(retry, "Failed offers Try again");
  await React.act(async () => propsOf(retry).onClick());
  assert.equal(globalThis.__reloads, 1);
});

test("without manage_members there are no checkboxes, no Actions and no ×", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    workspace: MEMBER,
    guests: [guest("jin@x.com", "Jin", [note("n1", "Plan")])],
  });
  const markup = render(Tab, workspace);
  assert.match(markup, /Jin/);
  assert.doesNotMatch(markup, /type="checkbox"/);
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.columns\\.actions`));
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.removeFromNote`));
});

const JIN = guest("jin@x.com", "Jin Park", [note("n1", "Plan", { visibility: "link" })]);

async function mountTab(t, options) {
  const { Tab, workspace } = await loadTab(t, options);
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => root.render(React.createElement(Tab, { workspace })));
  const item = (label) =>
    findNode(container, (node) => node.hasAttribute("data-item") && textOf(node).trim() === label);
  return { container, item };
}

test("the row menu offers invite, copy and remove", async (t) => {
  const { Tab, workspace } = await loadTab(t, { guests: [JIN] });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.columns\\.actions`));
  assert.match(markup, new RegExp(`${KEY}\\.menu\\.label\\|name=`));
  for (const key of ["invite", "copyEmail", "remove"]) {
    assert.match(markup, new RegExp(`${KEY}\\.menu\\.${key}`));
  }
});

test("copy writes the email and toasts", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.copyEmail`)).onSelect());
  assert.deepEqual(globalThis.__clipboard, ["jin@x.com"]);
  assert.equal(globalThis.__toasts[0].title, "common.copied");
});

test("invite opens the dialog with the guest's address and the guest heading", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  assert.equal(globalThis.__inviteProps, undefined);
  await React.act(async () => propsOf(item(`${KEY}.menu.invite`)).onSelect());
  const props = globalThis.__inviteProps;
  assert.equal(props.open, true);
  assert.equal(props.workspaceId, "w1");
  assert.equal(props.workspaceName, "Acme");
  assert.deepEqual(props.initialEmails, ["jin@x.com"]);
  assert.match(props.heading.title, new RegExp(`${KEY}\\.invite\\.title\\|count=1`));
  assert.match(props.heading.description, new RegExp(`${KEY}\\.invite\\.description`));
});

test("a send reloads the list and closing toasts the sent count", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.invite`)).onSelect());
  await React.act(async () => globalThis.__inviteProps.onInvitationsChanged());
  assert.equal(globalThis.__reloads, 1);
  await React.act(async () => globalThis.__inviteProps.onInvited(["jin@x.com"]));
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  assert.match(globalThis.__toasts[0].title, new RegExp(`${KEY}\\.invite\\.sent\\|count=1`));
});

test("closing the invite without sending doesn't toast", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.invite`)).onSelect());
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  assert.equal(globalThis.__toasts.length, 0);
});

test("remove asks first, then removes and reloads", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  assert.equal(globalThis.__removeProps, undefined);
  await React.act(async () => propsOf(item(`${KEY}.menu.remove`)).onSelect());
  const props = globalThis.__removeProps;
  assert.equal(props.open, true);
  assert.deepEqual(
    props.guests.map((g) => g.email),
    ["jin@x.com"]
  );
  await React.act(async () =>
    props.onRemoved({
      removed: ["jin@x.com"],
      not_found: [],
      skipped_members: [],
      link_shared_note_ids: [],
    })
  );
  assert.equal(globalThis.__reloads, 1);
});

test("removed guests leave the list at once even if the reload fails", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.remove`)).onSelect());
  await React.act(async () =>
    globalThis.__removeProps.onRemoved({
      removed: ["jin@x.com"],
      not_found: [],
      skipped_members: [],
      link_shared_note_ids: [],
    })
  );
  // Dropped by the hook before the reload, so a failing reload can't leave them listed.
  assert.deepEqual(globalThis.__dropped, [["jin@x.com"]]);
  assert.equal(globalThis.__reloads, 1);
});
