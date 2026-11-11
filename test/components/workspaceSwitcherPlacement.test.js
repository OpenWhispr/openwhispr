const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MOCKS = {
  "react-i18next": `
    export function useTranslation() {
      return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
    }
  `,
  "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
  "/hooks/useWorkspace": `
    export const useWorkspace = () => ({
      workspaces: globalThis.__switcherState.workspaces,
      setActive() {},
      refresh: async () => {
        globalThis.__switcherState.refreshes += 1;
      },
    });
  `,
  "/stores/workspaceStore": `
    const read = () => ({
      activeWorkspaceId: globalThis.__switcherState.activeWorkspaceId,
      defaultWorkspaceId: globalThis.__switcherState.defaultWorkspaceId,
      loaded: globalThis.__switcherState.loaded,
      loading: false,
      error: globalThis.__switcherState.error,
      workspaces: globalThis.__switcherState.workspaces,
    });
    export const useWorkspaceStore = Object.assign((selector) => selector(read()), {
      getState: read,
    });
  `,
  "/services/WorkspacesService": `export const WorkspacesService = { listMembers: async () => [] };`,
  "/CreateWorkspaceDialog": `export default function CreateWorkspaceDialog() { return null; }`,
  "/stores/policyStore": `
    export const usePolicyStore = (selector) => selector({ accountId: globalThis.__switcherState.accountId });
  `,
  // Records whether the switcher asks the intro to show, and for which workspace.
  "/workspace/WorkspaceIntroDialog": `
    export function WorkspaceIntroDialog({ open, workspaceId, workspaceName, onFinish }) {
      globalThis.__intro = { open, workspaceId, workspaceName, onFinish };
      return null;
    }
  `,
  // Records what the switcher hands the menu so a test can read placement and open state.
  "/ui/dropdown-menu": `
    import React from "react";
    const Pass = ({ children }) => React.createElement("div", null, children);
    export function DropdownMenu({ open, onOpenChange, children }) {
      globalThis.__menu.root = { open, onOpenChange };
      return React.createElement("div", null, children);
    }
    export function DropdownMenuTrigger({ children, ...props }) {
      return React.createElement("button", props, children);
    }
    export function DropdownMenuContent({ side, align, children }) {
      globalThis.__menu.content = { side, align };
      return React.createElement("div", null, children);
    }
    // Marks each menu item, so a test can read the menu's rows in order.
    export function DropdownMenuItem({ children, onSelect }) {
      globalThis.__menu.items.push({ onSelect });
      return React.createElement("div", { "data-menu-item": "" }, children);
    }
    export const DropdownMenuSeparator = () => null;
  `,
};

async function loadSwitcher(t) {
  t.after(() => {
    delete globalThis.__menu;
    delete globalThis.__switcherState;
    delete globalThis.__intro;
  });
  globalThis.__menu = { items: [] };
  globalThis.__switcherState = {
    workspaces: [{ id: "acme", name: "Acme Studio", role: "owner" }],
    activeWorkspaceId: "acme",
    defaultWorkspaceId: null,
    loaded: true,
    error: false,
    accountId: "user-1",
    refreshes: 0,
  };
  globalThis.__intro = null;
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-switcher-placement-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: WorkspaceSwitcher } = await vite.ssrLoadModule(
    "/components/WorkspaceSwitcher.tsx"
  );
  return (props) => {
    globalThis.__menu.items = [];
    return renderToStaticMarkup(createElement(WorkspaceSwitcher, props));
  };
}

// The text of each menu row, in order.
const menuItems = (html) =>
  [...html.matchAll(/<div data-menu-item="">(.*?)<\/div>/gs)].map(([, row]) =>
    row.replace(/<[^>]+>/g, "")
  );

test("settings placement opens the menu below", async (t) => {
  const render = await loadSwitcher(t);

  render({ placement: "settings" });

  assert.equal(globalThis.__menu.content.side, "bottom");
  assert.equal(globalThis.__menu.content.align, "start");
});

test("sidebar placement still opens above", async (t) => {
  const render = await loadSwitcher(t);

  render({});

  assert.equal(globalThis.__menu.content.side, "top");
  assert.equal(globalThis.__menu.content.align, "start");
});

test("controlled open is passed through", async (t) => {
  const render = await loadSwitcher(t);
  const changes = [];

  render({ open: true, onOpenChange: (open) => changes.push(open) });
  assert.equal(globalThis.__menu.root.open, true);

  globalThis.__menu.root.onOpenChange(false);
  assert.deepEqual(changes, [false]);
});

