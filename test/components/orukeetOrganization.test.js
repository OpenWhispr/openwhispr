const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const path = require("node:path");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const noop = () => {};
async function renderer(t) {
  installBrowserGlobals(t, {
    window: { location: { search: "" }, electronAPI: { getPlatform: () => "darwin" } },
  });
  return createRendererServer(t, {
    cachePrefix: "openwhispr-oruk-organization-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `export function useTranslation() { return {t(key) {return key;}}; }`,
    },
  });
}

async function render(vite, element) {
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  return renderToStaticMarkup(React.createElement(ToastProvider, null, element));
}

test("onboarding restores an Oruk draft without mixing NVIDIA models", async (t) => {
  const vite = await renderer(t);
  const { LocalModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );
  const markup = await render(
    vite,
    React.createElement(LocalModelSetupStep, {
      stepId: "local-dictation",
      resumeState: { provider: "oruk", modelId: "orukeet-v0.1.0-q8" },
      onReadinessChange: noop,
      onProceed: noop,
      onSkip: noop,
    })
  );
  assert.match(markup, />Oruk</);
  assert.match(markup, />Orukeet</);
  assert.doesNotMatch(markup, />Parakeet TDT/);
});

test("all three model pickers restore the Oruk tab from the persisted Orukeet choice", async (t) => {
  const vite = await renderer(t);
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  for (const transcriptionContext of ["dictation", "upload", "meeting"]) {
    const markup = await render(
      vite,
      React.createElement(Picker, {
        transcriptionContext,
        selectedLocalProvider: "nvidia",
        selectedLocalModel: "orukeet-v0.1.0-q8",
        useLocalWhisper: true,
        onLocalModelSelect: noop,
        onModeChange: noop,
      })
    );
    assert.match(markup, />Orukeet</, transcriptionContext);
    assert.doesNotMatch(markup, />Parakeet TDT/, transcriptionContext);
  }
});

test("a saved stock Parakeet choice opens NVIDIA while retaining Oruk as a selectable organization", async (t) => {
  const vite = await renderer(t);
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const markup = await render(
    vite,
    React.createElement(Picker, {
      selectedLocalProvider: "nvidia",
      selectedLocalModel: "parakeet-tdt-0.6b-v3",
      useLocalWhisper: true,
      onLocalModelSelect: noop,
      onModeChange: noop,
    })
  );
  assert.match(markup, />Oruk</);
  assert.match(markup, />Parakeet TDT/);
  assert.doesNotMatch(markup, />Orukeet</);
});

test("adding Orukeet preserves fresh-install transcription modes and existing backend defaults", async (t) => {
  const vite = await renderer(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  for (const prefix of ["", "meeting", "upload"]) {
    const key = (name) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
    assert.equal(state[key("useLocalWhisper")], false);
    assert.equal(state[key("localTranscriptionProvider")], "whisper");
    assert.equal(state[key("parakeetModel")], "");
  }
});

test("Oruk's model-picker tab follows the same unsupported-macOS fallback as Parakeet", async (t) => {
  const vite = await renderer(t);
  const container = installHookDom(t);
  globalThis.window.electronAPI.checkParakeetInstallation = async () => ({
    supported: false,
    minimumMacOSVersion: "15.5",
  });
  globalThis.window.electronAPI.listParakeetModels = async () => ({ success: true, models: [] });
  globalThis.window.electronAPI.listWhisperModels = async () => ({ success: true, models: [] });
  globalThis.window.electronAPI.onWhisperDownloadProgress = () => noop;
  globalThis.window.electronAPI.onParakeetDownloadProgress = () => noop;
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  const selectedProviders = [];
  let tree;
  function Harness() {
    tree = Picker({
      selectedLocalProvider: "nvidia",
      selectedLocalModel: "orukeet-v0.1.0-q8",
      useLocalWhisper: true,
      onLocalModelSelect: noop,
      onLocalProviderSelect: (provider) => selectedProviders.push(provider),
      onModeChange: noop,
    });
    return null;
  }
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(
          ToastContext.Provider,
          { value: { toast: noop } },
          React.createElement(Harness)
        )
      );
    });
    function find(node) {
      if (Array.isArray(node)) return node.map(find).find(Boolean);
      if (!node || typeof node !== "object") return null;
      if (node.props?.providers?.some((provider) => provider.id === "oruk")) return node;
      return find(node.props?.children);
    }
    const tabs = find(tree);
    assert.ok(tabs);
    for (const organization of ["oruk", "nvidia", "cohere"]) {
      assert.equal(
        tabs.props.providers.find((provider) => provider.id === organization).disabled,
        true
      );
    }
    assert.equal(tabs.props.selectedId, "whisper");
    assert.ok(selectedProviders.includes("whisper"));
  } finally {
    await React.act(async () => root.unmount());
  }
});
