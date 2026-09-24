const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getSystemErrorMap } = require("node:util");
const {
  VULKAN_DEVICE_LOST_STDERR,
  CUDA_OUT_OF_MEMORY_STDERR,
} = require("./harness/whisperServerStderr");

// Drives the real _doStart against a fake whisper-server process: a GPU start
// that fails must hand the fallback its key error line, where the warn log used
// to keep only the first 200 characters of the device banner (#1736, #1340).
const serverModulePath = require.resolve("../../src/helpers/whisperServer");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-gpu-reason-"));
const modelPath = path.join(userDataDir, "ggml-large-v3-turbo.bin");
fs.writeFileSync(modelPath, "model");
test.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

const BINARY = {
  cpu: "/fake/whisper-server",
  cuda: "/fake/whisper-server-cuda",
  vulkan: "/fake/whisper-server-vulkan",
};
// Binary path -> how its fake process behaves
const behaviours = new Map();
const warnings = [];

function fakeWhisperServer({ stderr = "", exit = null, launchError = null, healthy = false } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.healthy = healthy;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let closed = false;
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    setImmediate(() => close(null, signal));
    return true;
  };
  if (launchError) {
    // What Node does when spawn fails: no pid, an "error" event, then "close"
    // with the negative error number as the exit code
    const [errno] = [...getSystemErrorMap()].find(([, [name]]) => name === launchError);
    child.pid = undefined;
    setImmediate(() => {
      child.emit("error", Object.assign(new Error(`spawn ${launchError}`), { code: launchError }));
      close(errno, null);
    });
    return child;
  }
  // Output lands after _doStart attaches its handlers; then the process ends.
  setImmediate(() => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    if (exit) setImmediate(() => close(exit.code ?? null, exit.signal ?? null));
  });
  return child;
}

const originalLoad = Module._load;
Module._load = function loadWithFakeProcess(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, isReady: () => false } };
  }
  if (parent?.filename === serverModulePath) {
    if (request === "child_process") {
      return { ...childProcess, spawn: (binary) => fakeWhisperServer(behaviours.get(binary)) };
    }
    if (request === "./debugLogger") {
      const ignore = () => {};
      return {
        debug: ignore,
        info: ignore,
        error: ignore,
        warn: (message, meta) => warnings.push({ message, meta }),
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
let WhisperServerManager;
try {
  WhisperServerManager = require(serverModulePath);
} finally {
  Module._load = originalLoad;
}

function createManager(t) {
  behaviours.clear();
  warnings.length = 0;
  behaviours.set(BINARY.cpu, { healthy: true });
  const manager = new WhisperServerManager();
  manager.getServerBinaryPath = (options = {}) =>
    options.preferCuda ? BINARY.cuda : options.preferVulkan ? BINARY.vulkan : BINARY.cpu;
  manager.findAvailablePort = async () => 8199;
  manager.getFFmpegPath = () => null;
  manager.checkHealth = async () => Boolean(manager.process?.healthy);
  t.after(() => manager.stop());
  return manager;
}

function fallbackWarning() {
  return warnings.find(({ message }) =>
    message.endsWith("whisper-server failed, falling back to CPU")
  );
}

test("#1340: a Vulkan server that dies at startup reports the createDevice error", async (t) => {
  const manager = createManager(t);
  behaviours.set(BINARY.vulkan, { stderr: VULKAN_DEVICE_LOST_STDERR, exit: { code: 3 } });
  const events = [];
  manager.on("gpu-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useVulkan: true });

  assert.equal(manager.useVulkan, false, "the CPU server took over");
  assert.deepEqual(events, [{ reason: "vk::PhysicalDevice::createDevice: ErrorDeviceLost" }]);
  const warning = fallbackWarning();
  assert.equal(warning.meta.reason, "vk::PhysicalDevice::createDevice: ErrorDeviceLost");
  assert.equal("stderr" in warning.meta, false, "no 200-character banner slice");
});

test("a CUDA server that runs out of memory at startup reports the failed allocation", async (t) => {
  const manager = createManager(t);
  behaviours.set(BINARY.cuda, { stderr: CUDA_OUT_OF_MEMORY_STDERR, exit: { code: 3 } });
  const events = [];
  manager.on("cuda-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useCuda: true });

  assert.equal(manager.useCuda, false);
  assert.deepEqual(events, [
    {
      reason:
        "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1533.14 MiB on device 0: cudaMalloc failed: out of memory",
    },
  ]);
});

test("a GPU server that never answers is reported as a startup timeout", async (t) => {
  const manager = createManager(t);
  // Prints its banner and hangs
  behaviours.set(BINARY.vulkan, { stderr: "ggml_vulkan: Found 1 Vulkan devices:\n" });
  // Stands in for the real 120 s wait, which throws exactly this at its deadline
  const waitForReady = manager.waitForReady.bind(manager);
  manager.waitForReady = async (getProcessInfo, timeoutMs) => {
    if (manager.useVulkan) {
      throw new Error(`whisper-server failed to start within ${timeoutMs}ms`);
    }
    return waitForReady(getProcessInfo, timeoutMs);
  };
  const events = [];
  manager.on("gpu-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useVulkan: true });

  assert.deepEqual(events, [{ reason: "startup timed out after 120 s" }]);
});

test("a GPU binary that cannot be launched reports its error, not exit code -2", async (t) => {
  const manager = createManager(t);
  // A pack whose binary went missing: Node saved this as "exit code -2"
  behaviours.set(BINARY.cuda, { launchError: "ENOENT" });
  const events = [];
  manager.on("cuda-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useCuda: true });

  assert.equal(manager.useCuda, false, "the CPU server took over");
  assert.deepEqual(events, [{ reason: "could not launch (ENOENT)" }]);
});

test("a Vulkan server that crashes on Windows reports the status code in hex", async (t) => {
  const manager = createManager(t);
  // A driver access violation prints nothing and exits with STATUS_ACCESS_VIOLATION
  behaviours.set(BINARY.vulkan, {
    stderr: "ggml_vulkan: Found 1 Vulkan devices:\n",
    exit: { code: 0xc0000005 },
  });
  const events = [];
  manager.on("gpu-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useVulkan: true });

  assert.deepEqual(events, [{ reason: "exit code 0xC0000005" }]);
});
