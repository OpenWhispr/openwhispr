const WLROOTS_DESKTOPS = ["sway", "hyprland", "wayfire", "river", "dwl", "labwc", "cage"];

function getLinuxSessionInfo(environment = process.env) {
  const isWayland =
    (environment.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!environment.WAYLAND_DISPLAY;
  const desktopEnv = [
    environment.XDG_CURRENT_DESKTOP,
    environment.XDG_SESSION_DESKTOP,
    environment.DESKTOP_SESSION,
  ]
    .filter(Boolean)
    .join(":")
    .toLowerCase();
  const isGnome = isWayland && desktopEnv.includes("gnome");
  const isKde = isWayland && desktopEnv.includes("kde");
  const isHyprland = isWayland && !!environment.HYPRLAND_INSTANCE_SIGNATURE;
  // SWAYSOCK can survive a compositor switch, so trust it only when no desktop
  // metadata identifies the current session.
  const isSway =
    isWayland &&
    !isGnome &&
    !isKde &&
    !isHyprland &&
    (desktopEnv.includes("sway") || (!desktopEnv && !!environment.SWAYSOCK));
  const isWlroots =
    isWayland &&
    (WLROOTS_DESKTOPS.some((desktop) => desktopEnv.includes(desktop)) ||
      !!environment.SWAYSOCK ||
      !!environment.HYPRLAND_INSTANCE_SIGNATURE);

  return {
    isWayland,
    xwaylandAvailable: isWayland && !!environment.DISPLAY,
    desktopEnv,
    isGnome,
    isKde,
    isWlroots,
    isHyprland,
    isSway,
  };
}

module.exports = { getLinuxSessionInfo };
