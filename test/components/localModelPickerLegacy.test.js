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
      { id: "llama-3.2-3b-instruct-q4_k_m", name: "Llama Small", size: "1GB", legacy: true },
      { id: "llama-3.1-8b-instruct-q4_k_m", name: "Llama Large", size: "2GB", legacy: true },
    ],
  },
  {
    id: "qwen",
    name: "Qwen",
    models: [{ id: "qwen3.5-4b-q4_k_m", name: "Qwen Current", size: "3GB" }],
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
async function renderPicker(t, { selectedProvider, selectedModel = "", downloaded = [], policy }) {
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
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  if (policy) usePolicyStore.setState(policy);
  const { default: LocalModelPicker } = await vite.ssrLoadModule(
    "/components/LocalModelPicker.tsx"
  );
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  // Stable props, as the parent passes them: the picker's own state changes
  // re-render this harness, and fresh callbacks would re-run its load effect.
  const selections = [];
  const props = {
    providers: PROVIDERS,
    selectedModel,
    selectedProvider,
    onModelSelect: (id) => selections.push(id),
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
    models: list.props.models,
    select: list.props.onModelSelect,
    selections,
  };
}

test("a provider left with nothing to list opens on one that has models", async (t) => {
  // The user deleted their selected Llama model: the store still says llama.
  const shown = await renderPicker(t, { selectedProvider: "llama" });
  assert.deepEqual(shown.tabIds, ["qwen"]);
  assert.equal(shown.openTab, "qwen");
  assert.deepEqual(shown.modelIds, ["qwen3.5-4b-q4_k_m"]);
});

test("a provider stays open while its legacy model is selected", async (t) => {
  const shown = await renderPicker(t, {
    selectedProvider: "llama",
    selectedModel: "llama-3.2-3b-instruct-q4_k_m",
    downloaded: ["llama-3.2-3b-instruct-q4_k_m"],
  });
  assert.deepEqual(shown.tabIds, ["llama", "qwen"]);
  assert.equal(shown.openTab, "llama");
  assert.deepEqual(shown.modelIds, [
    "llama-3.2-3b-instruct-q4_k_m",
    "llama-3.1-8b-instruct-q4_k_m",
  ]);
});

test("a downloaded legacy model keeps its tab so it can be deleted", async (t) => {
  const shown = await renderPicker(t, {
    selectedProvider: "llama",
    downloaded: ["llama-3.1-8b-instruct-q4_k_m"],
  });
  assert.deepEqual(shown.tabIds, ["llama", "qwen"]);
  assert.equal(shown.openTab, "llama");
});

test("a denied installed-only family stays browsable with inert Delete-only rows", async (t) => {
  const shown = await renderPicker(t, {
    selectedProvider: "llama",
    selectedModel: "llama-3.2-3b-instruct-q4_k_m",
    downloaded: ["llama-3.2-3b-instruct-q4_k_m"],
    policy: {
      status: "managed",
      appVersion: "1.11.1",
      policy: {
        llm: { allowedModes: ["local"], allowedLocalModels: ["qwen3.5-4b-q4_k_m"] },
        transcription: { allowedModes: ["local"] },
        minAppVersion: null,
      },
    },
  });
  assert.deepEqual(shown.tabIds, ["llama", "qwen"]);
  assert.deepEqual(shown.modelIds, ["llama-3.2-3b-instruct-q4_k_m"]);
  assert.equal(shown.models[0].policyBlocked, true);
  shown.select("llama-3.2-3b-instruct-q4_k_m");
  assert.deepEqual(shown.selections, []);
});

test("a denied missing saved model does not clear preferences or expose a download", async (t) => {
  const shown = await renderPicker(t, {
    selectedProvider: "qwen",
    selectedModel: "qwen3.5-4b-q4_k_m",
    policy: {
      status: "managed",
      appVersion: "1.11.1",
      policy: {
        llm: { allowedModes: ["local"], allowedLocalModels: [] },
        transcription: { allowedModes: ["local"] },
        minAppVersion: null,
      },
    },
  });
  assert.deepEqual(shown.tabIds, []);
  assert.deepEqual(shown.modelIds, []);
  assert.deepEqual(shown.selections, []);
});
