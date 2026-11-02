const fs = require("fs");

// Linux composites on the GPU, as Windows does, except whenever an NVIDIA kernel module
// (proprietary or open) is loaded, on any driver version. #203's flicker was driver 550 on
// GNOME Wayland; Chromium's GPU blocklist doesn't cover it. Explicit sync fixes it only with
// driver 555+, Xwayland 24.1+ and a compositor that supports it, none of which can be checked
// before app ready, so every NVIDIA setup, Optimus laptops included, keeps CPU compositing.
const NVIDIA_DRIVER_VERSION_PATH = "/proc/driver/nvidia/version";

function shouldDisableGpuCompositing(fileExists = fs.existsSync) {
  return process.platform === "linux" && fileExists(NVIDIA_DRIVER_VERSION_PATH);
}

module.exports = { NVIDIA_DRIVER_VERSION_PATH, shouldDisableGpuCompositing };
