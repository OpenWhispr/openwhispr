const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/whisperGpuPack.ts");

const NVIDIA = { hasNvidiaGpu: true, cudaSupported: true };
const BELOW_FLOOR = { hasNvidiaGpu: true, cudaSupported: false };
const NO_NVIDIA = { hasNvidiaGpu: false, cudaSupported: false };

const cuda = (gpuInfo, pack = {}) => ({
  downloaded: false,
  downloading: false,
  path: null,
  gpuInfo,
  ...pack,
});
const vulkan = (available, pack = {}) => ({
  downloaded: false,
  downloading: false,
  vulkan: { available },
  hasNvidiaGpu: false,
  ...pack,
});
const DOWNLOADED = { downloaded: true };
const OUTDATED = { needsUpdate: true };

test("packs that aren't outdated keep the card's earlier choice", async () => {
  const { pickWhisperGpuBackend } = await load();
  const cases = [
    [cuda(NVIDIA, DOWNLOADED), vulkan(true, DOWNLOADED), "cuda"],
    [cuda(NVIDIA), vulkan(true, DOWNLOADED), "vulkan"],
    [cuda(NVIDIA), vulkan(true), "cuda"],
    [cuda(NVIDIA), vulkan(false), "cuda"],
    [cuda(BELOW_FLOOR), vulkan(true), "vulkan"],
    [cuda(NO_NVIDIA), vulkan(true, DOWNLOADED), "vulkan"],
    [cuda(NO_NVIDIA), vulkan(false), null],
    [null, null, null],
  ];
  for (const [cudaStatus, vulkanStatus, expected] of cases) {
    assert.equal(
      pickWhisperGpuBackend(cudaStatus, vulkanStatus),
      expected,
      JSON.stringify({ cudaStatus, vulkanStatus })
    );
  }
});

test("a working pack wins over an outdated one", async () => {
  const { pickWhisperGpuBackend } = await load();
  assert.equal(pickWhisperGpuBackend(cuda(NVIDIA, DOWNLOADED), vulkan(true, OUTDATED)), "cuda");
  assert.equal(pickWhisperGpuBackend(cuda(NVIDIA, OUTDATED), vulkan(true, DOWNLOADED)), "vulkan");
});

test("an outdated pack wins over a first-time offer (#2424)", async () => {
  const { pickWhisperGpuBackend } = await load();
  assert.equal(pickWhisperGpuBackend(cuda(NVIDIA), vulkan(true, OUTDATED)), "vulkan");
  assert.equal(pickWhisperGpuBackend(cuda(NVIDIA, OUTDATED), vulkan(true, OUTDATED)), "cuda");
  assert.equal(pickWhisperGpuBackend(cuda(NO_NVIDIA, OUTDATED), vulkan(true)), "cuda");
});

test("an outdated pack is offered even when GPU detection no longer sees the GPU", async () => {
  const { pickWhisperGpuBackend } = await load();
  // NVIDIA card, but Chromium reports no Vulkan GPU (RDP, a VM, software rendering)
  assert.equal(pickWhisperGpuBackend(cuda(NVIDIA), vulkan(false, OUTDATED)), "vulkan");
  // nvidia-smi failed and there is no Vulkan GPU either
  assert.equal(pickWhisperGpuBackend(cuda(NO_NVIDIA, OUTDATED), vulkan(false)), "cuda");
  // Once that Vulkan pack is re-downloaded the card still has something to show
  assert.equal(pickWhisperGpuBackend(cuda(NVIDIA), vulkan(false, DOWNLOADED)), "cuda");
});

test("a card below the CUDA kernel floor is never offered the CUDA pack", async () => {
  const { pickWhisperGpuBackend } = await load();
  assert.equal(pickWhisperGpuBackend(cuda(BELOW_FLOOR, OUTDATED), vulkan(true)), "vulkan");
  assert.equal(pickWhisperGpuBackend(cuda(BELOW_FLOOR, OUTDATED), vulkan(false)), null);
});
