// Qualcomm Hexagon NPU transcription runs through ONNX Runtime's QNN execution
// provider, which today is only shipped for Windows on Snapdragon (ARM64).
const QUALCOMM_UNSUPPORTED_PLATFORM_CODE = "QUALCOMM_UNSUPPORTED_PLATFORM";

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

function assertQualcommSupported(options) {
  const capability = getQualcommCapability(options);
  if (capability.supported) return;

  throw Object.assign(new Error(capability.message), {
    code: capability.code,
  });
}

module.exports = {
  QUALCOMM_UNSUPPORTED_PLATFORM_CODE,
  getQualcommCapability,
  assertQualcommSupported,
};
