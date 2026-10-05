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
const saved = process.env.WHISPER_GPU_FAILED;
test.beforeEach(() => {
  delete process.env.WHISPER_GPU_FAILED;
  sent.length = 0;
});
test.after(() => {
  if (saved === undefined) delete process.env.WHISPER_GPU_FAILED;
  else process.env.WHISPER_GPU_FAILED = saved;
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
  handlers._setupWhisperGpuFallbackListeners();
  return { whisperManager, handlers, synced };
}

test("an unproven failure is remembered across launches and announced", () => {
  const { whisperManager, synced } = setup();

  whisperManager.serverManager.emit("gpu-fallback", { proven: false });

  assert.deepEqual(synced, [{ setVars: { WHISPER_GPU_FAILED: "vulkan" }, clearVars: [] }]);
  assert.deepEqual(sent, ["gpu-fallback-notification"]);
});

test("a proven failure at dictation time is kept for the session and announced", () => {
  const { whisperManager, synced } = setup();

  whisperManager.serverManager.emit("cuda-fallback", { proven: true });

  assert.deepEqual(synced, []);
  assert.deepEqual(whisperManager.getFailedGpuBackends(), ["cuda"]);
  assert.deepEqual(sent, ["cuda-fallback-notification"]);
});

test("a proven failure in a wake re-warm is kept for the session without an announcement", () => {
  const { whisperManager, synced } = setup();
  whisperManager._rewarmInFlight = true;

  whisperManager.serverManager.emit("cuda-fallback", { proven: true });

  assert.deepEqual(synced, []);
  assert.deepEqual(whisperManager.getFailedGpuBackends(), ["cuda"]);
  assert.deepEqual(sent, []);
});

test("an unproven failure in a wake re-warm is still remembered and announced", () => {
  const { whisperManager, synced } = setup();
  whisperManager._rewarmInFlight = true;

  whisperManager.serverManager.emit("cuda-fallback", { proven: false });

  assert.deepEqual(synced, [{ setVars: { WHISPER_GPU_FAILED: "cuda" }, clearVars: [] }]);
  assert.deepEqual(sent, ["cuda-fallback-notification"]);
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
