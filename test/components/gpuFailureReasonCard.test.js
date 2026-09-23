const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const path = require("node:path");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The GPU card in the transcription model picker shows the whisper-server error
// line that main saved with a GPU->CPU fallback (#1736).
const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";
const OUT_OF_DEVICE_MEMORY = "vk::Device::allocateMemory: ErrorOutOfDeviceMemory";
const noop = () => {};

const vulkanPack = (overrides = {}) => ({
  downloaded: true,
  downloading: false,
  vulkan: { available: true },
  hasNvidiaGpu: false,
  gpuFailed: false,
  gpuFailReason: null,
  ...overrides,
});

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

const isFailedCard = (node) => String(node.props?.className ?? "").includes("border-warning/40");
const hasText = (text) => (node) => node.props?.children === text;

// Lets the picker's IPC reads (status on mount, re-read after a fallback) land
function settle() {
  return React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mountPicker(t, vulkanStatus) {
  installBrowserGlobals(t, {
    window: { location: { search: "" }, electronAPI: { getPlatform: () => "win32" } },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-failure-reason-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const container = installHookDom(t);
  const pack = { status: vulkanStatus, statusReads: 0 };
  const vulkanFallbackListeners = [];
  Object.assign(globalThis.window.electronAPI, {
    checkParakeetInstallation: async () => ({ supported: true }),
    listParakeetModels: async () => ({ success: true, models: [] }),
    listWhisperModels: async () => ({ success: true, models: [] }),
    onWhisperDownloadProgress: () => noop,
    onParakeetDownloadProgress: () => noop,
    getCudaWhisperStatus: async () => ({
      downloaded: false,
      downloading: false,
      path: null,
      gpuInfo: { hasNvidiaGpu: false },
      gpuFailed: false,
      gpuFailReason: null,
    }),
    getVulkanWhisperStatus: async () => {
      pack.statusReads += 1;
      return pack.status;
    },
    whisperServerStatus: async () => ({ gpuAccelerated: false }),
    onCudaFallbackNotification: () => noop,
    onGpuFallbackNotification: (callback) => {
      vulkanFallbackListeners.push(callback);
      return noop;
    },
  });
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  let tree;
  function Harness() {
    tree = Picker({
      selectedLocalProvider: "whisper",
      selectedLocalModel: "base",
      useLocalWhisper: true,
      onLocalModelSelect: noop,
      onModeChange: noop,
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
  await settle();
  return {
    pack,
    find: (predicate) => findElement(tree, predicate),
    // Main has already saved the new failure when it sends this notification
    fireVulkanFallback: async (nextStatus) => {
      pack.status = nextStatus;
      await React.act(async () => {
        for (const listener of vulkanFallbackListeners) listener();
      });
      await settle();
    },
    unmount: () => React.act(async () => root.unmount()),
  };
}

test("the failed card shows the saved reason as its own left-to-right line", async (t) => {
  const picker = await mountPicker(t, vulkanPack({ gpuFailed: true, gpuFailReason: DEVICE_LOST }));
  try {
    const card = picker.find(isFailedCard);
    const line = findElement(card, hasText(DEVICE_LOST));
    assert.ok(line, "the reason is on the failed card");
    assert.equal(line.props.dir, "ltr");
  } finally {
    await picker.unmount();
  }
});

test("a failure saved before this change renders the card exactly as before", async (t) => {
  const picker = await mountPicker(t, vulkanPack({ gpuFailed: true, gpuFailReason: undefined }));
  try {
    const card = picker.find(isFailedCard);
    assert.ok(card, "the failed card still shows");
    assert.equal(findElement(card, (node) => node.props?.dir === "ltr"), null, "no empty line");
  } finally {
    await picker.unmount();
  }
});

test("a reason is never shown while the pack is not marked failed", async (t) => {
  const stale = "a reason left over from an old failure";
  const picker = await mountPicker(t, vulkanPack({ gpuFailReason: stale }));
  try {
    assert.equal(picker.find(isFailedCard), null);
    assert.equal(picker.find(hasText(stale)), null);
  } finally {
    await picker.unmount();
  }
});

test("a live fallback re-reads the status: the new reason shows and replaces the old one", async (t) => {
  const picker = await mountPicker(t, vulkanPack());
  try {
    assert.equal(picker.find(isFailedCard), null);

    await picker.fireVulkanFallback(vulkanPack({ gpuFailed: true, gpuFailReason: DEVICE_LOST }));
    assert.ok(picker.find(hasText(DEVICE_LOST)), "shown without reopening settings");
    assert.equal(picker.pack.statusReads, 2, "the status was read again after the notification");

    // A later failure (e.g. after Retry) replaces the line; the old reason never lingers
    await picker.fireVulkanFallback(
      vulkanPack({ gpuFailed: true, gpuFailReason: OUT_OF_DEVICE_MEMORY })
    );
    assert.ok(picker.find(hasText(OUT_OF_DEVICE_MEMORY)));
    assert.equal(picker.find(hasText(DEVICE_LOST)), null);
  } finally {
    await picker.unmount();
  }
});
