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
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceGuestsTab.tsx");
  t.after(() => {
    delete globalThis.__guestsState;
    delete globalThis.__guestsArgs;
    delete globalThis.__reloads;
  });
  globalThis.__reloads = 0;
  globalThis.__guestsState = {
    status,
    guests,
    error: status === "failed" ? { kind: "failed" } : null,
    reload: async () => {
      globalThis.__reloads += 1;
    },
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
