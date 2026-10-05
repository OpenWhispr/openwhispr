const test = require("node:test");
const assert = require("node:assert/strict");

const { XWAYLAND_FLAG, shouldForceXWayland } = require("../../src/helpers/xwayland.js");

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function withSession({ platform, sessionType, desktop }, run) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalSessionType = process.env.XDG_SESSION_TYPE;
  const originalDesktop = process.env.XDG_CURRENT_DESKTOP;

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  setEnv("XDG_SESSION_TYPE", sessionType);
  setEnv("XDG_CURRENT_DESKTOP", desktop);

  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    setEnv("XDG_SESSION_TYPE", originalSessionType);
    setEnv("XDG_CURRENT_DESKTOP", originalDesktop);
  }
}

const WAYLAND_DESKTOPS = ["Hyprland", "KDE", "GNOME", "sway", "niri", ""];

test("forces XWayland on every Wayland compositor", () => {
  for (const desktop of WAYLAND_DESKTOPS) {
    withSession({ platform: "linux", sessionType: "wayland", desktop }, () => {
      assert.equal(shouldForceXWayland(["--dev"]), true, `expected XWayland for ${desktop || "?"}`);
    });
  }
});

test("leaves X11 sessions and non-Linux platforms alone", () => {
  withSession({ platform: "linux", sessionType: "x11", desktop: "GNOME" }, () => {
    assert.equal(shouldForceXWayland(["--dev"]), false);
  });
  withSession({ platform: "darwin", sessionType: undefined, desktop: undefined }, () => {
    assert.equal(shouldForceXWayland(["--dev"]), false);
  });
});

test("an explicit --ozone-platform flag wins", () => {
  withSession({ platform: "linux", sessionType: "wayland", desktop: "Hyprland" }, () => {
    assert.equal(shouldForceXWayland(["--ozone-platform=wayland"]), false);
    assert.equal(shouldForceXWayland([XWAYLAND_FLAG]), false);
  });
});
