const GpuBinaryManager = require("./gpuBinaryManager");

// Pinned so untested future binaries never auto-ship; bump together with the digests below
const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.8";

// sha256 per release tag; tags without an entry fall back to the API-reported digest
const EXPECTED_DIGESTS = {
  "0.0.8": {
    "whisper-server-win32-x64-cuda.zip":
      "ef6df3492b6e512ccfb04ce69e01ac26b2e12f3c90a665cdb35e7f1f471ed203",
    "whisper-server-linux-x64-cuda.zip":
      "8c71e63658fafd3efec39bb0ff3c0d15790ede0be87849dfbf9ad8a81e04b3d0",
  },
};

class WhisperCudaManager extends GpuBinaryManager {
  constructor() {
    super({
      name: "CUDA whisper",
      releaseUrl: `https://api.github.com/repos/OpenWhispr/whisper.cpp/releases/tags/${WHISPER_CPP_TAG}`,
      expectedDigests: EXPECTED_DIGESTS[WHISPER_CPP_TAG],
      assets: {
        "win32-x64": {
          assetName: "whisper-server-win32-x64-cuda.zip",
          binaryName: "whisper-server-win32-x64-cuda.exe",
          outputName: "whisper-server-win32-x64-cuda.exe",
          libPattern: /\.dll$/i,
        },
        "linux-x64": {
          assetName: "whisper-server-linux-x64-cuda.zip",
          binaryName: "whisper-server-linux-x64-cuda",
          outputName: "whisper-server-linux-x64-cuda",
          libPattern: /\.so(\.\d+)*$/,
        },
      },
    });
  }

  getCudaBinaryPath() {
    return this.getBinaryPath();
  }

  async download(onProgress) {
    try {
      await super.download(onProgress);
    } catch (error) {
      if (error.isAbort) throw new Error("Download cancelled by user");
      throw error;
    }
  }

  async cancelDownload() {
    if (super.cancelDownload()) {
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async delete() {
    if (!this.isSupported()) {
      return { success: false, error: "Not supported on this platform" };
    }
    const { deletedCount, freedBytes } = await super.delete();
    return {
      success: deletedCount > 0,
      deleted_count: deletedCount,
      freed_bytes: freedBytes,
      freed_mb: Math.round(freedBytes / (1024 * 1024)),
    };
  }
}

module.exports = WhisperCudaManager;
