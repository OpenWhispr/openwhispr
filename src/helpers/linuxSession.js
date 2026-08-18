const WLROOTS_DESKTOPS = ["sway", "hyprland", "wayfire", "river", "dwl", "labwc", "cage"];

function getLinuxSessionInfo() {
  const isWayland =
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!process.env.WAYLAND_DISPLAY;
  const desktopEnv = [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.XDG_SESSION_DESKTOP,
    process.env.DESKTOP_SESSION,
  ]
    .filter(Boolean)
    .join(":")
    .toLowerCase();
  const isWlroots =
    isWayland &&
    (WLROOTS_DESKTOPS.some((desktop) => desktopEnv.includes(desktop)) ||
      !!process.env.SWAYSOCK ||
      !!process.env.HYPRLAND_INSTANCE_SIGNATURE);

  return {
    isWayland,
    xwaylandAvailable: isWayland && !!process.env.DISPLAY,
    desktopEnv,
    isGnome: isWayland && desktopEnv.includes("gnome"),
    isKde: isWayland && desktopEnv.includes("kde"),
    isWlroots,
    isHyprland: isWayland && !!process.env.HYPRLAND_INSTANCE_SIGNATURE,
  };
}

module.exports = { getLinuxSessionInfo };
