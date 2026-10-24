const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function find(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((child) => find(child, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)];
}

async function mountPicker(t) {
  let unmount = async () => {};
  t.after(() => unmount());
  installBrowserGlobals(t, {
    initialStorage: {
      cloudTranscriptionProvider: "gemini",
      cloudTranscriptionModel: "gemini-3.5-transcribe",
    },
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        checkParakeetInstallation: async () => ({ supported: true }),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gemini-picker-",
    resolveAlias: { "@": require("node:path").resolve(__dirname, "../../src") },
    noExternal: ["react-i18next"],
    mockModules: {
      "../hooks/useModelDownload": `export function useModelDownload() { return {downloads:{},isDownloadingModel:()=>false,isCancellingModel:()=>false}; }`,
      "../components/ui/useToast": `export function useToast() { return {toast(){}}; }`,
      "./ui/useToast": `export function useToast() { return {toast(){}}; }`,
      "react-i18next": `const t = (key) => key; export function useTranslation() { return {t}; } export const initReactI18next = {type:'3rdParty',init(){}};`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  let tree;
  let props = {
    transcriptionContext: "dictation",
    selectedCloudProvider: "gemini",
    selectedCloudModel: "gemini-3.5-transcribe",
    selectedLocalModel: "base",
    useLocalWhisper: false,
    mode: "cloud",
    onCloudProviderSelect() {},
    onCloudModelSelect() {},
    onLocalModelSelect() {},
    onModeChange() {},
  };
  function Harness() {
    tree = Picker(props);
    return null;
  }
  const root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(Harness)));
  await render();
  unmount = () => React.act(async () => root.unmount());
  return {
    store: useSettingsStore,
    modeSelect: () =>
      find(
        tree,
        (node) => node.props?.onValueChange && ["smart", "verbatim"].includes(node.props.value)
      )[0],
    rerender: async (patch) => {
      props = { ...props, ...patch };
      await render();
    },
  };
}

test("Gemini batch dictation offers an opt-in mode selector and saves its choice", async (t) => {
  const picker = await mountPicker(t);
  assert.ok(picker.modeSelect(), "batch dictation must offer the mode selector");
  assert.equal(picker.modeSelect().props.value, "verbatim");
  await React.act(async () => picker.modeSelect().props.onValueChange("smart"));
  assert.equal(picker.modeSelect().props.value, "smart");
  assert.equal(picker.store.getState().geminiDictationMode, "smart");
  assert.equal(localStorage.getItem("geminiDictationMode"), "smart");
  await React.act(async () => picker.modeSelect().props.onValueChange("verbatim"));
  assert.equal(picker.store.getState().geminiDictationMode, "verbatim");
});

test("the Gemini dictation mode is not offered for live, uploads, meetings or other providers", async (t) => {
  const picker = await mountPicker(t);
  for (const patch of [
    { selectedCloudModel: "gemini-3.5-transcribe-live" },
    { selectedCloudModel: "gemini-3.5-transcribe", transcriptionContext: "upload" },
    { transcriptionContext: "meeting", streamingOnly: true },
    {
      transcriptionContext: "dictation",
      streamingOnly: false,
      selectedCloudProvider: "openai",
      selectedCloudModel: "gpt-4o-mini-transcribe",
    },
  ]) {
    await picker.rerender(patch);
    assert.equal(picker.modeSelect(), undefined);
  }
});
