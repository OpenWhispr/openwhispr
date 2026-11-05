const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WhisperManager = require("../../src/helpers/whisper.js");
const { resolveFailedGpuBackends } = require("../../src/helpers/whisper.js");
const debugLogger = require("../../src/helpers/debugLogger.js");

// Every whisper-server start resolves its GPU backend from the current env +
// installed packs + remembered failures. This is what makes "Enable GPU" work
// without an app restart, and what stops a crashed backend from being
// re-attempted (and its model reload re-paid) on every launch.

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

function managerWith({
  cudaDownloaded = false,
  vulkanDownloaded = false,
  cudaNeedsUpdate = false,
  vulkanNeedsUpdate = false,
} = {}) {
  const manager = new WhisperManager();
  manager.setGpuBinaryManagers({
    cuda: { isDownloaded: () => cudaDownloaded, needsUpdate: () => cudaNeedsUpdate },
    vulkan: { isDownloaded: () => vulkanDownloaded, needsUpdate: () => vulkanNeedsUpdate },
  });
  return manager;
}

test("no packs enabled resolves to CPU", () => {
  assert.deepEqual(managerWith().resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("an enabled + downloaded pack engages without an app restart", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  const manager = managerWith({ cudaDownloaded: true });
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: true,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("enabled but not downloaded resolves to CPU (env flag alone is not an install)", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.WHISPER_VULKAN_ENABLED = "true";
  assert.deepEqual(managerWith().resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("CUDA wins when both backends are enabled and downloaded", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.WHISPER_VULKAN_ENABLED = "true";
  const manager = managerWith({ cudaDownloaded: true, vulkanDownloaded: true });
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: true,
    useVulkan: false,
    fallbackToVulkan: true,
  });
});

test("a restart after the Vulkan pack is removed drops the old Vulkan fallback", async () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  const manager = managerWith({ cudaDownloaded: true, vulkanDownloaded: false });
  // The last start had both packs; restarts merge their options over it
  manager.serverManager.lastStartOptions = {
    useCuda: true,
    useVulkan: false,
    fallbackToVulkan: true,
  };
  let startOptions = null;
  manager.stopServer = async () => {};
  manager.startServer = async (_model, options) => {
    startOptions = options;
    return { success: true };
  };

  await manager.restartServerWithGpuPreference("base");

  assert.equal(startOptions.fallbackToVulkan, false);
});

test("startup pre-warm preserves the installed Vulkan fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-prewarm-"));
  const modelPath = path.join(dir, "ggml-base.bin");
  fs.writeFileSync(modelPath, "model");

  try {
    const manager = managerWith({ cudaDownloaded: true, vulkanDownloaded: true });
    manager.getModelsDir = () => dir;
    manager.getModelPath = () => modelPath;
    manager.logDependencyStatus = async () => {};
    manager.serverManager.isAvailable = () => true;

    let startOptions = null;
    manager.serverManager.start = async (_modelPath, options) => {
      startOptions = options;
    };

    await manager.initializeAtStartup({
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
    });

    assert.deepEqual(startOptions, {
      useCuda: true,
      useVulkan: false,
      fallbackToVulkan: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a remembered CUDA failure degrades to Vulkan, then both failures to CPU", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.WHISPER_VULKAN_ENABLED = "true";
  const manager = managerWith({ cudaDownloaded: true, vulkanDownloaded: true });

  process.env.WHISPER_GPU_FAILED = "cuda";
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: true,
    fallbackToVulkan: false,
  });

  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("clearing the failure re-enables the backend (Retry)", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.WHISPER_GPU_FAILED = "cuda";
  const manager = managerWith({ cudaDownloaded: true });
  assert.equal(manager.resolveGpuStartOptions().useCuda, false);

  delete process.env.WHISPER_GPU_FAILED;
  assert.equal(manager.resolveGpuStartOptions().useCuda, true);
});

test("a downloaded pack with a lost env flag still engages (#1340)", () => {
  const vulkanOnly = managerWith({ vulkanDownloaded: true });
  assert.deepEqual(vulkanOnly.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: true,
    fallbackToVulkan: false,
  });

  const cudaOnly = managerWith({ cudaDownloaded: true });
  assert.deepEqual(cudaOnly.resolveGpuStartOptions(), {
    useCuda: true,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("explicit 'false' opts a downloaded pack out", () => {
  process.env.WHISPER_VULKAN_ENABLED = "false";
  const vulkanOnly = managerWith({ vulkanDownloaded: true });
  assert.deepEqual(vulkanOnly.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });

  process.env.WHISPER_CUDA_ENABLED = "false";
  const cudaOnly = managerWith({ cudaDownloaded: true });
  assert.deepEqual(cudaOnly.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("the 'false' opt-out is case-insensitive (hand-edited .env)", () => {
  // The flag is a hand-edit surface now, so FALSE/False must opt out too.
  process.env.WHISPER_VULKAN_ENABLED = "FALSE";
  const vulkanOnly = managerWith({ vulkanDownloaded: true });
  assert.deepEqual(vulkanOnly.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });

  process.env.WHISPER_CUDA_ENABLED = "False";
  const cudaOnly = managerWith({ cudaDownloaded: true });
  assert.deepEqual(cudaOnly.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("a remembered failure still gates a flag-less downloaded pack", () => {
  process.env.WHISPER_GPU_FAILED = "vulkan";
  const manager = managerWith({ vulkanDownloaded: true });
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("without injected binary managers (macOS) everything resolves to CPU", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.WHISPER_VULKAN_ENABLED = "true";
  const manager = new WhisperManager();
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: false,
    fallbackToVulkan: false,
  });
});

test("resolveFailedGpuBackends tolerates empty and messy values", () => {
  assert.deepEqual(resolveFailedGpuBackends(undefined), []);
  assert.deepEqual(resolveFailedGpuBackends(""), []);
  assert.deepEqual(resolveFailedGpuBackends("cuda"), ["cuda"]);
  assert.deepEqual(resolveFailedGpuBackends(" cuda , vulkan ,"), ["cuda", "vulkan"]);
});

// The pack the settings card describes (#1736): the pack every server start
// picks, else the installed pack that failed, CUDA first, else none
const ONLY_CUDA = { cuda: true };
const ONLY_VULKAN = { vulkan: true };
const BOTH = { cuda: true, vulkan: true };
for (const [name, packs, failed, optedOut, expected] of [
  ["only CUDA", ONLY_CUDA, "", "", "cuda"],
  ["only CUDA, failed", ONLY_CUDA, "cuda", "", "cuda"],
  ["only CUDA, opted out", ONLY_CUDA, "", "CUDA", null],
  ["only Vulkan", ONLY_VULKAN, "", "", "vulkan"],
  ["only Vulkan, failed", ONLY_VULKAN, "vulkan", "", "vulkan"],
  ["only Vulkan, opted out", ONLY_VULKAN, "", "VULKAN", null],
  ["no pack", {}, "cuda,vulkan", "", null],
  ["both packs", BOTH, "", "", "cuda"],
  ["both packs, CUDA failed", BOTH, "cuda", "", "vulkan"],
  ["both packs, CUDA opted out", BOTH, "", "CUDA", "vulkan"],
  ["both packs, CUDA failed, Vulkan opted out", BOTH, "cuda", "VULKAN", "cuda"],
  ["both packs, Vulkan failed", BOTH, "vulkan", "", "cuda"],
  ["both packs, both failed", BOTH, "cuda,vulkan", "", "cuda"],
  ["both packs, CUDA opted out, Vulkan failed", BOTH, "vulkan", "CUDA", "vulkan"],
]) {
  test(`the pack in use with ${name}: ${expected}`, () => {
    process.env.WHISPER_GPU_FAILED = failed;
    if (optedOut) process.env[`WHISPER_${optedOut}_ENABLED`] = "false";
    const { cuda = false, vulkan = false } = packs;
    const manager = managerWith({ cudaDownloaded: cuda, vulkanDownloaded: vulkan });

    assert.equal(manager.resolveGpuPackInUse(), expected);
  });
}

test("without injected binary managers (macOS) no pack is in use", () => {
  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  assert.equal(new WhisperManager().resolveGpuPackInUse(), null);
});

test("_warnIfGpuFallback logs warning when CUDA is enabled in env but pack is missing", () => {
  const manager = managerWith({ cudaDownloaded: false });
  process.env.WHISPER_CUDA_ENABLED = "true";

  const originalWarn = debugLogger.warn;
  const warned = [];
  debugLogger.warn = (...args) => warned.push(args);

  try {
    manager._warnIfGpuFallback();
    assert.equal(warned.length, 1);
    assert.equal(warned[0][0], "Whisper CUDA enabled but cannot be used, falling back to CPU");
    assert.equal(warned[0][1].reason, "pack not installed or missing required libraries");

    // Deduplication check
    manager._warnIfGpuFallback();
    assert.equal(warned.length, 1);
  } finally {
    debugLogger.warn = originalWarn;
  }
});

test("_warnIfGpuFallback logs warning when CUDA is enabled in env and pack needs update", () => {
  const manager = new WhisperManager();
  manager.setGpuBinaryManagers({
    cuda: { isDownloaded: () => false, needsUpdate: () => true },
    vulkan: { isDownloaded: () => false, needsUpdate: () => false },
  });
  process.env.WHISPER_CUDA_ENABLED = "true";

  const originalWarn = debugLogger.warn;
  const warned = [];
  debugLogger.warn = (...args) => warned.push(args);

  try {
    manager._warnIfGpuFallback();
    assert.equal(warned.length, 1);
    assert.equal(warned[0][0], "Whisper CUDA enabled but cannot be used, falling back to CPU");
    assert.equal(warned[0][1].reason, "pack needs update");
  } finally {
    debugLogger.warn = originalWarn;
  }
});

test("_warnIfGpuFallback does not log when CUDA is downloaded and used", () => {
  const manager = managerWith({ cudaDownloaded: true });
  process.env.WHISPER_CUDA_ENABLED = "true";

  const originalWarn = debugLogger.warn;
  const warned = [];
  debugLogger.warn = (...args) => warned.push(args);

  try {
    manager._warnIfGpuFallback();
    assert.equal(warned.length, 0);
  } finally {
    debugLogger.warn = originalWarn;
  }
});

function fallbackWarnings(t, manager) {
  const warn = t.mock.method(debugLogger, "warn", () => {});
  manager._warnIfGpuFallback();
  return warn.mock.calls.map(({ arguments: [message, meta] }) => ({ message, ...meta }));
}

test("_warnIfGpuFallback warns about an outdated pack whose flag line was lost (#1340)", (t) => {
  const warnings = fallbackWarnings(t, managerWith({ cudaNeedsUpdate: true }));
  assert.deepEqual(warnings, [
    {
      message: "Whisper CUDA enabled but cannot be used, falling back to CPU",
      pack: "CUDA whisper",
      reason: "pack needs update",
    },
  ]);
});

test("_warnIfGpuFallback stays quiet for a pack that was never installed or is turned off", (t) => {
  assert.deepEqual(fallbackWarnings(t, managerWith()), [], "unset flag, no pack");

  process.env.WHISPER_CUDA_ENABLED = "false";
  process.env.WHISPER_VULKAN_ENABLED = "false";
  const turnedOff = managerWith({ cudaNeedsUpdate: true, vulkanNeedsUpdate: true });
  assert.deepEqual(fallbackWarnings(t, turnedOff), [], "explicit opt-out");
});

test("_warnIfGpuFallback names Vulkan when an unusable CUDA pack leaves it running", (t) => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  const manager = managerWith({ cudaNeedsUpdate: true, vulkanDownloaded: true });
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: false,
    useVulkan: true,
    fallbackToVulkan: false,
  });

  const [warning] = fallbackWarnings(t, manager);
  assert.equal(warning.message, "Whisper CUDA enabled but cannot be used, falling back to Vulkan");
});

test("_warnIfGpuFallback warns about an unusable Vulkan pack when CUDA isn't wanted", (t) => {
  process.env.WHISPER_VULKAN_ENABLED = "true";
  const warnings = fallbackWarnings(t, managerWith({ vulkanNeedsUpdate: true }));
  assert.deepEqual(warnings, [
    {
      message: "Whisper Vulkan enabled but cannot be used, falling back to CPU",
      pack: "Vulkan whisper",
      reason: "pack needs update",
    },
  ]);
});

test("_warnIfGpuFallback names a recorded failure for a downloaded pack", (t) => {
  process.env.WHISPER_GPU_FAILED = "cuda";
  const [warning] = fallbackWarnings(t, managerWith({ cudaDownloaded: true }));
  assert.equal(warning.reason, "previous failure recorded");
});

test("pre-warm and every server start check for a GPU fallback before starting", async (t) => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-gpu-warn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modelPath = path.join(dir, "ggml-base.bin");
  fs.writeFileSync(modelPath, "");

  const manager = managerWith();
  const order = [];
  t.mock.method(manager, "_warnIfGpuFallback", () => order.push("warn"));
  manager.getModelsDir = () => dir;
  manager.getModelPath = () => modelPath;
  manager.serverManager = {
    isAvailable: () => true,
    getServerBinaryPath: () => null,
    start: async () => {
      order.push("start");
      throw new Error("stop here");
    },
  };

  await manager.initializeAtStartup({
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
  });
  assert.deepEqual(order, ["warn", "start"], "pre-warm");

  order.length = 0;
  await assert.rejects(manager._runServerTranscription(Buffer.alloc(0), "base", "en"), /stop here/);
  assert.deepEqual(order, ["warn", "start"], "server start");
});

test("_warnIfGpuFallback ignores an outdated Vulkan pack while CUDA runs", (t) => {
  const manager = managerWith({ cudaDownloaded: true, vulkanNeedsUpdate: true });
  assert.deepEqual(manager.resolveGpuStartOptions(), {
    useCuda: true,
    useVulkan: false,
    fallbackToVulkan: false,
  });
  assert.deepEqual(fallbackWarnings(t, manager), []);
});
