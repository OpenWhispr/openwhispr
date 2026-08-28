const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer");
const { getGpuSignature } = WhisperServerManager;

// start()'s no-op guard must include the GPU backend: before #1458's hotfix a
// running CPU server silently ignored later GPU-enabled start requests
// (sticky-CPU), while a genuine GPU->CPU fallback must NOT restart-loop —
// WHISPER_GPU_FAILED makes the next request resolve to CPU, matching the
// fallback server's actual (CPU) signature.

const ENV_KEYS = ["WHISPER_VULKAN_DEVICE"];
const saved = {};

test.beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("getGpuSignature resolves the backend the way _doStart does", () => {
  assert.equal(getGpuSignature({}), "gpu:cpu");
  assert.equal(getGpuSignature({ useCuda: true }), "gpu:cuda");
  assert.equal(getGpuSignature({ useVulkan: true }), "gpu:vulkan:default");
  // CUDA wins when both flags are set, mirroring _doStart's resolution.
  assert.equal(getGpuSignature({ useCuda: true, useVulkan: true }), "gpu:cuda");
});

test("getGpuSignature carries the resolved Vulkan device pin", () => {
  assert.equal(getGpuSignature({ useVulkan: true, vulkanDeviceIndex: 1 }), "gpu:vulkan:1");

  process.env.WHISPER_VULKAN_DEVICE = "2";
  assert.equal(getGpuSignature({ useVulkan: true }), "gpu:vulkan:2");
  // An explicit -1 means "explicitly unpinned": the stale env pin must not resurface.
  assert.equal(getGpuSignature({ useVulkan: true, vulkanDeviceIndex: -1 }), "gpu:vulkan:default");
  // The pin is irrelevant off Vulkan.
  assert.equal(getGpuSignature({ useCuda: true }), "gpu:cuda");
  assert.equal(getGpuSignature({}), "gpu:cpu");
});

test("the CPU-fallback recursion signature matches a fresh CPU-resolved request", () => {
  // _doStart's GPU catch recurses with { useCuda: false, useVulkan: false };
  // after the failure is recorded, resolveGpuStartOptions() yields the same
  // flags — equal signatures are what keep a fallback session stable.
  assert.equal(
    getGpuSignature({ useCuda: false, useVulkan: false, vulkanDeviceIndex: 3 }),
    getGpuSignature({})
  );
});

test("the one-shot pin restart signature matches the next request once the pin persists", () => {
  const pinnedRestart = getGpuSignature({ useVulkan: true, vulkanDeviceIndex: 1 });
  process.env.WHISPER_VULKAN_DEVICE = "1";
  assert.equal(getGpuSignature({ useVulkan: true }), pinnedRestart);
});

test("the pin-clear restart signature matches the next request once the env pin is removed", () => {
  const clearedRestart = getGpuSignature({ useVulkan: true, vulkanDeviceIndex: -1 });
  delete process.env.WHISPER_VULKAN_DEVICE;
  assert.equal(getGpuSignature({ useVulkan: true }), clearedRestart);
});

function createManager() {
  const manager = new WhisperServerManager();
  const doStartCalls = [];
  // Mirror the real _doStart contract: on success the actual flags and the
  // gpu signature track what this start runs.
  manager._doStart = async (modelPath, options) => {
    doStartCalls.push({ modelPath, options });
    manager.modelPath = modelPath;
    manager.useCuda = options.useCuda === true;
    manager.useVulkan = !manager.useCuda && options.useVulkan === true;
    manager.gpuSignature = getGpuSignature(options);
    manager.process = {};
    manager.ready = true;
  };
  manager.stop = async () => {
    manager.process = null;
    manager.ready = false;
    manager.modelPath = null;
    // Mirror the real stop() contract: an explicit stop clears the in-session
    // CPU pin so the next start gets a fresh GPU attempt.
    manager.gpuFallbackActive = false;
  };
  return { manager, doStartCalls };
}

