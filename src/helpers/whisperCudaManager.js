const GpuBinaryManager = require("./gpuBinaryManager");
const { WHISPER_CPP_TAG, WINDOWS_MSVC_RUNTIME_LIBRARIES } = require("./whisperCppRelease");

// Pinned so untested future binaries never auto-ship; bump together with the digests below
// sha256 per release tag; tags without an entry fall back to the API-reported digest
const EXPECTED_DIGESTS = {
  // Adds app-local MSVC runtime DLLs to the Windows archive
  "0.0.10": {
    "whisper-server-win32-x64-cuda.zip":
      "4bcf9f28bb1f725163442789015a600cdbccc4c40063de97d29f40b5855bb041",
    "whisper-server-linux-x64-cuda.zip":
      "9282d706a3c1853e10f563be5fab3d7e9e544142cc73fe9e6470aaeeaf0a5454",
  },
  // Same source as 0.0.8; adds Pascal (sm_61) CUDA kernels
  "0.0.9": {
    "whisper-server-win32-x64-cuda.zip":
      "f5fdc42696c2de6ae323c59b5589b7d6b234ecdd4dd99ca18360824b529ad2d9",
    "whisper-server-linux-x64-cuda.zip":
      "11f4c6403b91e751375aac8cdef19582a9f383e0b96c5500ae81daeedb3be3f7",
  },
  "0.0.8": {
    "whisper-server-win32-x64-cuda.zip":
      "ef6df3492b6e512ccfb04ce69e01ac26b2e12f3c90a665cdb35e7f1f471ed203",
    "whisper-server-linux-x64-cuda.zip":
      "8c71e63658fafd3efec39bb0ff3c0d15790ede0be87849dfbf9ad8a81e04b3d0",
  },
};

const BIN_SUBDIR = "whisper-cuda";

class WhisperCudaManager extends GpuBinaryManager {
  constructor() {
    super({
      name: "CUDA whisper",
      dirName: BIN_SUBDIR,
      releaseUrl: `https://api.github.com/repos/OpenWhispr/whisper.cpp/releases/tags/${WHISPER_CPP_TAG}`,
      expectedDigests: EXPECTED_DIGESTS[WHISPER_CPP_TAG],
      assets: {
        "win32-x64": {
          assetName: "whisper-server-win32-x64-cuda.zip",
          binaryName: "whisper-server-win32-x64-cuda.exe",
          outputName: "whisper-server-win32-x64-cuda.exe",
          libPattern: /\.dll$/i,
          requiredLibraries: WINDOWS_MSVC_RUNTIME_LIBRARIES,
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
module.exports.BIN_SUBDIR = BIN_SUBDIR;
