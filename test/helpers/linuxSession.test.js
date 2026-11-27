const test = require("node:test");
const assert = require("node:assert/strict");

const { getLinuxSessionInfo } = require("../../src/helpers/linuxSession.js");

test("detects Sway XWayland from desktop metadata", () => {
  const session = getLinuxSessionInfo({
    XDG_SESSION_TYPE: "wayland",
    XDG_CURRENT_DESKTOP: "sway",
    WAYLAND_DISPLAY: "wayland-1",
    DISPLAY: ":0",
  });

  assert.equal(session.isSway, true);
  assert.equal(session.xwaylandAvailable, true);
});

test("detects a TTY-launched Sway XWayland session from its sockets", () => {
  const session = getLinuxSessionInfo({
    XDG_SESSION_TYPE: "tty",
    WAYLAND_DISPLAY: "wayland-1",
    DISPLAY: ":0",
    SWAYSOCK: "/run/user/1000/sway-ipc.sock",
  });

  assert.equal(session.isWayland, true);
  assert.equal(session.isSway, true);
  assert.equal(session.xwaylandAvailable, true);
});

test("does not let a stale SWAYSOCK override a named compositor", () => {
  const sessions = [
    {
      name: "Hyprland",
      environment: {
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: "Hyprland",
        WAYLAND_DISPLAY: "wayland-1",
        DISPLAY: ":0",
        SWAYSOCK: "/run/user/1000/stale-sway.sock",
        HYPRLAND_INSTANCE_SIGNATURE: "hyprland-instance",
      },
      expectedFlag: "isHyprland",
    },
    {
      name: "GNOME",
      environment: {
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: "GNOME",
        WAYLAND_DISPLAY: "wayland-1",
        DISPLAY: ":0",
        SWAYSOCK: "/run/user/1000/stale-sway.sock",
      },
      expectedFlag: "isGnome",
    },
    {
      name: "KDE",
      environment: {
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: "KDE",
        WAYLAND_DISPLAY: "wayland-1",
        DISPLAY: ":0",
        SWAYSOCK: "/run/user/1000/stale-sway.sock",
      },
      expectedFlag: "isKde",
    },
  ];

  for (const { name, environment, expectedFlag } of sessions) {
    const session = getLinuxSessionInfo(environment);

    assert.equal(session.isSway, false, name);
    assert.equal(session[expectedFlag], true, name);
  }
});

test("detects COSMIC without treating it as wlroots", () => {
  const session = getLinuxSessionInfo({
    XDG_SESSION_TYPE: "wayland",
    XDG_CURRENT_DESKTOP: "COSMIC",
    WAYLAND_DISPLAY: "wayland-1",
    DISPLAY: ":0",
  });

  assert.equal(session.isCosmic, true);
  assert.equal(session.isWlroots, false);
});

// wlroots, Hyprland and niri's xwayland-satellite keep an X11 clipboard write from a
// focused Wayland app (#2621); KWin, Mutter and COSMIC hand it over themselves.
test("requires wl-copy only where XWayland's clipboard needs X11 focus", () => {
  const sessions = [
    ["niri", { XDG_CURRENT_DESKTOP: "niri" }, true],
    ["sway", { XDG_CURRENT_DESKTOP: "sway" }, true],
    ["Hyprland", { XDG_CURRENT_DESKTOP: "Hyprland", HYPRLAND_INSTANCE_SIGNATURE: "x" }, true],
    ["GNOME", { XDG_CURRENT_DESKTOP: "GNOME" }, false],
    ["KDE", { XDG_CURRENT_DESKTOP: "KDE" }, false],
    ["COSMIC", { XDG_CURRENT_DESKTOP: "COSMIC" }, false],
    [
      "GNOME with a stale SWAYSOCK",
      { XDG_CURRENT_DESKTOP: "GNOME", SWAYSOCK: "/run/user/1000/stale-sway.sock" },
      false,
    ],
    [
      "Cinnamon with a stale SWAYSOCK and Hyprland signature",
      {
        XDG_CURRENT_DESKTOP: "X-Cinnamon",
        SWAYSOCK: "/run/user/1000/stale-sway.sock",
        HYPRLAND_INSTANCE_SIGNATURE: "stale",
      },
      false,
    ],
    ["a bare sway socket", { SWAYSOCK: "/run/user/1000/sway-ipc.sock" }, true],
    [
      "X11",
      { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined, XDG_CURRENT_DESKTOP: "i3" },
      false,
    ],
  ];

  for (const [name, environment, requiresWlCopy] of sessions) {
    const session = getLinuxSessionInfo({
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0",
      ...environment,
    });

    assert.equal(session.requiresWlCopy, requiresWlCopy, name);
  }
});
