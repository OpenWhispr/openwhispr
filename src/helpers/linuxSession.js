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
  const isCosmic = isWayland && desktopEnv.includes("cosmic");
  // SWAYSOCK can survive a compositor switch, so trust it only when no desktop
  // metadata identifies the current session.
  const isSway =
    isWayland &&
    !isGnome &&
    !isKde &&
    !isHyprland &&
    (desktopEnv.includes("sway") || (!desktopEnv && !!environment.SWAYSOCK));
  const isNamedWlroots = WLROOTS_DESKTOPS.some((desktop) => desktopEnv.includes(desktop));
  const isWlroots =
    isWayland &&
    (isNamedWlroots || !!environment.SWAYSOCK || !!environment.HYPRLAND_INSTANCE_SIGNATURE);
  const isNiri = isWayland && desktopEnv.includes("niri");
  // wlroots, Hyprland and niri's xwayland-satellite hand an X11 clipboard write to
  // Wayland apps only while an X11 window has focus (Mutter, COSMIC and KWin 6.0.3+
  // do it themselves, and KDE uses wl-copy when installed without requiring it), so
  // the app's XWayland clipboard reaches a native Wayland app only through wl-copy.
  // A stale SWAYSOCK or Hyprland signature alone doesn't count.
  const requiresWlCopy =
    isWayland && !isGnome && !isKde && !isCosmic && (isNamedWlroots || isSway || isNiri);

  return {
    isWayland,
    xwaylandAvailable: isWayland && !!environment.DISPLAY,
    desktopEnv,
    isGnome,
    isKde,
    isWlroots,
    isHyprland,
    isSway,
    isCosmic,
    requiresWlCopy,
  };
}

module.exports = { getLinuxSessionInfo };
