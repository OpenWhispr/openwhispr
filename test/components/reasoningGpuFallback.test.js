const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const en = require("../../src/locales/en/translation.json");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

async function showBadge(t, serverStatus) {
  installBrowserGlobals(t, {
    window: {
      location: { search: "" },
      electronAPI: {
        getPlatform: () => "linux",
        llamaServerStatus: async () => serverStatus,
        getLlamaVulkanStatus: async () => ({
          downloaded: true,
          downloading: false,
          supported: true,
        }),
        detectVulkanGpu: async () => ({ available: true }),
        onLlamaVulkanDownloadProgress: () => () => {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-gpu-fallback-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { GpuStatusBadge } = await vite.ssrLoadModule("/components/ReasoningModelSelector.tsx");
  const root = createRoot(installHookDom(t));
  let tree;
  function Harness() {
    tree = GpuStatusBadge();
    return null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return {
    shows: (text) => Boolean(find(tree, (node) => node.props?.children === text)),
    unmount: () => React.act(async () => root.unmount()),
  };
}

const server = (backend, gpuFallbackReason = null) => ({
  available: true,
  running: backend !== null,
  port: backend ? 8221 : null,
  modelPath: null,
  modelName: null,
  backend,
  gpuAccelerated: backend === "vulkan",
  gpuFallbackReason,
});

test("a downloaded Vulkan pack shows the GPU memory fallback after reopening Settings", async (t) => {
  const badge = await showBadge(t, server("cpu", "out_of_memory"));
  try {
    assert.ok(badge.shows(en.gpu.activationFailed));
    assert.ok(badge.shows(en.gpu.reasoningOutOfMemoryDescription));
    assert.ok(!badge.shows(en.gpu.retryActivation));
    assert.ok(!badge.shows(en.gpu.ready));
  } finally {
    await badge.unmount();
  }
});

test("an unknown GPU startup failure gives a truthful CPU fallback message", async (t) => {
  const badge = await showBadge(t, server("cpu", "startup_failed"));
  try {
    assert.ok(badge.shows(en.gpu.reasoningActivationFailedDescription));
    assert.ok(badge.shows(en.gpu.retryActivation));
    assert.ok(!badge.shows(en.gpu.reasoningOutOfMemoryDescription));
  } finally {
    await badge.unmount();
  }
});

test("an idle server shows the GPU pack as ready", async (t) => {
  const badge = await showBadge(t, server(null));
  try {
    assert.ok(badge.shows(en.gpu.ready));
    assert.ok(!badge.shows(en.gpu.activationFailed));
  } finally {
    await badge.unmount();
  }
});

test("a running Vulkan server is shown as active", async (t) => {
  const badge = await showBadge(t, server("vulkan"));
  try {
    assert.ok(badge.shows(en.gpu.active));
    assert.ok(!badge.shows(en.gpu.activationFailed));
  } finally {
    await badge.unmount();
  }
});
