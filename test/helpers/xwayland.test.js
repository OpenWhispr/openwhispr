const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SCALE_PREFIX,
  XWAYLAND_FLAG,
  resolveXWaylandScale,
  shouldForceXWayland,
  xwaylandLaunchFlags,
} = require("../../src/helpers/xwayland.js");

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

function withHyprland(signature, run) {
  const original = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  setEnv("HYPRLAND_INSTANCE_SIGNATURE", signature);
  try {
    run();
  } finally {
    setEnv("HYPRLAND_INSTANCE_SIGNATURE", original);
  }
}

// Stubs hyprctl: `zeroScaling` is the getoption reply, `monitors` the -j reply.
function fakeHyprctl({ zeroScaling = "bool: true\nset: true", monitors = [] } = {}) {
  return (args) => {
    if (args[0] === "getoption") return zeroScaling;
    if (args[0] === "-j" && args[1] === "monitors") {
      return typeof monitors === "string" ? monitors : JSON.stringify(monitors);
    }
    return null;
  };
}

const SCALED_MONITORS = [
  { name: "DP-1", scale: 1, focused: false },
  { name: "eDP-1", scale: 1.6, focused: true },
];

test("reads the focused monitor's scale when the compositor does not scale XWayland", () => {
  withHyprland("sig", () => {
    const scale = resolveXWaylandScale(fakeHyprctl({ monitors: SCALED_MONITORS }));
    assert.equal(scale, 1.6);
  });
});

test("leaves a compositor that upscales XWayland alone", () => {
  withHyprland("sig", () => {
    const run = fakeHyprctl({ zeroScaling: "bool: false\nset: false", monitors: SCALED_MONITORS });
    assert.equal(resolveXWaylandScale(run), null);
  });
});

test("does not probe a compositor it cannot ask about XWayland scaling", () => {
  withHyprland(undefined, () => {
    assert.equal(resolveXWaylandScale(fakeHyprctl({ monitors: SCALED_MONITORS })), null);
  });
});

test("an unscaled display needs no flag", () => {
  withHyprland("sig", () => {
    const run = fakeHyprctl({ monitors: [{ name: "DP-1", scale: 1, focused: true }] });
    assert.equal(resolveXWaylandScale(run), null);
  });
});

test("falls back to the first monitor when none is focused", () => {
  withHyprland("sig", () => {
    const run = fakeHyprctl({ monitors: [{ name: "DP-1", scale: 1.25, focused: false }] });
    assert.equal(resolveXWaylandScale(run), 1.25);
  });
});

test("unreadable hyprctl output is not guessed at", () => {
  withHyprland("sig", () => {
    assert.equal(resolveXWaylandScale(fakeHyprctl({ monitors: "not json" })), null);
    assert.equal(resolveXWaylandScale(fakeHyprctl({ monitors: [] })), null);
    assert.equal(
      resolveXWaylandScale(() => null),
      null
    );
  });
});

test("launch flags carry the scale alongside the XWayland flag", () => {
  withHyprland("sig", () => {
    const flags = xwaylandLaunchFlags([], fakeHyprctl({ monitors: SCALED_MONITORS }));
    assert.deepEqual(flags, [XWAYLAND_FLAG, `${SCALE_PREFIX}1.6`]);
  });
});

test("an explicit --force-device-scale-factor wins", () => {
  withHyprland("sig", () => {
    const run = fakeHyprctl({ monitors: SCALED_MONITORS });
    const flags = xwaylandLaunchFlags([`${SCALE_PREFIX}2`], run);
    assert.deepEqual(flags, [XWAYLAND_FLAG]);
  });
});
