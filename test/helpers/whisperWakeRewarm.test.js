const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldRewarmOnWake } = require("../../src/helpers/whisper");

const base = {
  isRemote: false,
  useCuda: true,
  modelName: "large",
  transcribing: false,
  rewarmInFlight: false,
};

test("re-warms a running local CUDA whisper-server after wake", () => {
  assert.equal(shouldRewarmOnWake(base), true);
});

test("re-warms a running local Vulkan whisper-server after wake", () => {
  assert.equal(shouldRewarmOnWake({ ...base, useCuda: false, useVulkan: true }), true);
});

test("skips a CPU whisper-server with no GPU wanted (model survives sleep in RAM)", () => {
  assert.equal(shouldRewarmOnWake({ ...base, useCuda: false, wantsGpu: false }), false);
});

test("re-warms a CPU whisper-server that should be on the GPU again (#2265)", () => {
  assert.equal(shouldRewarmOnWake({ ...base, useCuda: false, wantsGpu: true }), true);
});

test("skips a remote whisper-server", () => {
  assert.equal(shouldRewarmOnWake({ ...base, isRemote: true }), false);
});

test("skips when no server model is active", () => {
  assert.equal(shouldRewarmOnWake({ ...base, modelName: null }), false);
});

test("skips while a transcription is already warming the server", () => {
  assert.equal(shouldRewarmOnWake({ ...base, transcribing: true }), false);
});

test("skips while another wake re-warm is already in flight", () => {
  assert.equal(shouldRewarmOnWake({ ...base, rewarmInFlight: true }), false);
});

const WhisperManager = require("../../src/helpers/whisper");

const ENV_KEYS = ["WHISPER_CUDA_ENABLED", "WHISPER_VULKAN_ENABLED", "WHISPER_GPU_FAILED"];
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A CUDA server that started earlier this session fell back to CPU before
// sleep. Starts engage the GPU only while gpuUp() is true; otherwise they fall
// back the way _doStart does, emitting a proven failure. #2265
function fellBackManager({ gpuUp }) {
  const manager = new WhisperManager();
  manager.setGpuBinaryManagers({ cuda: { isDownloaded: () => true } });
  const sm = manager.serverManager;
  const fallBack = () => {
    sm.useCuda = false;
    sm.gpuFallbackActive = true;
    sm.emit("cuda-fallback", { proven: true });
  };

  const starts = [];
  manager.stopServer = async () => {
    manager.currentServerModel = null;
  };
  manager.startServer = async (modelName, options) => {
    starts.push(options.useCuda);
    if (options.useCuda && !gpuUp()) {
      fallBack();
    } else {
      sm.useCuda = options.useCuda;
      sm.gpuFallbackActive = false;
    }
    manager.currentServerModel = modelName;
    return { success: true };
  };

  fallBack();
  manager.currentServerModel = "tiny";
  return { manager, starts };
}

test("wake gives a GPU that failed after working this session a fresh attempt", async () => {
  const { manager, starts } = fellBackManager({ gpuUp: () => true });

  assert.equal(await manager.onWakeFromSleep(), true);

  assert.deepEqual(starts, [true]);
  assert.equal(manager.serverManager.useCuda, true);
  assert.deepEqual(manager.getFailedGpuBackends(), []);
});

test("a wake re-warm that falls back again is retried once a little later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let gpuUp = false;
  const { manager, starts } = fellBackManager({ gpuUp: () => gpuUp });

  assert.equal(await manager.onWakeFromSleep(), true);
  assert.deepEqual(starts, [true]);
  assert.equal(manager.serverManager.useCuda, false);

  gpuUp = true;
  t.mock.timers.tick(30000);
  await flush();

  assert.deepEqual(starts, [true, true]);
  assert.equal(manager.serverManager.useCuda, true);
});

test("the delayed retry runs once: a GPU still down stays off until the next wake", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, starts } = fellBackManager({ gpuUp: () => false });

  await manager.onWakeFromSleep();
  t.mock.timers.tick(30000);
  await flush();
  t.mock.timers.tick(30000);
  await flush();

  assert.deepEqual(starts, [true, true]);
  assert.deepEqual(manager.getFailedGpuBackends(), ["cuda"]);
});

