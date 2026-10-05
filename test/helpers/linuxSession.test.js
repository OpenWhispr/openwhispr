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
