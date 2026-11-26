const test = require("node:test");
const assert = require("node:assert/strict");

const sent = [];
require.cache[require.resolve("electron")] = {
  exports: {
    BrowserWindow: {
      getAllWindows: () => [
        { isDestroyed: () => false, webContents: { send: (channel) => sent.push(channel) } },
      ],
    },
  },
};

const IPCHandlers = require("../../src/helpers/ipcHandlers");
const WhisperManager = require("../../src/helpers/whisper");

// What main does with a GPU fallback: an unproven one is remembered in
// WHISPER_GPU_FAILED (a GPU that may never work, #1578); a proven one is kept
// for the session only, and isn't announced when a wake re-warm, which retries
// it on its own, hit it. #2265
const ENV_KEYS = ["WHISPER_GPU_FAILED", "WHISPER_GPU_FAILED_REASON_CUDA"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  sent.length = 0;
});
test.after(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setup() {
  const whisperManager = new WhisperManager();
  const synced = [];
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
    whisperManager,
    _syncStartupEnv: (setVars, clearVars = []) => {
      synced.push({ setVars, clearVars });
      Object.assign(process.env, setVars);
      for (const key of clearVars) delete process.env[key];
    },
  });
  handlers._attachWhisperServerListeners(whisperManager.serverManager);
  return { whisperManager, handlers, synced };
}

test("an unproven failure is remembered across launches and announced", () => {
  const { whisperManager, synced } = setup();

  whisperManager.serverManager.emit("gpu-fallback", { fallbackBackend: "cpu", proven: false });

  assert.deepEqual(synced, [
    { setVars: { WHISPER_GPU_FAILED: "vulkan" }, clearVars: ["WHISPER_GPU_FAILED_REASON_VULKAN"] },
  ]);
  assert.deepEqual(sent, ["gpu-fallback-notification"]);
});

test("a proven failure at dictation time is kept for the session and announced", () => {
  const { whisperManager, synced } = setup();

  whisperManager.serverManager.emit("cuda-fallback", { fallbackBackend: "cpu", proven: true });

  assert.deepEqual(synced, []);
  assert.deepEqual(whisperManager.getFailedGpuBackends(), ["cuda"]);
  assert.deepEqual(sent, ["cuda-fallback-notification"]);
});

test("a proven failure in a wake re-warm is kept for the session and only re-read by the cards", () => {
  const { whisperManager, synced } = setup();
  whisperManager._rewarmInFlight = true;

  whisperManager.serverManager.emit("cuda-fallback", { fallbackBackend: "cpu", proven: true });

  assert.deepEqual(synced, []);
  assert.deepEqual(whisperManager.getFailedGpuBackends(), ["cuda"]);
  assert.deepEqual(sent, ["whisper-gpu-status-changed"]);
});

test("an unproven failure in a wake re-warm is still remembered and announced", () => {
  const { whisperManager, synced } = setup();
  whisperManager._rewarmInFlight = true;

  whisperManager.serverManager.emit("cuda-fallback", { fallbackBackend: "cpu", proven: false });

  assert.deepEqual(synced, [
    { setVars: { WHISPER_GPU_FAILED: "cuda" }, clearVars: ["WHISPER_GPU_FAILED_REASON_CUDA"] },
  ]);
  assert.deepEqual(sent, ["cuda-fallback-notification"]);
});

test("a proven CUDA failure that lands on Vulkan is kept for the session, not remembered", () => {
  const { whisperManager, synced } = setup();

  whisperManager.serverManager.emit("cuda-fallback", { fallbackBackend: "vulkan", proven: true });

  assert.deepEqual(synced, []);
  assert.deepEqual(whisperManager.getFailedGpuBackends(), ["cuda"]);
  assert.deepEqual(sent, ["whisper-gpu-status-changed"]);
});

test("a pack change clears that backend's failure and what its old binary proved", () => {
  const { whisperManager, handlers } = setup();
  const sm = whisperManager.serverManager;
  sm.startedGpuKeys.add("gpu:cuda||/m/tiny.bin");
  sm.transcribedGpuKeys.add("gpu:cuda||/m/tiny.bin");
  sm.startedGpuKeys.add("gpu:vulkan:default||/m/tiny.bin");
  sm.emit("cuda-fallback", { proven: true });

  handlers._clearWhisperGpuFailure("cuda");

  assert.deepEqual(whisperManager.getFailedGpuBackends(), []);
  assert.deepEqual([...sm.startedGpuKeys], ["gpu:vulkan:default||/m/tiny.bin"]);
  assert.deepEqual([...sm.transcribedGpuKeys], []);
});

test("the GPU card shows a session failure's reason over an older saved one", () => {
  const { whisperManager, handlers } = setup();
  process.env.WHISPER_GPU_FAILED_REASON_CUDA = "an older reason";

  whisperManager.serverManager.emit("cuda-fallback", {
    fallbackBackend: "cpu",
    proven: true,
    reason: "CUDA error: out of memory",
  });

  assert.deepEqual(handlers._whisperGpuFailureStatus("cuda"), {
    gpuFailed: true,
    gpuFailReason: "CUDA error: out of memory",
  });
});

test("a wake retry of a session failure makes every GPU card re-read", () => {
  const { whisperManager } = setup();

  whisperManager.emit("gpu-status-changed");

  assert.deepEqual(sent, ["whisper-gpu-status-changed"]);
});
