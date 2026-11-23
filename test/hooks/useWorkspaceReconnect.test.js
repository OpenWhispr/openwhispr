const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A window whose listeners can be fired, so the test can play "back online".
function listeningWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

test("a workspace list that failed to load retries when the app reconnects", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__state;
  });

  const events = listeningWindow();
  installBrowserGlobals(t, {
    window: {
      addEventListener: events.addEventListener,
      removeEventListener: events.removeEventListener,
    },
  });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-use-workspace-reconnect-",
    mockModules: {
      "/useAuth": `export const useAuth = () => ({
        isSignedIn: globalThis.__state.isSignedIn,
        isOfflineAccount: globalThis.__state.isOfflineAccount,
      });`,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) => selector(globalThis.__state.store);
      `,
    },
  });
  const { useWorkspace } = await vite.ssrLoadModule("/hooks/useWorkspace.ts");

  function Harness() {
    useWorkspace();
    return null;
  }

  let refreshes = 0;
  const store = {
    workspaces: [],
    activeWorkspaceId: null,
    loaded: true,
    error: true,
    refresh: async () => {
      refreshes += 1;
    },
    setActiveWorkspaceId: () => {},
  };
  const render = async (state) => {
    globalThis.__state = {
      isSignedIn: true,
      isOfflineAccount: false,
      ...state,
      store: { ...store, ...state.store },
    };
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
  };

  root = createRoot(container);

  await render({});
  events.fire("online");
  events.fire("focus");
  assert.equal(refreshes, 2);

  // Switching windows again soon after doesn't send another request; coming online does.
  events.fire("focus");
  assert.equal(refreshes, 2);
  events.fire("online");
  assert.equal(refreshes, 3);

  // A loaded list stops listening.
  await render({ store: { error: false } });
  assert.equal(events.count("online"), 0);
  assert.equal(events.count("focus"), 0);

  // Signed out, a stale error never triggers a request.
  await render({ isSignedIn: false });
  events.fire("online");
  assert.equal(refreshes, 3);

  // A presented offline account cannot retry until the session validates again.
  await render({ isOfflineAccount: true });
  assert.equal(events.count("online"), 0);
  assert.equal(events.count("focus"), 0);
  events.fire("online");
  events.fire("focus");
  assert.equal(refreshes, 3);

  // The same guard applies before the first list has loaded. Validation starts it.
  await render({ isOfflineAccount: true, store: { loaded: false } });
  assert.equal(refreshes, 3);
  await render({ store: { loaded: false } });
  assert.equal(refreshes, 4);
});

for (const { name, modulePath, exportName, props } of [
  {
    name: "workspace settings",
    modulePath: "/components/settings/useSettingsWorkspace.ts",
    exportName: "useSettingsWorkspace",
  },
  {
    name: "plans & billing picker",
    modulePath: "/components/settings/billing/PlansBillingPicker.tsx",
    exportName: "PlansBillingPicker",
    props: { request: { kind: "personal" }, onChange: () => {}, personalPlanLabel: null },
  },
]) {
  test(`${name} waits for validated sign-in before automatically loading memberships`, async (t) => {
    let root = null;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
      delete globalThis.__workspaceLoader;
    });
    installBrowserGlobals(t);
    const container = installHostDom(t);
    const state = { isSignedIn: true, isOfflineAccount: true };
    let refreshes = 0;
    const store = {
      workspaces: [],
      activeWorkspaceId: null,
      loaded: false,
      loading: false,
      error: false,
      refresh: async () => {
        refreshes += 1;
      },
    };
    globalThis.__workspaceLoader = { state, store };
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-settings-workspace-auth-",
      noExternal: ["react-i18next"],
      mockModules: {
        "/useAuth": "export const useAuth = () => globalThis.__workspaceLoader.state;",
        "/stores/workspaceStore": `
          export const useWorkspaceStore = (selector) => selector(globalThis.__workspaceLoader.store);
        `,
        "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
        "/WorkspaceBillingCard": "export default function Mock() { return null; }",
        "/WorkspaceSwitcher": "export const RetryMenuItem = () => null;",
      },
    });
    const consumer = (await vite.ssrLoadModule(modulePath))[exportName];
    function Harness() {
      if (props) return React.createElement(consumer, props);
      consumer();
      return null;
    }
    root = createRoot(container);
    const render = async () => {
      await React.act(async () => root.render(React.createElement(Harness)));
    };

    await render();
    assert.equal(refreshes, 0);

    state.isOfflineAccount = false;
    await render();
    assert.equal(refreshes, 1);

    state.isSignedIn = false;
    await render();
    assert.equal(refreshes, 1);
  });
}
