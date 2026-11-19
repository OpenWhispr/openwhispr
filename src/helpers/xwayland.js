// Overlay positioning and globalShortcut both need X11, so every Linux Wayland
// session runs under XWayland. Packaged builds apply the same rule from the
// launcher script (scripts/lib/linux-launcher.js); keep the two in sync.

const OZONE_PLATFORM_PREFIX = "--ozone-platform=";
const XWAYLAND_FLAG = `${OZONE_PLATFORM_PREFIX}x11`;
const SCALE_PREFIX = "--force-device-scale-factor=";

function shouldForceXWayland(argv) {
  return (
    process.platform === "linux" &&
    process.env.XDG_SESSION_TYPE === "wayland" &&
    !argv.some((arg) => arg.startsWith(OZONE_PLATFORM_PREFIX))
  );
}

function shouldResolveScale(argv) {
  return !argv.some((arg) => arg.startsWith(SCALE_PREFIX));
}

function runHyprctl(args) {
  const { spawnSync } = require("child_process");
  const result = spawnSync("hyprctl", args, {
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : null;
}

// Hyprland's xwayland:force_zero_scaling hands X clients the panel's raw pixel
// resolution rather than upscaling their surfaces. Chromium then has no scale
// to read — X11 falls back to Xft.dpi, which wlroots sessions do not set — so
// the UI renders at 1x on a fractionally scaled display.
//
// Only compositors we can also ask whether they scale XWayland are probed.
// Handing this flag to one that already upscales (Mutter, KWin) would apply
// the scale twice, so an unrecognised compositor is left alone.
function scalesXWaylandSurfaces(run) {
  const option = run(["getoption", "xwayland:force_zero_scaling"]);
  return typeof option === "string" && /^\s*(?:bool|int):\s*(?:1|true)\s*$/m.test(option);
}

function focusedMonitorScale(run) {
  const monitors = run(["-j", "monitors"]);
  if (typeof monitors !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(monitors);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const monitor = parsed.find((entry) => entry && entry.focused) || parsed[0];
  const scale = Number(monitor && monitor.scale);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

// Returns the device scale factor to hand Chromium, or null to leave it alone.
// `run` is injected by the tests; it takes hyprctl argv and returns stdout.
function resolveXWaylandScale(run = runHyprctl) {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  if (!scalesXWaylandSurfaces(run)) return null;

  const scale = focusedMonitorScale(run);
  // A 1x display needs no flag, and Chromium treats the value as a float, so
  // only a meaningful difference is worth forcing.
  return scale !== null && Math.abs(scale - 1) > 0.01 ? scale : null;
}

// The flags a Wayland session has to add to reach a correctly scaled XWayland
// process. `argv` is the current command line, so an explicit user flag wins.
function xwaylandLaunchFlags(argv, run = runHyprctl) {
  const flags = [XWAYLAND_FLAG];
  if (!shouldResolveScale(argv)) return flags;

  const scale = resolveXWaylandScale(run);
  if (scale !== null) flags.push(`${SCALE_PREFIX}${scale}`);
  return flags;
}

module.exports = {
  OZONE_PLATFORM_PREFIX,
  SCALE_PREFIX,
  XWAYLAND_FLAG,
  shouldForceXWayland,
  shouldResolveScale,
  resolveXWaylandScale,
  xwaylandLaunchFlags,
};