test("the delayed retry leaves a GPU that a manual Retry already brought back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let gpuUp = false;
  const { manager, starts } = fellBackManager({ gpuUp: () => gpuUp });

  await manager.onWakeFromSleep();
  gpuUp = true;
  // What the whisper-gpu-retry IPC does
  manager.forgetSessionGpuFailures();
  await manager.restartServerWithGpuPreference();
  t.mock.timers.tick(30000);
  await flush();

  assert.deepEqual(starts, [true, true]);
  assert.equal(manager.serverManager.useCuda, true);
});

test("a new wake replaces the pending retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, starts } = fellBackManager({ gpuUp: () => false });

  await manager.onWakeFromSleep();
  t.mock.timers.tick(10000);
  await manager.onWakeFromSleep();
  assert.deepEqual(starts, [true, true]);

  // The first wake's retry was due now; only the second wake's runs, 30 s after it
  t.mock.timers.tick(20000);
  await flush();
  assert.deepEqual(starts, [true, true]);
  t.mock.timers.tick(10000);
  await flush();
  assert.deepEqual(starts, [true, true, true]);
});

test("cancelWakeGpuRetry drops a pending retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, starts } = fellBackManager({ gpuUp: () => false });

  await manager.onWakeFromSleep();
  manager.cancelWakeGpuRetry();
  t.mock.timers.tick(30000);
  await flush();

  assert.deepEqual(starts, [true]);
});

test("a resume during a slow re-warm still gets that re-warm's retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let gpuUp = false;
  const { manager, starts } = fellBackManager({ gpuUp: () => gpuUp });
  let finishStart;
  const startServer = manager.startServer;
  manager.startServer = (modelName, options) =>
    new Promise((resolve) => {
      finishStart = () => resolve(startServer(modelName, options));
    });

  const wake = manager.onWakeFromSleep();
  await flush();
  // Lid closed and opened again while the GPU start was still loading: main
  // cancels any pending retry, and this resume's own re-warm is skipped
  manager.cancelWakeGpuRetry();
  assert.equal(await manager.onWakeFromSleep(), false);
  finishStart();
  assert.equal(await wake, true);
  manager.startServer = startServer;

  gpuUp = true;
  t.mock.timers.tick(30000);
  await flush();
  assert.deepEqual(starts, [true, true]);
  assert.equal(manager.serverManager.useCuda, true);
});

test("a delayed retry due during a dictation waits for it to finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let gpuUp = false;
  const { manager, starts } = fellBackManager({ gpuUp: () => gpuUp });

  await manager.onWakeFromSleep();
  gpuUp = true;
  manager._activeTranscriptions = 1;
  t.mock.timers.tick(30000);
  await flush();
  assert.deepEqual(starts, [true]);

  manager._activeTranscriptions = 0;
  t.mock.timers.tick(30000);
  await flush();
  assert.deepEqual(starts, [true, true]);
  assert.equal(manager.serverManager.useCuda, true);
});

test("a wake during a dictation tries the GPU again once the dictation is done", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, starts } = fellBackManager({ gpuUp: () => true });
  manager._activeTranscriptions = 1;

  assert.equal(await manager.onWakeFromSleep(), false);
  assert.deepEqual(starts, []);
  assert.deepEqual(manager.getFailedGpuBackends(), ["cuda"]);

  manager._activeTranscriptions = 0;
  t.mock.timers.tick(30000);
  await flush();

  assert.deepEqual(starts, [true]);
  assert.equal(manager.serverManager.useCuda, true);
  assert.deepEqual(manager.getFailedGpuBackends(), []);
});

test("a wake with no local server lets its next start try the GPU", async () => {
  const { manager, starts } = fellBackManager({ gpuUp: () => true });
  manager.currentServerModel = null;
  let statusChanges = 0;
  manager.on("gpu-status-changed", () => statusChanges++);

  assert.equal(await manager.onWakeFromSleep(), false);

  assert.deepEqual(starts, []);
  assert.deepEqual(manager.getFailedGpuBackends(), []);
  assert.equal(manager.resolveGpuStartOptions().useCuda, true);
  assert.equal(statusChanges, 1);
});

