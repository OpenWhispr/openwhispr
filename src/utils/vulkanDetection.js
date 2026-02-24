const { app } = require("electron");

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
    const match = renderer.match(/ANGLE\s*\([^,]*,\s*([^,)]+)/);
    if (match) return match[1].trim();
  }
  if (activeGpu?.vendorId) {
    return VENDOR_NAMES[activeGpu.vendorId] || `GPU (vendor ${activeGpu.vendorId})`;
  }
  return null;
}

async function detectVulkanGpu() {
  if (cachedResult) return cachedResult;

  if (process.platform === "darwin") {
    cachedResult = { available: false };
    return cachedResult;
  }

  try {
    const gpuInfo = await app.getGPUInfo("complete");
    const activeGpu = gpuInfo.gpuDevice?.find((d) => d.active) || gpuInfo.gpuDevice?.[0];

    if (!activeGpu || !VULKAN_VENDOR_IDS.has(activeGpu.vendorId)) {
      cachedResult = { available: false };
      return cachedResult;
    }

    cachedResult = {
      available: true,
      deviceName: parseDeviceName(gpuInfo, activeGpu),
    };
    return cachedResult;
  } catch {
    cachedResult = { available: false };
    return cachedResult;
  }
}

function clearCache() {
  cachedResult = null;
}

module.exports = { detectVulkanGpu, clearCache };
