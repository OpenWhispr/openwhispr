const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Runs the real GPU-failure handlers from ipcHandlers.js outside Electron. The
// saved reason must follow WHISPER_GPU_FAILED everywhere the flag is set,
// cleared or reported (#1736).
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const broadcasts = [];
// A private userData, so nothing (e.g. tokenStore's auth-token.bin) is read from a shared temp dir
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-gpu-ipc-"));
const electronStub = {
  app: {
    getPath: () => userDataDir,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on() {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on() {},
    removeHandler() {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class {
    static getAllWindows() {
      return [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, data) => broadcasts.push({ channel, data }) },
        },
      ];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  // Never reach the OS keychain (tokenStore and environment.js load secretCrypto)
  if (request === "./secretCrypto") return { isAvailable: () => false };
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    // The status handlers probe the machine's GPUs; the answer is irrelevant here
    if (request === "../utils/gpuDetection") {
      return { detectNvidiaGpu: async () => ({ hasNvidiaGpu: false }) };
    }
    if (request === "../utils/vulkanDetection") {
      return { detectVulkanGpu: async () => ({ available: true }) };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const FAILURE_KEYS = [
  "WHISPER_GPU_FAILED",
  "WHISPER_GPU_FAILED_REASON_CUDA",
  "WHISPER_GPU_FAILED_REASON_VULKAN",
];
const ENV_KEYS = [
  ...FAILURE_KEYS,
  "WHISPER_CUDA_ENABLED",
  "WHISPER_VULKAN_ENABLED",
  "WHISPER_VULKAN_DEVICE",
];
const savedEnv = {};
test.beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  broadcasts.length = 0;
});
test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";
const KERNEL_IMAGE = "CUDA error: no kernel image is available for execution on the device";

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function createHandlers() {
  const IPCHandlers = require(handlersModulePath);
  const serverManager = new EventEmitter();
  serverManager.isRemote = false;
  // What each .env rewrite would persist, captured at the moment of the write
  const envWrites = [];
  const target = Object.assign(Object.create(IPCHandlers.prototype), {
    environmentManager: {
      saveAllKeysToEnvFile: async () => {
        envWrites.push(Object.fromEntries(FAILURE_KEYS.map((key) => [key, process.env[key]])));
        return { success: true };
      },
    },
    whisperManager: {
      serverManager,
      currentServerModel: null,
      stopServer: async () => {},
      restartServerWithGpuPreference: async () => ({ success: true, restarted: false }),
    },
    whisperCudaManager: {
      isDownloaded: () => true,
      isDownloading: () => false,
      getCudaBinaryPath: () => null,
      download: async () => {},
      delete: async () => ({ success: true }),
    },
    whisperVulkanManager: {
      isDownloaded: () => true,
      isDownloading: () => false,
      download: async () => {},
      delete: async () => ({ success: true, deletedCount: 1 }),
    },
  });
  const context = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
  IPCHandlers.prototype.setupHandlers.call(context);
  context._attachWhisperServerListeners(serverManager);
  const invoke = (channel) => handlers.get(channel)({ sender: { isDestroyed: () => true } });
  return { serverManager, invoke, envWrites };
}

test("a Vulkan fallback saves its reason with the flag, in one .env write", () => {
  const { serverManager, envWrites } = createHandlers();

  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });

  assert.equal(process.env.WHISPER_GPU_FAILED, "vulkan");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, DEVICE_LOST);
  assert.deepEqual(envWrites, [
    {
      WHISPER_GPU_FAILED: "vulkan",
      WHISPER_GPU_FAILED_REASON_CUDA: undefined,
      WHISPER_GPU_FAILED_REASON_VULKAN: DEVICE_LOST,
    },
  ]);
  assert.deepEqual(broadcasts, [{ channel: "gpu-fallback-notification", data: {} }]);
});

test("the status IPC reports each backend's own saved reason", async () => {
  const { serverManager, invoke } = createHandlers();
  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });

  const vulkan = await invoke("get-vulkan-whisper-status");
  const cuda = await invoke("get-cuda-whisper-status");

  assert.equal(vulkan.gpuFailed, true);
  assert.equal(vulkan.gpuFailReason, DEVICE_LOST);
  assert.equal(cuda.gpuFailed, true);
  assert.equal(cuda.gpuFailReason, KERNEL_IMAGE);
});

test("a failure with no readable reason clears the older one instead of showing it", async () => {
  const { serverManager, invoke } = createHandlers();
  process.env.WHISPER_GPU_FAILED_REASON_CUDA = KERNEL_IMAGE;

  serverManager.emit("cuda-fallback", { reason: null });

  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, undefined);
  assert.equal((await invoke("get-cuda-whisper-status")).gpuFailReason, null);
  // An emitter that passes nothing at all is tolerated
  assert.doesNotThrow(() => serverManager.emit("gpu-fallback"));
  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda,vulkan");
});

test("no reason is reported for a backend that is not marked failed", async () => {
  const { invoke } = createHandlers();
  // A leftover reason without its flag, e.g. from a hand-edited .env
  process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;

  const vulkan = await invoke("get-vulkan-whisper-status");

  assert.equal(vulkan.gpuFailed, false);
  assert.equal(vulkan.gpuFailReason, null);
});

test("Retry clears every saved reason with the flag", async () => {
  const { serverManager, invoke } = createHandlers();
  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, DEVICE_LOST);
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, KERNEL_IMAGE);

  await invoke("whisper-gpu-retry");

  for (const key of FAILURE_KEYS) assert.equal(process.env[key], undefined, key);
});

test("deleting or re-downloading one pack clears only that pack's reason", async () => {
  const { serverManager, invoke } = createHandlers();
  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });

  await invoke("delete-vulkan-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, undefined);
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, KERNEL_IMAGE);

  await invoke("download-cuda-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, undefined);
});

test("deleting the CUDA pack and re-downloading Vulkan clear their reasons too", async () => {
  const { serverManager, invoke } = createHandlers();

  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, KERNEL_IMAGE);
  await invoke("delete-cuda-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, undefined);

  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, DEVICE_LOST);
  await invoke("download-vulkan-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, undefined);
});
