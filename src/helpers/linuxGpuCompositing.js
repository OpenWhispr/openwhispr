const fs = require("fs");

// Linux composites on the GPU, as Windows does, except on NVIDIA's proprietary driver:
// before 555 it has no explicit sync, so GPU-composited windows flicker under Wayland and
// XWayland alike (#203 was driver 550 on GNOME Wayland), and Chromium's GPU blocklist
// doesn't cover it. The driver's kernel module publishes this file whenever it is loaded.
const NVIDIA_DRIVER_VERSION_PATH = "/proc/driver/nvidia/version";

function shouldDisableGpuCompositing(fileExists = fs.existsSync) {
  return process.platform === "linux" && fileExists(NVIDIA_DRIVER_VERSION_PATH);
}

module.exports = { NVIDIA_DRIVER_VERSION_PATH, shouldDisableGpuCompositing };
