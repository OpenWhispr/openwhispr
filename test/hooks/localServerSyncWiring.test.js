const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The main process decides the shared llama-server from what each window
// syncs, so this pins the renderer half: the policy-settled flag it sends and
// the resync after a sign-out that leaves the policy idle. SSR cannot run
// useEffect, so the settings provider is mounted for real.
async function mountSettings(t) {
  // Registered before the browser globals so it runs before their teardown.
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const syncs = [];
  const listeners = {};
  const known = {
    syncStartupPreferences: async (prefs) => {
      syncs.push(prefs);
    },
    // Startup seeds the agent name into the dictionary. Left pending, the write
    // never reaches its cloud push, which imports a module after teardown.
    applyDictionaryChanges: () => new Promise(() => {}),
    onActiveAccountScopeChanged: (callback) => {
      listeners.scope = callback;
      return () => {
        delete listeners.scope;
      };
    },
  };
  // Every other bridge call the provider makes is irrelevant here.
  const electronAPI = new Proxy(known, {
    get: (target, name) =>
      name in target
        ? target[name]
        : String(name).startsWith("on")
          ? () => () => {}
          : async () => undefined,
  });

  installBrowserGlobals(t, { window: { electronAPI } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-server-sync-wiring-test-",
  });
  const [{ SettingsProvider }, { usePolicyStore }] = await Promise.all([
    vite.ssrLoadModule("/hooks/useSettings.ts"),
    vite.ssrLoadModule("/stores/policyStore.ts"),
  ]);

  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(SettingsProvider, null, null)));
  rootRef.current = root;

  return { syncs, listeners, usePolicyStore };
}

test("a window reports its policy as unsettled until the fetch lands", async (t) => {
  const { syncs, usePolicyStore } = await mountSettings(t);

  assert.equal(syncs.at(-1).policySettled, false, "idle is not settled");

  await React.act(async () => usePolicyStore.setState({ status: "unmanaged" }));
  assert.equal(syncs.at(-1).policySettled, true);
});

test("a sign-out resyncs even though the policy stays idle", async (t) => {
  const { syncs, listeners } = await mountSettings(t);
  const before = syncs.length;

  await React.act(async () => listeners.scope({ accountId: "a", authGeneration: 1 }));
  assert.equal(syncs.length, before, "a sign-in waits for its policy instead");

  await React.act(async () => listeners.scope(null));
  assert.equal(syncs.length, before + 1);
});
