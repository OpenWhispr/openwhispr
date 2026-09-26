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

const key = (context, name) =>
  context === "upload" ? `upload${name[0].toUpperCase()}${name.slice(1)}` : name;
const setter = (context, name) => {
  const field = key(context, name);
  return `set${field[0].toUpperCase()}${field.slice(1)}`;
};

// Mounts the picker for one scope, wired to the real settings store the way
// the Settings page wires it; returns its element tree and an unmount.
async function loadPicker(t) {
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

  const mount = async (context) => {
    let tree;
    function Harness() {
      const s = useSettingsStore();
      tree = Picker({
        transcriptionContext: context,
        selectedCloudProvider: s[key(context, "cloudTranscriptionProvider")],
        onCloudProviderSelect: s[setter(context, "cloudTranscriptionProvider")],
        selectedCloudModel: s[key(context, "cloudTranscriptionModel")],
        onCloudModelSelect: s[setter(context, "cloudTranscriptionModel")],
        selectedLocalModel: "",
        onLocalModelSelect: noop,
        useLocalWhisper: false,
        onModeChange: noop,
        mode: "cloud",
        cloudTranscriptionBaseUrl: s[key(context, "cloudTranscriptionBaseUrl")],
        setCloudTranscriptionBaseUrl: s[setter(context, "cloudTranscriptionBaseUrl")],
        variant: "settings",
      });
      return null;
    }
    const root = createRoot(container);
    await React.act(async () => {
      root.render(
        React.createElement(
          ToastContext.Provider,
          { value: { toast: noop } },
          React.createElement(Harness)
        )
      );
    });
    return { tree: () => tree, unmount: () => React.act(async () => root.unmount()) };
  };
  return { useSettingsStore, mount };
}

// Custom endpoints pointed at OpenRouter predate the OpenRouter tab. Leaving the
// endpoint field must not move them onto it: that swaps their model, reads a
// different key slot and drops the WAV re-encode only Custom applies.
test("leaving a Custom endpoint set to OpenRouter keeps the Custom setup", async (t) => {
  const { useSettingsStore, mount } = await loadPicker(t);
  for (const context of ["dictation", "upload"]) {
    useSettingsStore.setState({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      [key(context, "cloudTranscriptionProvider")]: "custom",
      [key(context, "cloudTranscriptionModel")]: "microsoft/mai-transcribe-2",
      [key(context, "cloudTranscriptionBaseUrl")]: OPENROUTER_URL,
    });

    const picker = await mount(context);
    try {
      const urlInput = find(
        picker.tree(),
        (props) => typeof props.onBlur === "function" && props.value === OPENROUTER_URL
      );
      assert.ok(urlInput, `${context}: the Custom endpoint field renders`);
      await React.act(async () => urlInput.props.onBlur());

      const state = useSettingsStore.getState();
      assert.equal(state[key(context, "cloudTranscriptionProvider")], "custom", context);
      assert.equal(
        state[key(context, "cloudTranscriptionModel")],
        "microsoft/mai-transcribe-2",
        context
      );
    } finally {
      await picker.unmount();
    }
  }
});

// OpenRouter's catalog moves faster than our releases, so the store and the
// request resolver keep a vendor-prefixed id the shortlist does not list.
// Opening Settings reset it anyway: the picker checked the registry alone and
// saved its correction.
test("opening Settings keeps an OpenRouter model outside the shortlist", async (t) => {
  const { useSettingsStore, mount } = await loadPicker(t);
  for (const context of ["dictation", "upload"]) {
    useSettingsStore.setState({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      [key(context, "cloudTranscriptionProvider")]: "openrouter",
      [key(context, "cloudTranscriptionModel")]: "qwen/qwen3-asr-flash-2026-02-10",
    });

    const picker = await mount(context);
    await picker.unmount();

    assert.equal(
      useSettingsStore.getState()[key(context, "cloudTranscriptionModel")],
      "qwen/qwen3-asr-flash-2026-02-10",
      context
    );
  }
});
