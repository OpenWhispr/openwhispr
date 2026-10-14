const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("retained transcription pickers reconcile only confirmed, current backend inventories", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const events = new EventTarget();
  const parakeet = "parakeet-tdt-0.6b-v3";
  const survivor = "parakeet-unified-en-0.6b";
  const cohere = "cohere-transcribe-03-2026";
  let sherpaInventory = [parakeet, survivor, cohere].map((model) => ({ model, downloaded: true }));
  let whisperInventory = [{ model: "base", downloaded: true }];
  const api = {
    getPlatform: () => "darwin",
    listWhisperModels: async () => ({ success: true, models: whisperInventory }),
    listParakeetModels: async () => ({ success: true, models: sherpaInventory }),
    modelGetActiveDownloads: async () => [],
    onWhisperDownloadProgress: () => () => {},
    onParakeetDownloadProgress: () => () => {},
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-transcription-inventory-",
    noExternal: ["react-i18next"],
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/ui/ProviderTabs": `export const ProviderTabs = () => null;`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
      "/hooks/useDialogs": `
        const noop = () => {};
        const dialogs = {confirmDialog: {open: false}, showConfirmDialog: noop, hideConfirmDialog: noop, showAlertDialog: noop};
        export const useDialogs = () => dialogs;`,
      "/components/ui/useToast": `const context = {toast() {}}; export const useToast = () => context;`,
      "/hooks/usePolicy": `const policy = {status: "unmanaged", policy: null}; export const usePolicySnapshot = () => policy;`,
      "/stores/settingsStore": `
        const settings = {isSignedIn: false};
        export const useSettingsStore = selector => selector(settings);
        export const clearMissingLocalModelSelections = () => {};`,
    },
  });
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  let choices = {
    dictation: { model: parakeet, provider: "nvidia" },
    meeting: { model: survivor, provider: "nvidia" },
    upload: { model: cohere, provider: "cohere" },
  };
  const changes = [];
  const render = () =>
    root.render(
      React.createElement(
        "div",
        null,
        Object.entries(choices).map(([context, choice]) =>
          React.createElement(
            "div",
            {
              key: context,
              hidden: context !== "dictation",
            },
            React.createElement(Picker, {
              transcriptionContext: context,
              selectedLocalModel: choice.model,
              selectedLocalProvider: choice.provider,
              selectedCloudProvider: "openai",
              selectedCloudModel: "whisper-1",
              useLocalWhisper: true,
              mode: "local",
              onCloudProviderSelect() {},
              onCloudModelSelect() {},
              onModeChange() {},
              onLocalModelSelect: (model, provider) => changes.push({ context, model, provider }),
              onLocalProviderSelect: () => assert.fail("reconciliation must not switch providers"),
            })
          )
        )
      )
    );
  root = createRoot(container);
  await React.act(async () => render());
  assert.deepEqual(changes, []);

  // Mixed deletion: removed Parakeet and Cohere, but one NVIDIA model survived.
  sherpaInventory = sherpaInventory.map((entry) => ({
    ...entry,
    downloaded: entry.model === survivor,
  }));
  const refresh = () =>
    React.act(async () => events.dispatchEvent(new Event("openwhispr-models-cleared")));
  await refresh();
  assert.deepEqual(changes, [
    { context: "dictation", model: survivor, provider: "nvidia" },
    { context: "upload", model: "", provider: "cohere" },
  ]);
  changes.length = 0;
  choices = {
    dictation: { model: survivor, provider: "nvidia" },
    meeting: { model: "foreign-model", provider: "nvidia" },
    upload: { model: "base", provider: "whisper" },
  };
  await React.act(async () => render());
  assert.deepEqual(changes, [], "surviving and foreign selections stay untouched");
  whisperInventory = [
    { model: "base", downloaded: false },
    { model: "tiny", downloaded: true },
  ];
  await refresh();
  assert.deepEqual(changes, [{ context: "upload", model: "tiny", provider: "whisper" }]);

  choices = { dictation: { model: parakeet, provider: "nvidia" } };
  api.listParakeetModels = async () => ({ success: false });
  changes.length = 0;
  await React.act(async () => render());
  await refresh();
  assert.deepEqual(changes, [], "failed reads cannot prove deletion");
  api.listParakeetModels = async () => {
    throw new Error("inventory failed");
  };
  await refresh();
  assert.deepEqual(changes, []);

  const pending = [];
  api.listParakeetModels = () => new Promise((resolve) => pending.push(resolve));
  await refresh();
  assert.equal(pending.length, 1);
  // A newer refresh supersedes a pre-deletion snapshot, even though reads serialize.
  await refresh();
  await React.act(async () => pending[0]({ success: true, models: sherpaInventory }));
  assert.deepEqual(changes, []);
  assert.equal(pending.length, 2);
  choices = { dictation: { model: cohere, provider: "cohere" } };
  await React.act(async () => render());
  await React.act(async () => pending[1]({ success: true, models: sherpaInventory }));
  assert.deepEqual(changes, [], "an old backend reply cannot edit the new backend's setting");
  assert.equal(pending.length, 3);
  await React.act(async () =>
    pending[2]({ success: true, models: [{ model: cohere, downloaded: true }] })
  );
  assert.deepEqual(changes, []);

  await refresh();
  const late = pending.at(-1);
  await React.act(async () => root.unmount());
  root = null;
  await React.act(async () =>
    late({ success: true, models: [{ model: cohere, downloaded: false }] })
  );
  assert.deepEqual(changes, [], "unmounted owners cannot reconcile preferences");
});