test("uncontrolled leaves the menu's own state alone", async (t) => {
  const render = await loadSwitcher(t);

  render({});

  assert.equal(globalThis.__menu.root.open, undefined);
});

test("compact trigger shows only the avatar and names the workspace", async (t) => {
  const render = await loadSwitcher(t);

  const markup = render({ compact: true, placement: "settings" });

  const trigger = markup.match(/<button[^>]*>.*?<\/button>/s)[0];
  assert.match(trigger, /^<button[^>]*aria-label="Acme Studio"/);
  // The name is the label only; no visible text node in the trigger carries it.
  assert.doesNotMatch(trigger, />Acme Studio</);
  assert.match(trigger, />AS</);
});

test("the full trigger shows the workspace name", async (t) => {
  const render = await loadSwitcher(t);

  const markup = render({});

  assert.match(markup, />Acme Studio</);
});

test("the sidebar shows the intro for an unseen workspace once allowed", async (t) => {
  const render = await loadSwitcher(t);

  render({});
  assert.equal(globalThis.__intro.open, false, "not without introAllowed");

  render({ introAllowed: true });
  assert.equal(globalThis.__intro.open, true);
  assert.equal(globalThis.__intro.workspaceName, "Acme Studio");
});

test("the settings picker never shows the intro", async (t) => {
  const render = await loadSwitcher(t);

  render({ placement: "settings", introAllowed: true });

  assert.equal(globalThis.__intro.open, false);
});

test("finishing the intro marks it seen for this account and workspace", async (t) => {
  const render = await loadSwitcher(t);

  render({ introAllowed: true });
  assert.equal(globalThis.__intro.workspaceId, "acme");
  globalThis.__intro.onFinish("acme");

  assert.equal(localStorage.getItem("workspaceIntroVersion:user-1:acme"), "1");
  render({ introAllowed: true });
  assert.equal(globalThis.__intro.open, false);
});

test("finishing marks the workspace the intro was shown for, not the active one", async (t) => {
  const render = await loadSwitcher(t);
  globalThis.__switcherState.workspaces.push({ id: "beta", name: "Beta", role: "member" });

  render({ introAllowed: true });
  // The active workspace changed while the intro for Beta was finishing.
  globalThis.__intro.onFinish("beta");

  assert.equal(localStorage.getItem("workspaceIntroVersion:user-1:beta"), "1");
  assert.equal(localStorage.getItem("workspaceIntroVersion:user-1:acme"), null);
  render({ introAllowed: true });
  assert.equal(globalThis.__intro.open, true, "Acme's intro still shows");
});

test("the switcher has no Personal item and lists the default first", async (t) => {
  const render = await loadSwitcher(t);
  globalThis.__switcherState.workspaces = [
    { id: "acme", name: "Acme Studio", role: "member", is_default: false },
    { id: "beta", name: "Beta Labs", role: "member", is_default: false },
    { id: "mine", name: "Chad's workspace", role: "owner", is_default: true },
  ];
  globalThis.__switcherState.defaultWorkspaceId = "mine";

  const html = render({});

  assert.doesNotMatch(html, /notes\.spaces\.personal/);
  const workspaceRows = menuItems(html).filter((row) => row !== "workspaces.switcher.add");
  assert.deepEqual(workspaceRows, ["CWChad&#x27;s workspace", "ASAcme Studio", "BLBeta Labs"]);
});

test("an empty list never hides Private behind a spinner", async (t) => {
  const render = await loadSwitcher(t);
  // Listed, but the default workspace isn't there yet (its creation failed or is on its way).
  globalThis.__switcherState.workspaces = [];
  globalThis.__switcherState.activeWorkspaceId = null;

  for (const props of [{}, { placement: "settings", compact: true }]) {
    const html = render(props);

    assert.doesNotMatch(html, /animate-pulse/, "no loading placeholder");
    const trigger = html.match(/<button[^>]*>.*?<\/button>/s)?.[0] ?? "";
    assert.match(trigger, /notes\.spaces\.personal/, "the trigger names the account's Private");
    assert.deepEqual(menuItems(html), [
      "workspaces.switcher.unavailablesettingsPage.workspace.loadError.retry",
    ]);
  }

  // Retry asks for the list again, which retries making the default workspace.
  globalThis.__menu.items[0].onSelect({ preventDefault() {} });
  assert.equal(globalThis.__switcherState.refreshes, 1);
});
