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
  manager._transcribing = true;
  t.mock.timers.tick(30000);
  await flush();
  assert.deepEqual(starts, [true]);

  manager._transcribing = false;
  t.mock.timers.tick(30000);
  await flush();
  assert.deepEqual(starts, [true, true]);
  assert.equal(manager.serverManager.useCuda, true);
});

test("a wake during a dictation keeps the session failure for the next wake", async () => {
  const { manager, starts } = fellBackManager({ gpuUp: () => true });
  manager._transcribing = true;

  assert.equal(await manager.onWakeFromSleep(), false);

  assert.deepEqual(starts, []);
  assert.deepEqual(manager.getFailedGpuBackends(), ["cuda"]);
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
