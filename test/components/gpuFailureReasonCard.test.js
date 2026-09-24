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

const cudaPack = (overrides = {}) => ({
  downloaded: false,
  downloading: false,
  path: null,
  gpuInfo: { hasNvidiaGpu: false },
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

const KERNEL_IMAGE = "CUDA error: no kernel image is available for execution on the device";
const NVIDIA = { hasNvidiaGpu: true, cudaSupported: true };
// An NVIDIA GPU below the CUDA build's kernel floor (e.g. Maxwell)
const OLD_NVIDIA = { hasNvidiaGpu: true, cudaSupported: false };
const failedWith = (reason) => ({ gpuFailed: true, gpuFailReason: reason });
// Both packs on disk, as main reports them: `inUse` names main's pick (#1736)
const bothPacks = ({ gpuInfo = NVIDIA, inUse, cuda = {}, vulkan = {} }) => ({
  cuda: cudaPack({ downloaded: true, gpuInfo, inUse: inUse === "cuda", ...cuda }),
  vulkan: vulkanPack({
    hasNvidiaGpu: gpuInfo.hasNvidiaGpu,
    inUse: inUse === "vulkan",
    ...vulkan,
  }),
});

// Lets the picker's IPC reads (status on mount, re-read after a fallback) land
function settle() {
  return React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mountPicker(t, vulkanStatus, cudaStatus = cudaPack()) {
  installBrowserGlobals(t, {
    window: { location: { search: "" }, electronAPI: { getPlatform: () => "win32" } },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-failure-reason-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const container = installHookDom(t);
  // `status` is the Vulkan pack's; `calls` lists the pack IPCs the card made
  const pack = { status: vulkanStatus, cuda: cudaStatus, statusReads: 0, failReads: false };
  const calls = [];
  const listeners = { cuda: [], vulkan: [], changed: [] };
  const listen = (list) => (callback) => {
    list.push(callback);
    return () => list.includes(callback) && list.splice(list.indexOf(callback), 1);
  };
  const record = (call, result) => async () => {
    calls.push(call);
    return result;
  };
  const read = (get) => async () => {
    if (pack.failReads) throw new Error("IPC failed");
    return get();
  };
  Object.assign(globalThis.window.electronAPI, {
    checkParakeetInstallation: async () => ({ supported: true }),
    listParakeetModels: async () => ({ success: true, models: [] }),
    listWhisperModels: async () => ({ success: true, models: [] }),
    onWhisperDownloadProgress: () => noop,
    onParakeetDownloadProgress: () => noop,
    getCudaWhisperStatus: read(() => pack.cuda),
    getVulkanWhisperStatus: read(() => {
      pack.statusReads += 1;
      return pack.status;
    }),
    whisperServerStatus: async () => ({ gpuAccelerated: false }),
    onCudaFallbackNotification: listen(listeners.cuda),
    onGpuFallbackNotification: listen(listeners.vulkan),
    onWhisperGpuStatusChanged: listen(listeners.changed),
    downloadCudaWhisperBinary: record("download-cuda", { success: true, willRestart: false }),
    downloadVulkanWhisperBinary: record("download-vulkan", { success: true, willRestart: false }),
    deleteCudaWhisperBinary: record("delete-cuda", { success: true }),
    deleteVulkanWhisperBinary: record("delete-vulkan", { success: true, deletedCount: 1 }),
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
  // Main has already saved the change when it sends any of these events.
  // `next` replaces what the status IPCs answer: { status, cuda }.
  const fire = async (event, next = {}) => {
    Object.assign(pack, next);
    await React.act(async () => {
      for (const listener of [...listeners[event]]) listener();
    });
    await settle();
  };
  return {
    pack,
    listeners,
    find: (predicate) => findElement(tree, predicate),
    // A boolean: a failing assert would print the element's whole fiber graph
    shows: (predicate) => !!findElement(tree, predicate),
    fire,
    fireVulkanFallback: (status) => fire("vulkan", { status }),
    // Clicks the card button with this label; returns the pack IPCs it made
    click: async (label) => {
      const button = findElement(tree, (node) => !!node.props?.onClick && hasText(label)(node));
      assert.ok(button, `a "${label}" button`);
      calls.length = 0;
      await React.act(async () => button.props.onClick());
      await settle();
      return [...calls];
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

// One pack installed, as almost everyone has: main reports it in use (#1736)
const onlyCuda = (extra = {}) => ({
  cuda: cudaPack({ downloaded: true, gpuInfo: NVIDIA, inUse: true, ...extra }),
  vulkan: vulkanPack({ downloaded: false, hasNvidiaGpu: true }),
});
const onlyVulkan = (extra = {}) => ({
  cuda: cudaPack(),
  vulkan: vulkanPack({ inUse: true, ...extra }),
});
for (const [name, packs, reason, removes] of [
  ["CUDA", onlyCuda(), null, "delete-cuda"],
  ["CUDA, failed", onlyCuda(failedWith(KERNEL_IMAGE)), KERNEL_IMAGE, "delete-cuda"],
  ["Vulkan", onlyVulkan(), null, "delete-vulkan"],
  ["Vulkan, failed", onlyVulkan(failedWith(DEVICE_LOST)), DEVICE_LOST, "delete-vulkan"],
]) {
  test(`one pack (${name}): the card is unchanged and Remove deletes that pack`, async (t) => {
    const picker = await mountPicker(t, packs.vulkan, packs.cuda);
    try {
      assert.equal(picker.shows(isFailedCard), !!reason);
      assert.ok(picker.shows(hasText(reason ?? "GPU acceleration ready")));
      assert.deepEqual(await picker.click("Remove"), [removes]);
    } finally {
      await picker.unmount();
    }
  });
}

for (const [name, gpuInfo, downloads] of [
  ["an NVIDIA GPU", NVIDIA, "download-cuda"],
  ["another GPU", { hasNvidiaGpu: false }, "download-vulkan"],
]) {
  test(`no pack on ${name}: the card offers the pack that GPU can run`, async (t) => {
    const picker = await mountPicker(t, vulkanPack({ downloaded: false }), cudaPack({ gpuInfo }));
    try {
      assert.deepEqual(await picker.click("Enable GPU"), [downloads]);
    } finally {
      await picker.unmount();
    }
  });
}

// Before #1736 the card chose the pack itself, and could describe one the
// server was not using: the wrong reason showed, and Remove deleted that pack
for (const [name, packs, reason, removes] of [
  [
    "both packs, CUDA failed, Vulkan in use",
    bothPacks({ inUse: "vulkan", cuda: failedWith(KERNEL_IMAGE) }),
    null,
    "delete-vulkan",
  ],
  [
    "both packs on a GPU CUDA does not support, Vulkan failed, CUDA in use",
    bothPacks({ gpuInfo: OLD_NVIDIA, inUse: "cuda", vulkan: failedWith(DEVICE_LOST) }),
    null,
    "delete-cuda",
  ],
  [
    "both packs, CUDA opted out, Vulkan failed and in use",
    bothPacks({ inUse: "vulkan", vulkan: failedWith(DEVICE_LOST) }),
    DEVICE_LOST,
    "delete-vulkan",
  ],
  [
    "only CUDA on a GPU CUDA does not support, failed",
    onlyCuda({ gpuInfo: OLD_NVIDIA, ...failedWith(KERNEL_IMAGE) }),
    KERNEL_IMAGE,
    "delete-cuda",
  ],
]) {
  test(`${name}: the card shows the pack in use`, async (t) => {
    const picker = await mountPicker(t, packs.vulkan, packs.cuda);
    try {
      assert.equal(picker.shows(isFailedCard), !!reason);
      assert.ok(picker.shows(hasText(reason ?? "GPU acceleration ready")));
      for (const other of [KERNEL_IMAGE, DEVICE_LOST].filter((line) => line !== reason)) {
        assert.equal(picker.shows(hasText(other)), false, "no other pack's reason");
      }
      assert.deepEqual(await picker.click("Remove"), [removes]);
    } finally {
      await picker.unmount();
    }
  });
}

test("a live Vulkan fallback shows on the Vulkan card, and Remove deletes Vulkan", async (t) => {
  // Both packs; CUDA opted out by a hand-edited .env, so main runs Vulkan
  const before = bothPacks({ inUse: "vulkan" });
  const picker = await mountPicker(t, before.vulkan, before.cuda);
  try {
    assert.equal(picker.shows(isFailedCard), false);

    const after = bothPacks({ inUse: "vulkan", vulkan: failedWith(DEVICE_LOST) });
    await picker.fireVulkanFallback(after.vulkan);

    const card = picker.find(isFailedCard);
    assert.ok(!!card, "the fallback that just happened stays visible");
    assert.ok(!!findElement(card, hasText(DEVICE_LOST)), "with the failed pack's reason");
    assert.deepEqual(await picker.click("Remove"), ["delete-vulkan"]);
  } finally {
    await picker.unmount();
  }
});

test("both packs: after a CUDA fallback the card follows main to the Vulkan pack", async (t) => {
  const before = bothPacks({ inUse: "cuda" });
  const picker = await mountPicker(t, before.vulkan, before.cuda);
  try {
    // The next server start will run Vulkan, so main now reports Vulkan in use
    const after = bothPacks({ inUse: "vulkan", cuda: failedWith(KERNEL_IMAGE) });
    await picker.fire("cuda", { status: after.vulkan, cuda: after.cuda });

    assert.equal(picker.shows(isFailedCard), false);
    assert.ok(picker.shows(hasText("GPU acceleration ready")));
    assert.deepEqual(await picker.click("Remove"), ["delete-vulkan"]);
  } finally {
    await picker.unmount();
  }
});

test("a fallback whose status read fails still shows as failed, with no old reason", async (t) => {
  const picker = await mountPicker(t, vulkanPack({ inUse: true }));
  try {
    picker.pack.failReads = true;
    await picker.fireVulkanFallback(vulkanPack({ inUse: true, ...failedWith(DEVICE_LOST) }));

    const card = picker.find(isFailedCard);
    assert.ok(!!card, "the fallback still shows");
    const reasonLine = findElement(card, (node) => node.props?.dir === "ltr");
    assert.equal(!!reasonLine, false, "no reason line");
  } finally {
    await picker.unmount();
  }
});

test("the card re-reads when main says the GPU state changed, without remounting", async (t) => {
  const failed = onlyVulkan(failedWith(DEVICE_LOST));
  const picker = await mountPicker(t, failed.vulkan, failed.cuda);
  try {
    assert.ok(picker.shows(hasText(DEVICE_LOST)));

    // Retry on the fallback pop-up, in the dictation window, cleared the failure
    await picker.fire("changed", { status: onlyVulkan().vulkan });

    assert.equal(picker.shows(isFailedCard), false);
    assert.equal(picker.shows(hasText(DEVICE_LOST)), false, "the old reason is gone");
    assert.ok(picker.shows(hasText("GPU acceleration ready")));
  } finally {
    await picker.unmount();
  }
});

test("the card stops listening for GPU changes when it unmounts", async (t) => {
  const packs = onlyVulkan();
  const picker = await mountPicker(t, packs.vulkan, packs.cuda);
  let whileMounted;
  try {
    whileMounted = picker.listeners.changed.length;
  } finally {
    // Always unmount: a picker left mounted keeps its 5 s poll alive
    await picker.unmount();
  }

  assert.equal(whileMounted, 1, "listening while mounted");
  const left = Object.values(picker.listeners).map((list) => list.length);
  assert.deepEqual(left, [0, 0, 0], "every listener removed");
});
