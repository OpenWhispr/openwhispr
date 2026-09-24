const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const noop = () => {};
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

function electronApi() {
  const fixed = {
    getPlatform: () => "darwin",
    checkParakeetInstallation: async () => ({ supported: true }),
    listParakeetModels: async () => ({ success: true, models: [] }),
    listWhisperModels: async () => ({ success: true, models: [] }),
  };
  return new Proxy(fixed, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && prop.startsWith("on")) return () => noop;
      return async () => undefined;
    },
  });
}

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.props && predicate(node.props)) return node;
  return find(node.props?.children, predicate);
}

// Custom endpoints pointed at OpenRouter predate the OpenRouter tab. Leaving the
// endpoint field must not move them onto it: that swaps their model, reads a
// different key slot and drops the WAV re-encode only Custom applies.
test("leaving a Custom endpoint set to OpenRouter keeps the Custom setup", async (t) => {
  installBrowserGlobals(t, { window: { location: { search: "" }, electronAPI: electronApi() } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-picker-custom-openrouter-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t(key) { return key; }, i18n: { language: "en" } }; }`,
    },
  });
  const container = installHookDom(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");

  for (const context of ["dictation", "upload"]) {
    const key = (name) =>
      context === "upload" ? `upload${name[0].toUpperCase()}${name.slice(1)}` : name;
    const setter = (name) => `set${key(name)[0].toUpperCase()}${key(name).slice(1)}`;
    useSettingsStore.setState({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      [key("cloudTranscriptionProvider")]: "custom",
      [key("cloudTranscriptionModel")]: "microsoft/mai-transcribe-2",
      [key("cloudTranscriptionBaseUrl")]: OPENROUTER_URL,
    });

    let tree;
    function Harness() {
      const s = useSettingsStore();
      tree = Picker({
        transcriptionContext: context,
        selectedCloudProvider: s[key("cloudTranscriptionProvider")],
        onCloudProviderSelect: s[setter("cloudTranscriptionProvider")],
        selectedCloudModel: s[key("cloudTranscriptionModel")],
        onCloudModelSelect: s[setter("cloudTranscriptionModel")],
        selectedLocalModel: "",
        onLocalModelSelect: noop,
        useLocalWhisper: false,
        onModeChange: noop,
        mode: "cloud",
        cloudTranscriptionBaseUrl: s[key("cloudTranscriptionBaseUrl")],
        setCloudTranscriptionBaseUrl: s[setter("cloudTranscriptionBaseUrl")],
        variant: "settings",
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
      const urlInput = find(
        tree,
        (props) => typeof props.onBlur === "function" && props.value === OPENROUTER_URL
      );
      assert.ok(urlInput, `${context}: the Custom endpoint field renders`);
      await React.act(async () => urlInput.props.onBlur());

      const state = useSettingsStore.getState();
      assert.equal(state[key("cloudTranscriptionProvider")], "custom", context);
      assert.equal(state[key("cloudTranscriptionModel")], "microsoft/mai-transcribe-2", context);
    } finally {
      await React.act(async () => root.unmount());
    }
  }
});
