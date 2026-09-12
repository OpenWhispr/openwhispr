const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WhisperManager = require("../../src/helpers/whisper.js");
const { resolveFailedGpuBackends } = require("../../src/helpers/whisper.js");

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

function managerWith({ cudaDownloaded = false, vulkanDownloaded = false } = {}) {
  const manager = new WhisperManager();
  manager.setGpuBinaryManagers({
    cuda: { isDownloaded: () => cudaDownloaded },
    vulkan: { isDownloaded: () => vulkanDownloaded },
  });
  return manager;
}

test("no packs enabled resolves to CPU", () => {
  assert.deepEqual(managerWith().resolveGpuStartOptions(), { useCuda: false, useVulkan: false });
});

test("an enabled + downloaded pack engages without an app restart", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  const manager = managerWith({ cudaDownloaded: true });
  assert.deepEqual(manager.resolveGpuStartOptions(), { useCuda: true, useVulkan: false });
});

test("enabled but not downloaded resolves to CPU (env flag alone is not an install)", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.WHISPER_VULKAN_ENABLED = "true";
  assert.deepEqual(managerWith().resolveGpuStartOptions(), { useCuda: false, useVulkan: false });
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
  assert.deepEqual(manager.resolveGpuStartOptions(), { useCuda: false, useVulkan: true });

  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  assert.deepEqual(manager.resolveGpuStartOptions(), { useCuda: false, useVulkan: false });
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
  assert.deepEqual(vulkanOnly.resolveGpuStartOptions(), { useCuda: false, useVulkan: true });

  const cudaOnly = managerWith({ cudaDownloaded: true });
  assert.deepEqual(cudaOnly.resolveGpuStartOptions(), { useCuda: true, useVulkan: false });
});

test("explicit 'false' opts a downloaded pack out", () => {
  process.env.WHISPER_VULKAN_ENABLED = "false";
  const vulkanOnly = managerWith({ vulkanDownloaded: true });
  assert.deepEqual(vulkanOnly.resolveGpuStartOptions(), { useCuda: false, useVulkan: false });

  process.env.WHISPER_CUDA_ENABLED = "false";
  const cudaOnly = managerWith({ cudaDownloaded: true });
  assert.deepEqual(cudaOnly.resolveGpuStartOptions(), { useCuda: false, useVulkan: false });
});

test("the 'false' opt-out is case-insensitive (hand-edited .env)", () => {
  // The flag is a hand-edit surface now, so FALSE/False must opt out too.
  process.env.WHISPER_VULKAN_ENABLED = "FALSE";
  const vulkanOnly = managerWith({ vulkanDownloaded: true });
  assert.deepEqual(vulkanOnly.resolveGpuStartOptions(), { useCuda: false, useVulkan: false });

  process.env.WHISPER_CUDA_ENABLED = "False";
  const cudaOnly = managerWith({ cudaDownloaded: true });
  assert.deepEqual(cudaOnly.resolveGpuStartOptions(), { useCuda: false, useVulkan: false });
});

test("a remembered failure still gates a flag-less downloaded pack", () => {
  process.env.WHISPER_GPU_FAILED = "vulkan";
  const manager = managerWith({ vulkanDownloaded: true });
  assert.deepEqual(manager.resolveGpuStartOptions(), { useCuda: false, useVulkan: false });
});

test("without injected binary managers (macOS) everything resolves to CPU", () => {
  process.env.WHISPER_CUDA_ENABLED = "true";
  process.env.WHISPER_VULKAN_ENABLED = "true";
  const manager = new WhisperManager();
  assert.deepEqual(manager.resolveGpuStartOptions(), { useCuda: false, useVulkan: false });
});

test("resolveFailedGpuBackends tolerates empty and messy values", () => {
  assert.deepEqual(resolveFailedGpuBackends(undefined), []);
  assert.deepEqual(resolveFailedGpuBackends(""), []);
  assert.deepEqual(resolveFailedGpuBackends("cuda"), ["cuda"]);
  assert.deepEqual(resolveFailedGpuBackends(" cuda , vulkan ,"), ["cuda", "vulkan"]);
});
