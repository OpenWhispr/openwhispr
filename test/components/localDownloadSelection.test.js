const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("download selection leases reject reconfiguration but retain hidden/closed scoped completion", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__downloadSelection;
  });
  const events = new EventTarget();
  const pending = [];
  installBrowserGlobals(t, {
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      electronAPI: {
        modelGetAll: async () => [],
        modelGetActiveDownloads: async () => [],
        onModelDownloadProgress: () => () => {},
        modelDownload: (id) => new Promise((resolve) => pending.push({ id, resolve })),
      },
    },
  });
  const container = installHostDom(t);
  const state = (globalThis.__downloadSelection = { actions: null, selections: [] });
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/i18n": `export const normalizeUiLanguage = value => value || "en"; export default {language: "en", changeLanguage: async () => {}};`,
      "/ui/ModelCardList": `export default function Cards(props) {globalThis.__downloadSelection.actions = props; return null;}`,
      "/ui/ProviderTabs": `export const ProviderTabs = () => null;`,
      "/utils/providerIcons": `export const getProviderIcon = () => ""; export const isMonochromeProvider = () => false;`,
      "/ui/DownloadProgressBar": `export const DownloadProgressBar = () => null;`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
      "/hooks/useDialogs": `const showAlertDialog = () => {}; export const useDialogs = () => ({confirmDialog: {}, showAlertDialog, showConfirmDialog() {}, hideConfirmDialog() {}});`,
      "/ui/useToast": `const toast = () => {}; export const useToast = () => ({toast});`,
      "/utils/logger": `export default {warn() {}, debug() {}, error() {}, info() {}};`,
    },
  });
  const { default: Picker } = await vite.ssrLoadModule("/components/LocalModelPicker.tsx");
  const { useSettingsStore: store, setResolvedLLMConfig } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { usePolicyStore: policy } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore: identity } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const providers = [
    {
      id: "qwen",
      name: "Qwen",
      models: [{ id: "qwen3.5-9b-q4_k_m", name: "Fake model", size: "1MB" }],
    },
  ];
  root = createRoot(container);
  const render = (props = {}) =>
    React.act(async () =>
      root.render(
        React.createElement(
          "div",
          { hidden: props.hidden },
          React.createElement(Picker, {
            providers,
            selectedModel: "",
            selectedProvider: "qwen",
            onProviderSelect() {},
            onModelSelect: (id) => state.selections.push(id),
            modelType: "llm",
            selectionScope: "dictationCleanup",
            ...props,
          })
        )
      )
    );
  const reset = async () => {
    if (root) await React.act(async () => root.unmount());
    root = createRoot(container);
    state.selections.length = 0;
    store.setState({
      cleanupMode: "local",
      cleanupProvider: "qwen",
      cleanupModel: "",
      useCleanupModel: true,
      enterpriseSetupMode: "manual",
    });
    policy.setState({ status: "unmanaged", policy: null });
    identity.setState({
      status: "idle",
      config: null,
      enforcedScopes: [],
      managedScopes: [],
      accountId: null,
      workspaceId: null,
    });
    await render();
  };
  const begin = async () => {
    await React.act(async () => state.actions.onDownload("qwen3.5-9b-q4_k_m"));
    return pending.at(-1);
  };
  const finish = (request) => React.act(async () => request.resolve({ success: true }));
  for (const change of [
    () => store.setState({ cleanupMode: "providers", cleanupProvider: "openai" }),
    () => store.setState({ cleanupMode: "openwhispr" }),
    () => store.setState({ cleanupModel: "newer-model" }),
    () => store.setState({ useCleanupModel: false }),
    () => policy.setState({ status: "error" }),
    () => identity.setState({ status: "error", enforcedScopes: ["dictationCleanup"] }),
  ]) {
    await reset();
    const request = await begin();
    await React.act(async () => change());
    await finish(request);
    assert.deepEqual(state.selections, [], "obsolete completion only changes disk inventory");
  }
  await reset();
  let request = await begin();
  await React.act(async () => {
    store.setState({ cleanupMode: "providers" });
    store.setState({ cleanupMode: "local" });
  });
  await finish(request);
  assert.deepEqual(state.selections, [], "A→B→A does not renew consent");
  await reset();
  request = await begin();
  await render({ hidden: true, onModelSelect: (id) => state.selections.push("latest:" + id) });
  await finish(request);
  assert.deepEqual(state.selections, ["latest:qwen3.5-9b-q4_k_m"]);
  await reset();
  request = await begin();
  await React.act(async () => root.unmount());
  root = null;
  await finish(request);
  assert.deepEqual(
    state.selections,
    ["qwen3.5-9b-q4_k_m"],
    "close alone leaves unchanged scoped intent valid"
  );
  await reset();
  request = await begin();
  await React.act(async () => root.unmount());
  root = null;
  store.setState({ cleanupMode: "providers" });
  await finish(request);
  assert.deepEqual(state.selections, [], "closed owner cannot overwrite newer configuration");
  await reset();
  store.setState({
    dictationAgentMode: "local",
    dictationAgentProvider: "qwen",
    dictationAgentModel: "",
    useDictationAgent: false,
  });
  await render({
    selectionScope: "dictationAgent",
    onModelSelect: (id) => {
      state.selections.push(id);
      setResolvedLLMConfig("dictationAgent", { model: id });
    },
  });
  request = await begin();
  assert.equal(store.getState().useDictationAgent, false, "agent starts the download disabled");
  await React.act(async () => root.unmount());
  root = null;
  await finish(request);
  assert.deepEqual(
    state.selections,
    [],
    "disabled agent intent cannot select a completed download"
  );
  assert.equal(store.getState().dictationAgentModel, "");
  await reset();
  store.setState({
    dictationAgentMode: "local",
    dictationAgentProvider: "qwen",
    dictationAgentModel: "",
    useDictationAgent: true,
  });
  await render({
    selectionScope: "dictationAgent",
    onModelSelect: (id) => setResolvedLLMConfig("dictationAgent", { model: id }),
  });
  request = await begin();
  await React.act(async () => root.unmount());
  root = null;
  await finish(request);
  assert.equal(
    store.getState().dictationAgentModel,
    "qwen3.5-9b-q4_k_m",
    "closing alone retains enabled agent intent"
  );
  await reset();
  await render({ selectionScope: undefined });
  request = await begin();
  await React.act(async () => root.unmount());
  root = null;
  await finish(request);
  assert.deepEqual(state.selections, [], "unscoped optional selection needs a live owner");
});
