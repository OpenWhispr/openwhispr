const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("a cached remote model is present before settings startup migrations normalize saved selections", async (t) => {
  const data = structuredClone(seed);
  data.cloudProviders[0].models.push({
    id: "remote-saved",
    name: "Remote",
    description: "Fixture",
  });
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupModel: "remote-saved",
    },
  });
  globalThis.window.electronAPI = {
    ...globalThis.window.electronAPI,
    initialModelRegistrySnapshot: { data, manifestVersion: 100 },
    onModelRegistryUpdated: () => () => {},
    getModelRegistry: async () => ({ data, manifestVersion: 100 }),
  };
  const vite = await createRendererServer(t, { cachePrefix: "registry-bootstrap-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.equal(useSettingsStore.getState().cleanupModel, "remote-saved");
});

test("new events beat delayed snapshots and repeated starts share a cleaned-up listener", async () => {
  const { startRegistrySync } = require("../../src/models/registrySync.js");
  const store = require("../../src/models/registryData.js");
  let resolve;
  let callback;
  let subscriptions = 0;
  let removed = 0;
  const initial = store.getRegistryVersion();
  const api = {
    initialModelRegistrySnapshot: { data: seed, manifestVersion: initial + 1 },
    getModelRegistry: () => new Promise((r) => (resolve = r)),
    onModelRegistryUpdated: (fn) => {
      subscriptions++;
      callback = fn;
      return () => removed++;
    },
  };
  const first = startRegistrySync(api);
  const second = startRegistrySync(api);
  assert.equal(subscriptions, 1);
  callback({ data: seed, manifestVersion: initial + 3 });
  resolve({ data: seed, manifestVersion: initial + 2 });
  await Promise.resolve();
  assert.equal(store.getRegistryVersion(), initial + 3);
  first();
  assert.equal(removed, 0);
  second();
  assert.equal(removed, 1);
});

test("the IPC initial snapshot and update broadcast use the same main catalog", () => {
  const { EventEmitter } = require("node:events");
  const { registerRegistryIpc } = require("../../src/helpers/registryIpc");
  const store = require("../../src/models/registryData.js");
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, fn) => handlers.set(name, fn);
  ipc.removeHandler = (name) => handlers.delete(name);
  const windows = [[], []];
  const cleanup = registerRegistryIpc(ipc, (name, value) =>
    windows.forEach((w) => w.push({ name, value }))
  );
  try {
    const event = {};
    ipc.emit("model-registry-initial", event);
    assert.equal(event.returnValue.manifestVersion, store.getRegistryVersion());
    store.replaceRegistryData({ data: seed, manifestVersion: store.getRegistryVersion() + 1 });
    assert.equal(windows[0].length, 1);
    assert.deepEqual(windows[0], windows[1]);
    assert.deepEqual(handlers.get("get-model-registry")(), windows[0][0].value);
  } finally {
    cleanup();
  }
  assert.equal(ipc.listenerCount("model-registry-initial"), 0);
});

test("a mounted model consumer renders a new catalog without remounting", async (t) => {
  const { installHookDom } = require("../lib/rendererTestHarness");
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "registry-reactive-" });
  const { useRegistryVersion } = await vite.ssrLoadModule("/hooks/useRegistryVersion.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  const observed = [];
  function Picker() {
    useRegistryVersion();
    observed.push(store.getRegistryData().cloudProviders[0].models.map((model) => model.id));
    return null;
  }
  try {
    await React.act(async () => root.render(React.createElement(Picker)));
    assert.equal(observed.at(-1).includes("visible-live"), false);
    const data = structuredClone(seed);
    data.cloudProviders[0].models.push({
      id: "visible-live",
      name: "Live",
      description: "Fixture",
    });
    await React.act(async () =>
      store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 })
    );
    assert.equal(observed.at(-1).includes("visible-live"), true);
  } finally {
    await React.act(async () => root.unmount());
  }
});
