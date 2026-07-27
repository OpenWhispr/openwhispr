// Overlay positioning and globalShortcut both need X11, so every Linux Wayland
// session runs under XWayland. Packaged builds apply the same rule from the
// launcher script (scripts/lib/linux-launcher.js); keep the two in sync.

const OZONE_PLATFORM_PREFIX = "--ozone-platform=";
const XWAYLAND_FLAG = `${OZONE_PLATFORM_PREFIX}x11`;

function shouldForceXWayland(argv) {
  return (
    process.platform === "linux" &&
    process.env.XDG_SESSION_TYPE === "wayland" &&
    !argv.some((arg) => arg.startsWith(OZONE_PLATFORM_PREFIX))
  );
}

module.exports = { OZONE_PLATFORM_PREFIX, XWAYLAND_FLAG, shouldForceXWayland };
