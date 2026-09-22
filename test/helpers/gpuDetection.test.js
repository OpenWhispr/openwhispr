const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNvidiaSmiGpuInfo,
  parseWmiVideoControllers,
  isCudaCapableGpuName,
  MIN_CUDA_COMPUTE_CAP,
} = require("../../src/utils/gpuDetection.js");

// The CUDA pack must only be offered to cards its build actually carries
// kernels for. A Pascal card passing this gate cost two days of debugging
// ("GPU acceleration active" while every transcription crashed).

test("Turing and newer report cudaSupported", () => {
  const info = parseNvidiaSmiGpuInfo("NVIDIA GeForce RTX 4090, 582.66, 24564, 8.9");
  assert.deepEqual(info, {
    hasNvidiaGpu: true,
    gpuName: "NVIDIA GeForce RTX 4090",
    driverVersion: "582.66",
    vramMb: 24564,
    computeCap: 8.9,
    cudaSupported: true,
  });
});

test("Pascal is CUDA-supported since the 0.0.10 build ships sm_61 kernels", () => {
  const info = parseNvidiaSmiGpuInfo("NVIDIA GeForce GTX 1080 Ti, 582.66, 11264, 6.1");
  assert.equal(info.hasNvidiaGpu, true);
  assert.equal(info.computeCap, 6.1);
  assert.equal(info.cudaSupported, true);
});

test("Maxwell is detected but not CUDA-supported (gets Vulkan instead)", () => {
  const info = parseNvidiaSmiGpuInfo("NVIDIA GeForce GTX 970, 560.94, 4096, 5.2");
  assert.equal(info.hasNvidiaGpu, true);
  assert.equal(info.computeCap, 5.2);
  assert.equal(info.cudaSupported, false);
});

test("exactly the minimum compute capability is supported", () => {
  const info = parseNvidiaSmiGpuInfo(`Some GPU, 560.94, 6144, ${MIN_CUDA_COMPUTE_CAP}`);
  assert.equal(info.cudaSupported, true);
});

test("a legacy query without compute_cap detects the GPU but stays conservative", () => {
  const info = parseNvidiaSmiGpuInfo("NVIDIA GeForce GTX 970, 460.89, 4096");
  assert.equal(info.hasNvidiaGpu, true);
  assert.equal(info.computeCap, undefined);
  assert.equal(info.cudaSupported, false);
});

test("an unparseable compute_cap ([N/A]) stays conservative", () => {
  const info = parseNvidiaSmiGpuInfo("Some GPU, 582.66, 8192, [N/A]");
  assert.equal(info.hasNvidiaGpu, true);
  assert.equal(info.cudaSupported, false);
});

test("multi-GPU output uses the primary card", () => {
  const info = parseNvidiaSmiGpuInfo(
    "NVIDIA GeForce GTX 970, 560.94, 4096, 5.2\nNVIDIA T400, 582.66, 2048, 7.5"
  );
  assert.equal(info.gpuName, "NVIDIA GeForce GTX 970");
  assert.equal(info.cudaSupported, false);
});

test("garbage output is not an NVIDIA GPU", () => {
  assert.deepEqual(parseNvidiaSmiGpuInfo("command not found"), { hasNvidiaGpu: false });
});

test("parseWmiVideoControllers picks the NVIDIA adapter out of a multi-GPU list", () => {
  // The #1606 reporter's three adapters, as PowerShell prints them
  const stdout = "AMD Radeon RX 7900 XTX\r\nNVIDIA GeForce RTX 4060 Ti\r\nIntel(R) UHD Graphics 770\r\n";
  assert.equal(parseWmiVideoControllers(stdout), "NVIDIA GeForce RTX 4060 Ti");
});

test("parseWmiVideoControllers returns null when no NVIDIA adapter is present", () => {
  assert.equal(parseWmiVideoControllers("AMD Radeon RX 7900 XTX\r\nIntel(R) UHD Graphics 770\r\n"), null);
  assert.equal(parseWmiVideoControllers(""), null);
});

// The WMI rung has no compute capability to gate on, so only names that
// provably sit at or above the kernel floor may pass.
test("isCudaCapableGpuName accepts families provably at or above the floor", () => {
  for (const name of [
    "NVIDIA GeForce RTX 4060 Ti",
    "Quadro RTX 4000",
    "NVIDIA TITAN RTX",
    "NVIDIA GeForce GTX 1080 Ti",
    "NVIDIA GeForce GTX 1660 SUPER",
    "NVIDIA TITAN Xp",
    "NVIDIA TITAN V",
  ]) {
    assert.equal(isCudaCapableGpuName(name), true, name);
  }
});

test("isCudaCapableGpuName rejects unproven and non-NVIDIA names", () => {
  for (const name of [
    "NVIDIA GeForce GTX 970",
    "NVIDIA GeForce GTX 980 Ti",
    "NVIDIA TITAN X", // Maxwell — not the Pascal "TITAN Xp"
    "Quadro M4000",
    "AMD Radeon RX 7900 XTX",
    "Intel(R) UHD Graphics 770",
    "",
    null,
  ]) {
    assert.equal(isCudaCapableGpuName(name), false, String(name));
  }
});