test("the GPU cards re-read after a wake re-warm retried a session failure", async () => {
  const { manager } = fellBackManager({ gpuUp: () => true });
  let statusChanges = 0;
  manager.on("gpu-status-changed", () => statusChanges++);

  await manager.onWakeFromSleep();

  assert.equal(statusChanges, 1);
});

test("a wake re-warm with no session failure does not make the cards re-read", async () => {
  const { manager } = fellBackManager({ gpuUp: () => true });
  manager.forgetSessionGpuFailures();
  manager.serverManager.useCuda = true;
  let statusChanges = 0;
  manager.on("gpu-status-changed", () => statusChanges++);

  assert.equal(await manager.onWakeFromSleep(), true);

  assert.equal(statusChanges, 0);
});

// Both packs installed: CUDA worked, failed at the wake re-warm and landed on
// Vulkan. CUDA comes back by the delayed retry.
test("the delayed retry brings CUDA back from Vulkan", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cudaUp = false;
  const manager = new WhisperManager();
  const pack = { isDownloaded: () => true };
  manager.setGpuBinaryManagers({ cuda: pack, vulkan: pack });
  const sm = manager.serverManager;
  const landOnVulkan = () => {
    sm.useCuda = false;
    sm.useVulkan = true;
    sm.emit("cuda-fallback", { proven: true, fallbackBackend: "vulkan" });
  };
  const starts = [];
  manager.stopServer = async () => {
    manager.currentServerModel = null;
  };
  manager.startServer = async (modelName, options) => {
    starts.push(options.useCuda ? "cuda" : options.useVulkan ? "vulkan" : "cpu");
    if (options.useCuda && !cudaUp) {
      landOnVulkan();
    } else {
      sm.useCuda = options.useCuda;
      sm.useVulkan = options.useVulkan;
    }
    manager.currentServerModel = modelName;
    return { success: true };
  };
  landOnVulkan();
  manager.currentServerModel = "tiny";

  assert.equal(await manager.onWakeFromSleep(), true);
  assert.deepEqual(starts, ["cuda"]);
  assert.equal(sm.useVulkan, true);

  cudaUp = true;
  t.mock.timers.tick(30000);
  await flush();

  assert.deepEqual(starts, ["cuda", "cuda"]);
  assert.equal(sm.useCuda, true);
  assert.deepEqual(manager.getFailedGpuBackends(), []);
});

test("overlapping transcriptions keep the server busy until the last one ends", async () => {
  const manager = new WhisperManager();
  const pending = [];
  manager._runServerTranscription = () =>
    new Promise((resolve) => pending.push(() => resolve({ text: "ok" })));

  const first = manager.transcribeViaServer(Buffer.from("a"), "tiny", null);
  const second = manager.transcribeViaServer(Buffer.from("b"), "tiny", null);
  pending[0]();
  await first;
  assert.equal(manager._activeTranscriptions, 1);

  pending[1]();
  await second;
  assert.equal(manager._activeTranscriptions, 0);
});

test("a session failure keeps its reason", () => {
  const manager = new WhisperManager();
  manager.serverManager.emit("cuda-fallback", {
    proven: true,
    reason: "CUDA error: out of memory",
  });

  assert.equal(manager.getSessionGpuFailureReason("cuda"), "CUDA error: out of memory");
  assert.equal(manager.getSessionGpuFailureReason("vulkan"), null);
});

test("a remembered failure (the backend never worked) is not retried on wake", async () => {
  const manager = new WhisperManager();
  manager.setGpuBinaryManagers({ cuda: { isDownloaded: () => true } });
  process.env.WHISPER_GPU_FAILED = "cuda";
  manager.serverManager.emit("cuda-fallback", { proven: false });
  manager.currentServerModel = "tiny";
  let started = false;
  manager.startServer = async () => {
    started = true;
    return { success: true };
  };

  assert.equal(await manager.onWakeFromSleep(), false);
  assert.equal(started, false);
});
