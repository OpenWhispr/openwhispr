const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const REMOTE_MODEL = "remote-batch-transcribe";

async function mountPicker(t, { catalogContainsModel, policy = null }) {
  let unmount = async () => {};
  t.after(() => unmount());
  installBrowserGlobals(t, {
    initialStorage: {
      publishedModelIds: JSON.stringify([
        JSON.stringify(["transcriptionProviders", "openai", REMOTE_MODEL]),
      ]),
    },
  });
  const container = installHostDom(t);
  const React = require("react");
  const previousReact = globalThis.React;
  globalThis.React = React;
  globalThis.transcriptionPickerPolicy = policy ?? { status: "unmanaged", policy: null };
  t.after(() => {
    if (previousReact === undefined) delete globalThis.React;
    else globalThis.React = previousReact;
    delete globalThis.transcriptionPickerPolicy;
    delete globalThis.transcriptionPickerModels;
    delete globalThis.transcriptionPickerTabs;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "transcription-picker-history-",
    mockModules: {
      "/ui/ProviderTabs":
        "export const ProviderTabs = props => { globalThis.transcriptionPickerTabs = props; return null; };",
      "/ui/ModelCardList":
        "export default props => { globalThis.transcriptionPickerModels = props; return null; };",
      "/ui/ApiKeyInput": "export default () => null;",
      "/ui/GetApiKeyLink": "export const GetApiKeyLink = () => null;",
      "/hooks/usePolicy":
        "export const usePolicySnapshot = () => globalThis.transcriptionPickerPolicy;",
      "/stores/settingsStore":
        "const state = { isSignedIn: false }; export const useSettingsStore = selector => selector(state);",
      "/hooks/useModelDownload":
        "export const useModelDownload = () => ({ downloads: {}, isDownloadingModel: () => false, isCancellingModel: () => false });",
      "/utils/platform": "export const getCachedPlatform = () => 'darwin';",
      "/utils/providerIcons": "export const getRemoteProviderIcon = () => ({});",
      "react-i18next": "const t = key => key; export const useTranslation = () => ({t});",
    },
  });
  const store = await vite.ssrLoadModule("/models/registryData.js");
  if (catalogContainsModel) {
    const data = structuredClone(store.getRegistryData());
    data.transcriptionProviders
      .find((provider) => provider.id === "openai")
      .models.push({
        id: REMOTE_MODEL,
        name: "Remote batch model",
        description: "Test catalog addition",
        streaming: false,
      });
    assert.equal(
      store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 }),
      true
    );
  }
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  const selections = [];
  const props = {
    transcriptionContext: "meeting",
    streamingOnly: true,
    mode: "cloud",
    selectedCloudProvider: "openai",
    selectedCloudModel: REMOTE_MODEL,
    onCloudProviderSelect() {},
    onCloudModelSelect: (id) => selections.push(id),
    selectedLocalModel: "",
    onLocalModelSelect() {},
    onModeChange() {},
  };
  unmount = () => React.act(async () => root.unmount());
  await React.act(async () => root.render(React.createElement(Picker, props)));
  return { selections };
}

test("a published batch model present in the catalog cannot remain the meeting selection", async (t) => {
  const { selections } = await mountPicker(t, { catalogContainsModel: true });
  const displayed = globalThis.transcriptionPickerModels;
  assert.ok(displayed, "the real picker rendered its model list");
  assert.equal(
    displayed.models.some((model) => model.value === REMOTE_MODEL),
    false
  );
  assert.notEqual(displayed.selectedModel, REMOTE_MODEL);
  assert.ok(displayed.models.some((model) => model.value === displayed.selectedModel));
  assert.ok(selections.length > 0, "the unsupported selection is corrected");
  assert.ok(selections.every((id) => id !== REMOTE_MODEL));
});

test("a previously published model missing after cache loss preserves the allowed provider's saved pick", async (t) => {
  const { selections } = await mountPicker(t, { catalogContainsModel: false });
  assert.equal(globalThis.transcriptionPickerTabs.selectedId, "openai");
  assert.equal(globalThis.transcriptionPickerModels.selectedModel, REMOTE_MODEL);
  assert.deepEqual(selections, [], "missing catalog data must not overwrite the stored choice");
});

test("publication history cannot preserve a provider denied by policy", async (t) => {
  const { selections } = await mountPicker(t, {
    catalogContainsModel: false,
    policy: {
      status: "managed",
      policy: {
        transcription: { allowedModes: ["providers"], allowedByokProviders: ["deepgram"] },
      },
    },
  });
  assert.equal(globalThis.transcriptionPickerTabs.selectedId, "deepgram");
  assert.notEqual(globalThis.transcriptionPickerModels.selectedModel, REMOTE_MODEL);
  assert.deepEqual(selections, [], "managed fallback is display-only");
});
