const test = require("node:test");
const assert = require("node:assert/strict");

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
  assert.deepEqual(manager.resolveGpuStartOptions(), { useCuda: true, useVulkan: false });
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
