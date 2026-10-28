const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const PROVIDERS = [
  {
    id: "llama",
    name: "Llama",
    models: [
      { id: "llama-small", name: "Llama Small", size: "1GB", legacy: true },
      { id: "llama-large", name: "Llama Large", size: "2GB", legacy: true },
    ],
  },
  {
    id: "qwen",
    name: "Qwen",
    models: [{ id: "qwen-current", name: "Qwen Current", size: "3GB" }],
  },
];

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : findElement(node.props?.children, predicate);
}

// Renders the picker with its hooks and returns the tabs and model list it shows.
async function renderPicker(t, { selectedProvider, selectedModel = "", downloaded = [] }) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        modelGetAll: async () => downloaded.map((id) => ({ id, isDownloaded: true })),
        modelGetActiveDownloads: async () => [],
        onModelDownloadProgress: () => () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-picker-legacy-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { default: LocalModelPicker } = await vite.ssrLoadModule(
    "/components/LocalModelPicker.tsx"
  );
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  // Stable props, as the parent passes them: the picker's own state changes
  // re-render this harness, and fresh callbacks would re-run its load effect.
  const props = {
    providers: PROVIDERS,
    selectedModel,
    selectedProvider,
    onModelSelect: () => {},
    onProviderSelect: () => {},
    modelType: "llm",
  };
  let tree;
  function Harness() {
    tree = LocalModelPicker(props);
    return null;
  }
  const root = createRoot(container);
  const toast = { toast: () => "test-toast" };
  await React.act(async () =>
    root.render(
      React.createElement(ToastContext.Provider, { value: toast }, React.createElement(Harness))
    )
  );
  await React.act(async () => root.unmount());
  const tabs = findElement(tree, (node) => Array.isArray(node.props?.providers));
  const list = findElement(tree, (node) => Array.isArray(node.props?.models));
  return {
    tabIds: tabs.props.providers.map((provider) => provider.id),
    openTab: tabs.props.selectedId,
    modelIds: list.props.models.map((model) => model.value),
  };
}

test("a provider left with nothing to list opens on one that has models", async (t) => {
  // The user deleted their selected Llama model: the store still says llama.
  const shown = await renderPicker(t, { selectedProvider: "llama" });
  assert.deepEqual(shown.tabIds, ["qwen"]);
  assert.equal(shown.openTab, "qwen");
  assert.deepEqual(shown.modelIds, ["qwen-current"]);
});

test("a provider stays open while its legacy model is selected", async (t) => {
  const shown = await renderPicker(t, {
    selectedProvider: "llama",
    selectedModel: "llama-small",
    downloaded: ["llama-small"],
  });
  assert.deepEqual(shown.tabIds, ["llama", "qwen"]);
  assert.equal(shown.openTab, "llama");
  assert.deepEqual(shown.modelIds, ["llama-small", "llama-large"]);
});

test("a downloaded legacy model keeps its tab so it can be deleted", async (t) => {
  const shown = await renderPicker(t, { selectedProvider: "llama", downloaded: ["llama-large"] });
  assert.deepEqual(shown.tabIds, ["llama", "qwen"]);
  assert.equal(shown.openTab, "llama");
});
