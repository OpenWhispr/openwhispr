// Qualcomm Hexagon NPU transcription runs through ONNX Runtime's QNN execution
// provider, which today is only shipped for Windows on Snapdragon (ARM64).
const { detectQualcommCpu } = require("../utils/qualcommCpu");
const QUALCOMM_UNSUPPORTED_PLATFORM_CODE = "QUALCOMM_UNSUPPORTED_PLATFORM";
// The platform gate alone is not enough: an ARM64 Windows machine whose CPU is
// not Qualcomm's has no Hexagon NPU, so the full gate also matches the
// processor name (see qualcommCpu.js).
const QUALCOMM_CPU_NOT_DETECTED_CODE = "QUALCOMM_CPU_NOT_DETECTED";

function getQualcommCapability({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "win32") {
    return {
      supported: false,
      code: QUALCOMM_UNSUPPORTED_PLATFORM_CODE,
      message:
        "Qualcomm NPU transcription requires Windows on Snapdragon. Use local Whisper or Parakeet on this device.",
    };
  }

  // x64 Windows on ARM devices cannot reach the NPU: the QNN runtime and the
  // precompiled exports are native ARM64.
  if (arch !== "arm64") {
    return {
      supported: false,
      code: QUALCOMM_UNSUPPORTED_PLATFORM_CODE,
      message:
        "Qualcomm NPU transcription requires a native ARM64 build on Windows on Snapdragon.",
    };
  }

  return { supported: true };
}

/**
 * The full gate every NPU feature shares: Snapdragon platform AND a Qualcomm
 * processor behind it. Async because the CPU answer comes from a cached WMI
 * query. `reason` distinguishes the two failure modes so UI copy can be exact.
 */
async function getQualcommNpuCapability(options = {}) {
  const platform = getQualcommCapability(options);
  if (!platform.supported) {
    return { ...platform, reason: "platform", cpuName: null };
  }

  const cpu = await detectQualcommCpu(options);
  if (!cpu.qualcommCpu) {
    return {
      supported: false,
      code: QUALCOMM_CPU_NOT_DETECTED_CODE,
      reason: "cpu",
      cpuName: cpu.cpuName,
      message: "Qualcomm NPU features require a Snapdragon (Qualcomm) processor.",
    };
  }

  return { supported: true, reason: null, cpuName: cpu.cpuName };
}

async function assertQualcommNpuSupported(options) {
  const capability = await getQualcommNpuCapability(options);
  if (capability.supported) return;
  throw Object.assign(new Error(capability.message), {
    code: capability.code,
  });
}

function assertQualcommSupported(options) {
  const capability = getQualcommCapability(options);
  if (capability.supported) return;

  throw Object.assign(new Error(capability.message), {
    code: capability.code,
  });
}

module.exports = {
  QUALCOMM_UNSUPPORTED_PLATFORM_CODE,
  QUALCOMM_CPU_NOT_DETECTED_CODE,
  getQualcommCapability,
  getQualcommNpuCapability,
  assertQualcommSupported,
  assertQualcommNpuSupported,
};
