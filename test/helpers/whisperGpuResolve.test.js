const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperManager = require("../../src/helpers/whisper.js");
const { resolveFailedGpuBackends } = require("../../src/helpers/whisper.js");

// Every whisper-server start resolves its GPU backend from the current env +
// installed packs + remembered failures. This is what makes "Enable GPU" work
// without an app restart, and what stops a crashed backend from being
// re-attempted (and its model reload re-paid) on every launch.

const ENV_KEYS = [
  "WHISPER_CUDA_ENABLED",
  "WHISPER_VULKAN_ENABLED",
  "WHISPER_GPU_FAILED",
  "WHISPER_GPU_FAILED_REASON_CUDA",
  "WHISPER_GPU_FAILED_REASON_VULKAN",
];
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

const debugLogger = require("../../src/helpers/debugLogger");
const VULKAN_SKIPPED =
  "Vulkan pack skipped: it fell back to CPU on an earlier start (Retry in settings)";
const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";

function captureInfoLogs(t) {
  const logged = [];
  t.mock.method(debugLogger, "info", (message, meta) => logged.push({ message, meta }));
  return logged;
}

test("a downloaded pack skipped for an earlier failure is logged once per state, with its saved reason", (t) => {
  // A debug log turned on after the fallback otherwise shows only a CPU start (#1736)
  const logged = captureInfoLogs(t);
  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;
  // CUDA failed too but its pack is gone, so there is nothing skipped to explain
  const manager = managerWith({ vulkanDownloaded: true });

  manager.resolveGpuStartOptions();
  manager.resolveGpuStartOptions();
  // A later failure with another cause is a new state
  process.env.WHISPER_GPU_FAILED_REASON_VULKAN = "exit code 3";
  manager.resolveGpuStartOptions();

  assert.deepEqual(logged, [
    { message: VULKAN_SKIPPED, meta: { reason: DEVICE_LOST } },
    { message: VULKAN_SKIPPED, meta: { reason: "exit code 3" } },
  ]);
});

test("the skipped pack is logged again when debug mode is switched on without a restart", (t) => {
  // Settings > Developer > Debug mode raises the level live. The startup line
  // went to no file, so the debug file opened now must get it too.
  const logged = captureInfoLogs(t);
  let level = "info";
  t.mock.method(debugLogger, "getLevel", () => level);
  process.env.WHISPER_GPU_FAILED = "vulkan";
  process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;
  const manager = managerWith({ vulkanDownloaded: true });

  manager.resolveGpuStartOptions();
  level = "debug";
  manager.resolveGpuStartOptions();
  manager.resolveGpuStartOptions();

  assert.deepEqual(logged, [
    { message: VULKAN_SKIPPED, meta: { reason: DEVICE_LOST } },
    { message: VULKAN_SKIPPED, meta: { reason: DEVICE_LOST } },
  ]);
});

// The pack the settings card describes (#1736): the pack every server start
// picks, else the installed pack that failed, CUDA first, else none
const ONLY_CUDA = { cuda: true };
const ONLY_VULKAN = { vulkan: true };
const BOTH = { cuda: true, vulkan: true };
for (const [name, packs, failed, cudaOptedOut, expected] of [
  ["only CUDA", ONLY_CUDA, "", false, "cuda"],
  ["only CUDA, failed", ONLY_CUDA, "cuda", false, "cuda"],
  ["only CUDA, opted out", ONLY_CUDA, "", true, null],
  ["only Vulkan", ONLY_VULKAN, "", false, "vulkan"],
  ["only Vulkan, failed", ONLY_VULKAN, "vulkan", false, "vulkan"],
  ["no pack", {}, "cuda,vulkan", false, null],
  ["both packs", BOTH, "", false, "cuda"],
  ["both packs, CUDA failed", BOTH, "cuda", false, "vulkan"],
  ["both packs, CUDA opted out", BOTH, "", true, "vulkan"],
  ["both packs, Vulkan failed", BOTH, "vulkan", false, "cuda"],
  ["both packs, both failed", BOTH, "cuda,vulkan", false, "cuda"],
  ["both packs, CUDA opted out, Vulkan failed", BOTH, "vulkan", true, "vulkan"],
]) {
  test(`the pack in use with ${name}: ${expected}`, () => {
    process.env.WHISPER_GPU_FAILED = failed;
    if (cudaOptedOut) process.env.WHISPER_CUDA_ENABLED = "false";
    const { cuda = false, vulkan = false } = packs;
    const manager = managerWith({ cudaDownloaded: cuda, vulkanDownloaded: vulkan });

    assert.equal(manager.resolveGpuPackInUse(), expected);
  });
}

test("without injected binary managers (macOS) no pack is in use", () => {
  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  assert.equal(new WhisperManager().resolveGpuPackInUse(), null);
});
