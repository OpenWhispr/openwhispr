const GpuBinaryManager = require("./gpuBinaryManager");

// Pinned so untested future binaries never auto-ship; bump together with the digests below
const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.9";

// sha256 per release tag; tags without an entry fall back to the API-reported digest
const EXPECTED_DIGESTS = {
  // Same source as 0.0.8, rebuilt alongside the Pascal CUDA kernels
  "0.0.9": {
    "whisper-server-win32-x64-vulkan.zip":
      "6f33424d111036c18a9c5d2c0c09c67f458f48fa3c86553f875bca23ae11014d",
    "whisper-server-linux-x64-vulkan.zip":
      "02ddc850715421ff92940d5b4589cce95e3dec1906a134d3d0c809065f47fb5d",
  },
  "0.0.8": {
    "whisper-server-win32-x64-vulkan.zip":
      "d5f6188bb6561e66a9b7886ca0448d5927cb9713a02d311b87a20e33eb038222",
    "whisper-server-linux-x64-vulkan.zip":
      "6e3e355dff3a1e96550d63445dc1ba4a881c2e63fe93be6a4f5ed946a204be27",
  },
};

const BIN_SUBDIR = "whisper-vulkan";

// Statically linked — no companion libs to copy
class WhisperVulkanManager extends GpuBinaryManager {
  constructor() {
    super({
      name: "Vulkan whisper",
      dirName: BIN_SUBDIR,
      releaseUrl: `https://api.github.com/repos/OpenWhispr/whisper.cpp/releases/tags/${WHISPER_CPP_TAG}`,
      expectedDigests: EXPECTED_DIGESTS[WHISPER_CPP_TAG],
      assets: {
        "win32-x64": {
          assetName: "whisper-server-win32-x64-vulkan.zip",
          binaryName: "whisper-server-win32-x64-vulkan.exe",
          outputName: "whisper-server-win32-x64-vulkan.exe",
        },
        "linux-x64": {
          assetName: "whisper-server-linux-x64-vulkan.zip",
          binaryName: "whisper-server-linux-x64-vulkan",
          outputName: "whisper-server-linux-x64-vulkan",
        },
      },
    });
  }
}

module.exports = WhisperVulkanManager;
module.exports.BIN_SUBDIR = BIN_SUBDIR;