// Emulate _doStart's real GPU catch: the requested GPU server died during
// startup, so stop, mark the in-session fallback, and recurse with the
// corrected CPU flags. failVulkan=false models a working Vulkan pack next to
// a broken CUDA one.
function emulateGpuStartupFallback(manager, { failVulkan = true } = {}) {
  const contractDoStart = manager._doStart;
  manager._doStart = async (modelPath, options) => {
    const usingCuda = options.useCuda === true;
    const usingVulkan = !usingCuda && options.useVulkan === true;
    if (usingCuda || (usingVulkan && failVulkan)) {
      await manager.stop();
      manager.gpuFallbackActive = true;
      return manager._doStart(modelPath, { ...options, useCuda: false, useVulkan: false });
    }
    return contractDoStart(modelPath, options);
  };
}

test("an identical repeat start() still no-ops", async () => {
  const { manager, doStartCalls } = createManager();

  await manager.start("/tmp/model.bin", {});
  await manager.start("/tmp/model.bin", {});
  assert.equal(doStartCalls.length, 1);

  const gpu = createManager();
  await gpu.manager.start("/tmp/model.bin", { useCuda: true });
  await gpu.manager.start("/tmp/model.bin", { useCuda: true });
  assert.equal(gpu.doStartCalls.length, 1);
});

test("a GPU-enabled request restarts a running CPU server (newly-downloaded pack)", async () => {
  const { manager, doStartCalls } = createManager();

  await manager.start("/tmp/model.bin", { useCuda: false, useVulkan: false });
  assert.equal(doStartCalls.length, 1);

  // The pack finished downloading: resolveGpuStartOptions() now requests CUDA.
  await manager.start("/tmp/model.bin", { useCuda: true, useVulkan: false });
  assert.equal(doStartCalls.length, 2);
  assert.equal(doStartCalls[1].options.useCuda, true);
  assert.equal(manager.useCuda, true);

  const vulkan = createManager();
  await vulkan.manager.start("/tmp/model.bin", { useCuda: false, useVulkan: false });
  await vulkan.manager.start("/tmp/model.bin", { useCuda: false, useVulkan: true });
  assert.equal(vulkan.doStartCalls.length, 2);
  assert.equal(vulkan.manager.useVulkan, true);
});

test("a fallback session stays stable: CPU-resolved requests no-op after a GPU->CPU fallback", async () => {
  const { manager, doStartCalls } = createManager();
  emulateGpuStartupFallback(manager);

  await manager.start("/tmp/model.bin", { useCuda: true });
  assert.equal(doStartCalls.length, 1);
  assert.equal(manager.useCuda, false);
  assert.equal(manager.gpuSignature, "gpu:cpu");

  // WHISPER_GPU_FAILED was recorded on the fallback event, so the next
  // dictation resolves to CPU — the guard must not restart the CPU server.
  await manager.start("/tmp/model.bin", { useCuda: false, useVulkan: false });
  assert.equal(doStartCalls.length, 1);
});

test("a fallback session pins CPU: a Vulkan-resolved request no-ops after a CUDA->CPU fallback", async () => {
  const { manager, doStartCalls } = createManager();
  emulateGpuStartupFallback(manager, { failVulkan: false });

  await manager.start("/tmp/model.bin", { useCuda: true });
  assert.equal(doStartCalls.length, 1);
  assert.equal(manager.gpuSignature, "gpu:cpu");
  const cpuServer = manager.process;

  // Both packs installed: WHISPER_GPU_FAILED only records cuda, so the next
  // dictation resolves to Vulkan. The in-session pin must keep the working
  // CPU server instead of tearing it down for a Vulkan cold start.
  await manager.start("/tmp/model.bin", { useCuda: false, useVulkan: true });
  assert.equal(doStartCalls.length, 1);
  assert.equal(manager.process, cpuServer);
  assert.equal(manager.useVulkan, false);
});

test("an explicit stop() lifts the CPU pin: the next GPU-resolved start engages the GPU", async () => {
  const { manager, doStartCalls } = createManager();
  emulateGpuStartupFallback(manager, { failVulkan: false });

  await manager.start("/tmp/model.bin", { useCuda: true });
  assert.equal(doStartCalls.length, 1);
  assert.equal(manager.gpuSignature, "gpu:cpu");

  // restartServerWithGpuPreference (pack download, explicit Retry, delete)
  // stops first — that clears the pin and re-attempts GPU.
  await manager.stop();
  await manager.start("/tmp/model.bin", { useCuda: false, useVulkan: true });
  assert.equal(doStartCalls.length, 2);
  assert.equal(manager.useVulkan, true);
  assert.equal(manager.gpuSignature, "gpu:vulkan:default");
});
