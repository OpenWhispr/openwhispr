let cachedResult = null;

const VULKAN_VENDOR_IDS = new Set([
  0x10de, // NVIDIA
  0x1002, // AMD
  0x8086, // Intel
]);

const VENDOR_NAMES = {
  0x10de: "NVIDIA",
  0x1002: "AMD",
  0x8086: "Intel",
};

function parseDeviceName(gpuInfo, activeGpu) {
  const renderer = gpuInfo.auxAttributes?.glRenderer;
  if (renderer) {
    // The name may hold its own brackets: "Intel(R) UHD Graphics 620 (0x5917) Direct3D11 ..."
    const match = renderer.match(/ANGLE\s*\([^,]*,\s*((?:[^,()]|\([^()]*\))+)/);
    if (match) return match[1].trim();
  }
  if (activeGpu?.vendorId) {
    return VENDOR_NAMES[activeGpu.vendorId] || `GPU (vendor ${activeGpu.vendorId})`;
  }
  return null;
}

// Electron is required on use, not at load, so callers that inject their own
// getGPUInfo (the computer-profile tests) never touch it.
const defaultGetGPUInfo = (type) => require("electron").app.getGPUInfo(type);

// The GPU Chromium is rendering with, on any platform. A failed read is null.
async function readActiveGpu({ getGPUInfo = defaultGetGPUInfo } = {}) {
  try {
    const gpuInfo = await getGPUInfo("complete");
    const activeGpu = gpuInfo.gpuDevice?.find((d) => d.active) || gpuInfo.gpuDevice?.[0];
    if (!activeGpu) return null;
    return { vendorId: activeGpu.vendorId, deviceName: parseDeviceName(gpuInfo, activeGpu) };
  } catch {
    return null;
  }
}

async function detectVulkanGpu() {
  if (cachedResult) return cachedResult;

  if (process.platform === "darwin") {
    cachedResult = { available: false };
    return cachedResult;
  }

  const activeGpu = await readActiveGpu();
  cachedResult =
    activeGpu && VULKAN_VENDOR_IDS.has(activeGpu.vendorId)
      ? { available: true, deviceName: activeGpu.deviceName }
      : { available: false };
  return cachedResult;
}

function clearCache() {
  cachedResult = null;
}

module.exports = { detectVulkanGpu, readActiveGpu, parseDeviceName, clearCache };
