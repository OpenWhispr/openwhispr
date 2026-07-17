const GpuBinaryManager = require("./gpuBinaryManager");

const GITHUB_RELEASE_URL = "https://api.github.com/repos/OpenWhispr/whisper.cpp/releases/latest";

class WhisperCudaManager extends GpuBinaryManager {
  constructor() {
    super({
      name: "CUDA whisper",
      releaseUrl: GITHUB_RELEASE_URL,
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
