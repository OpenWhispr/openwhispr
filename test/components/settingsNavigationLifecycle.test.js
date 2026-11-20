const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { useStore } = require("zustand");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("scoped host survives StrictMode, reconciles hidden policy and cannot leak across a real remount", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__navigationLifecycle;
  });
  const counts = { registered: 0, disposed: 0 };
  let fromMain, keydown, hostId;
  const { storage } = installBrowserGlobals(t, {
    window: {
      addEventListener(type, listener) {
        if (type === "keydown") keydown = listener;
      },
      removeEventListener(type, listener) {
        if (type === "keydown" && keydown === listener) keydown = null;
      },
      electronAPI: {
        getPlatform: () => "linux",
        getSettingsDocumentId: async () => 1,
        setSettingsHostReady(id, ready) {
          hostId = ready ? id : null;
        },
        onShowSettings(callback) {
          fromMain = callback;
          return () => {
            if (fromMain === callback) fromMain = null;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  globalThis.__navigationLifecycle = counts;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-navigation-lifecycle-",
    mockModules: {
      "/stores/policyStore": `import {create} from "zustand";
        export const usePolicyStore = create(() => ({status: "unmanaged", policy: null, appVersion: null}));
        const subscribe = usePolicyStore.subscribe;
        usePolicyStore.subscribe = callback => {
          globalThis.__navigationLifecycle.registered++;
          const dispose = subscribe(callback);
          return () => { globalThis.__navigationLifecycle.disposed++; dispose(); };
        };
        globalThis.__navigationLifecycle.policy = usePolicyStore;`,
      "/SettingsModal": `export default function SettingsModal({navigation}) { globalThis.__navigationLifecycle.modal = navigation; return null; }`,
    },
  });
  const { SettingsHost } = await vite.ssrLoadModule("/components/SettingsHost.tsx");
  let navigation;
  function NavigationChild({ store }) {
    useStore(store, (state) => state.openSettings);
    navigation = store;
    return null;
  }
  const content = (store) => React.createElement(NavigationChild, { store });
  const render = (initialSection) =>
    React.act(async () =>
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(SettingsHost, { initialSection, children: content })
        )
      )
    );
  root = createRoot(container);
  await render("dictationAgent");
  assert.equal(navigation.getState().section, "llms");
  assert.equal(navigation.getState().llmTab, "dictationAgent");
  assert.equal(counts.registered - counts.disposed, 1, "StrictMode leaves one policy bridge");
  assert.equal(storage.getItem("settings.llmsTab"), JSON.stringify("dictationAgent"));
  const actions = navigation.getState();
  await React.act(async () => actions.setSettingsOpen(false));
  await render("transcription");
  assert.equal(
    navigation.getState().section,
    null,
    "changing the initial seed does not reopen an existing host"
  );
  await React.act(async () => keydown({ ctrlKey: true, key: ",", preventDefault() {} }));
  assert.equal(navigation.getState().section, "account");
  await React.act(async () => actions.setSettingsOpen(false));
  await React.act(async () => fromMain({ hostId, requestId: 1 }));
  assert.equal(navigation.getState().section, "account");
  const old = navigation;
  await React.act(async () => root.unmount());
  root = null;
  assert.equal(counts.registered, counts.disposed);
  assert.equal(keydown, null);
  assert.equal(fromMain, null);
  root = createRoot(container);
  await render();
  assert.notEqual(navigation, old);
  assert.equal(navigation.getState().section, null);
  await React.act(async () => old.getState().openSettings("transcription"));
  assert.equal(
    navigation.getState().section,
    null,
    "an old private action cannot open the new host"
  );
});
