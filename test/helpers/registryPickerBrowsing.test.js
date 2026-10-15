const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("browsing reasoning providers survives rerenders and a live catalog update", async (t) => {
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const React = require("react");
  const previousReact = globalThis.React;
  globalThis.React = React;
  t.after(() => {
    if (previousReact === undefined) delete globalThis.React;
    else globalThis.React = previousReact;
    delete globalThis.registryPickerTabs;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "registry-picker-",
    mockModules: {
      "/ui/ProviderTabs": `export const ProviderTabs = props => { globalThis.registryPickerTabs = props; return null; };`,
      "/ui/ApiKeyInput": "export default () => null;",
      "/ui/ModelCardList": "export default () => null;",
      "/LocalModelPicker": "export default () => null;",
      "/OpenAICompatiblePanel": "export default () => null;",
      "/ui/GetApiKeyLink": "export const GetApiKeyLink = () => null;",
      "/hooks/usePolicy":
        "export const usePolicySnapshot = () => ({status:'unmanaged',policy:null});",
      "/hooks/useTinfoilModels":
        "export const useTinfoilModels = () => ({models:[],loading:false,error:null});",
      "/utils/platform": "export const getCachedPlatform = () => 'darwin';",
      "/utils/providerIcons": "export const getRemoteProviderIcon = () => ({});",
      "react-i18next": "const t = key => key; export const useTranslation = () => ({t});",
    },
  });
  const { default: Selector } = await vite.ssrLoadModule("/components/ReasoningModelSelector.tsx");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  const props = {
    mode: "cloud",
    localReasoningProvider: "openai",
    reasoningModel: "gpt-5-mini",
    setReasoningModel() {},
    setLocalReasoningProvider() {},
    cloudReasoningBaseUrl: "",
    setCloudReasoningBaseUrl() {},
  };
  try {
    await React.act(async () => root.render(React.createElement(Selector, props)));
    assert.equal(globalThis.registryPickerTabs.selectedId, "openai");
    await React.act(async () => globalThis.registryPickerTabs.onSelect("groq"));
    assert.equal(globalThis.registryPickerTabs.selectedId, "groq");
    const data = structuredClone(store.getRegistryData());
    data.cloudProviders
      .find((p) => p.id === "groq")
      .models.push({ id: "new-groq", name: "New", description: "Fixture" });
    await React.act(async () =>
      store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 })
    );
    assert.equal(globalThis.registryPickerTabs.selectedId, "groq");
  } finally {
    await React.act(async () => root.unmount());
  }
});
