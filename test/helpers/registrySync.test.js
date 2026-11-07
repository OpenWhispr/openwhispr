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
  // A window reloading after teardown must still get an answer to its sendSync.
  assert.equal(ipc.listenerCount("model-registry-initial"), 1);
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

test("a remote selection survives a launch whose catalog has not loaded it yet", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _providerSettingsMigrated: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "registry-lost-cache-" });
  await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const data = structuredClone(seed);
  data.cloudProviders
    .find((p) => p.id === "openai")
    .models.push({
      id: "remote-saved",
      name: "Remote",
      description: "Fixture",
    });
  data.transcriptionProviders
    .find((provider) => provider.id === "openai")
    .models.push({
      id: "remote-transcription",
      name: "Remote speech",
      description: "Fixture",
      streaming: true,
    });
  data.localProviders[0].models.push({
    ...data.localProviders[0].models[0],
    id: "remote-local-saved",
  });
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  storage.setItem("cleanupProvider", "openai");
  storage.setItem("cleanupModel", "remote-saved");
  storage.setItem("chatAgentMode", "local");
  storage.setItem("chatAgentProvider", data.localProviders[0].id);
  storage.setItem("chatAgentModel", "remote-local-saved");
  // Recreate the renderer as main does when its cache exists but cannot be loaded yet:
  // only the bundle, marked pending. Only local preferences survive.
  vite.moduleGraph.invalidateAll();
  const bundleOnly = await vite.ssrLoadModule("/models/registryData.js");
  bundleOnly.replaceRegistryData({
    data: structuredClone(seed),
    manifestVersion: bundleOnly.getRegistryVersion() + 1,
    pending: true,
  });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  settings.reconcileRetiredCloudModelSelections();
  // Installed models are listed from their install record, not from the catalog.
  globalThis.window.electronAPI.modelGetAll = async () => [
    { id: "remote-local-saved", isDownloaded: true },
  ];
  await settings.reconcileLocalModelSelections();
  assert.equal(settings.useSettingsStore.getState().cleanupModel, "remote-saved");
  assert.equal(storage.getItem("cleanupModel"), "remote-saved");
  assert.equal(settings.useSettingsStore.getState().chatAgentModel, "remote-local-saved");
  assert.equal(storage.getItem("chatAgentModel"), "remote-local-saved");
  const managed = {
    status: "managed",
    appVersion: "1.10.3",
    policy: {
      transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai", "groq"] },
      llm: { allowedModes: ["providers", "local"], allowedByokProviders: ["openai"] },
      features: { agentEnabled: true, webSearchEnabled: true },
    },
  };
  const saved = {
    ...settings.useSettingsStore.getState(),
    transcriptionMode: "providers",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "remote-transcription",
  };
  const effective = settings.selectPolicyEffectiveSettings(saved, managed);
  assert.equal(
    effective.cloudTranscriptionModel,
    "remote-transcription",
    "a model the catalog does not know yet is kept, not swapped for a default"
  );
  const denied = structuredClone(managed);
  denied.policy.transcription.allowedByokProviders = ["groq"];
  const restricted = settings.selectPolicyEffectiveSettings(saved, denied);
  assert.equal(restricted.cloudTranscriptionProvider, "groq");
  assert.notEqual(restricted.cloudTranscriptionModel, "remote-transcription");
});

test("a catalog addition immediately rechecks an already-required local model", async (t) => {
  const { installHookDom } = require("../lib/rendererTestHarness");
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  let checks = 0;
  globalThis.window.electronAPI.listWhisperModels = async () => {
    checks++;
    return { success: true, models: [{ model: "required-future", downloaded: false }] };
  };
  globalThis.window.electronAPI.listParakeetModels = async () => ({ success: true, models: [] });
  const vite = await createRendererServer(t, {
    cachePrefix: "registry-required-live-",
    mockModules: {
      "./usePolicy": `const snapshot = { status: 'managed', policy: { requiredLocalModels: ['required-future'], transcription: { allowedModes: ['local'] } } }; export const usePolicySnapshot = () => snapshot;`,
      "./useModelDownload": `export const LOCAL_MODELS_CHANGED_EVENT = 'local-models-changed';`,
    },
  });
  const { useRequiredLocalModels } = await vite.ssrLoadModule("/hooks/useRequiredLocalModels.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  let state;
  function Probe() {
    state = useRequiredLocalModels();
    return null;
  }
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(Probe)));
    assert.deepEqual(state.required, []);
    assert.equal(checks, 0);
    const data = structuredClone(seed);
    data.whisperModels["required-future"] = { ...data.whisperModels.base };
    await React.act(async () =>
      store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 })
    );
    assert.deepEqual(state.required, ["required-future"]);
    assert.deepEqual(state.missing, ["required-future"]);
    assert.equal(state.loading, false);
    assert.equal(checks, 1);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test("org policy knows a local model the catalog added, and keeps one it retired", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "registry-policy-known-" });
  const { isKnownLocalModelId } = await vite.ssrLoadModule("/stores/policyRules.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const gguf = seed.localProviders[0].models[0].id;
  assert.equal(isKnownLocalModelId("transcription", "remote-whisper"), false);
  assert.equal(isKnownLocalModelId("llm", "remote-gguf"), false);
  assert.equal(isKnownLocalModelId("llm", gguf), true);

  const data = structuredClone(seed);
  data.whisperModels["remote-whisper"] = { ...data.whisperModels.base };
  data.localProviders[0].models.push({ ...data.localProviders[0].models[1], id: "remote-gguf" });
  Object.assign(data.localProviders[0].models[0], { retired: true });
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });

  assert.equal(isKnownLocalModelId("transcription", "remote-whisper"), true);
  assert.equal(isKnownLocalModelId("llm", "remote-gguf"), true);
  // Running work and a file already on disk keep going after a retirement.
  assert.equal(isKnownLocalModelId("llm", gguf), true, "a retired model stays known");
  assert.equal(isKnownLocalModelId("transcription", gguf), false, "per scope");
});
