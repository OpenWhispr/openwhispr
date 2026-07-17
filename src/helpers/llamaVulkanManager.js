const GpuBinaryManager = require("./gpuBinaryManager");

// Pinned to the same build as the bundled CPU binary (download-llama-server.js).
// Overridable via LLAMA_CPP_VERSION so GPU and CPU stay on one tested llama.cpp.
const LLAMA_CPP_TAG = process.env.LLAMA_CPP_VERSION || "b9763";

class LlamaVulkanManager extends GpuBinaryManager {
  constructor() {
    super({
      name: "Vulkan llama",
      releaseUrl: `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_CPP_TAG}`,
      assets: {
        "win32-x64": {
          assetPattern: /^llama-.*-bin-win-vulkan-x64\.zip$/,
          binaryName: "llama-server.exe",
          outputName: "llama-server-vulkan.exe",
          libPattern: /\.dll$/i,
        },
        "linux-x64": {
          assetPattern: /^llama-.*-bin-ubuntu-vulkan-x64\.tar\.gz$/,
          binaryName: "llama-server",
          outputName: "llama-server-vulkan",
          libPattern: /\.so(\.\d+)*$/,
        },
      },
    });
  }

  async download(onProgress) {
    try {
      await super.download(onProgress);
      return { success: true };
    } catch (error) {
      if (error.isAbort) return { success: false, cancelled: true };
      throw error;
    }
  }

  async deleteBinary() {
    const { deletedCount } = await this.delete();
    return { success: true, deletedCount };
  }
}

module.exports = LlamaVulkanManager;
