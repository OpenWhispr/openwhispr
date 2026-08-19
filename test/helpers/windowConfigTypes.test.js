const test = require("node:test");
const assert = require("node:assert/strict");

const WINDOW_CONFIG_PATH = require.resolve("../../src/helpers/windowConfig.js");
const { resolveOverlayWindowType } = require(WINDOW_CONFIG_PATH);

const SESSION_ENV_KEYS = [
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "SWAYSOCK",
  "HYPRLAND_INSTANCE_SIGNATURE",
];

function setEnvironmentValue(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function loadWindowConfig({ platform, environment }) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalEnvironment = Object.fromEntries(
    SESSION_ENV_KEYS.map((key) => [key, process.env[key]])
  );

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const key of SESSION_ENV_KEYS) setEnvironmentValue(key, environment[key]);
  delete require.cache[WINDOW_CONFIG_PATH];

  try {
    return require(WINDOW_CONFIG_PATH);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const key of SESSION_ENV_KEYS) setEnvironmentValue(key, originalEnvironment[key]);
    delete require.cache[WINDOW_CONFIG_PATH];
  }
}

const OVERLAY_ROLES = ["main", "notification", "transcription-preview", "agent"];

function resolveAllOverlayTypes(platform, session) {
  return Object.fromEntries(
    OVERLAY_ROLES.map((role) => [
      role,
      resolveOverlayWindowType({ role, platform, linuxSession: session }),
    ])
  );
}

test("Sway XWayland uses notification type only for focusless overlays", () => {
  const windowConfig = loadWindowConfig({
    platform: "linux",
    environment: {
      XDG_SESSION_TYPE: "wayland",
      XDG_CURRENT_DESKTOP: "sway",
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0",
    },
  });

  assert.deepEqual(
    {
      main: windowConfig.MAIN_WINDOW_CONFIG.type,
      notification: windowConfig.NOTIFICATION_WINDOW_CONFIG.type,
      transcriptionPreview: windowConfig.TRANSCRIPTION_PREVIEW_CONFIG.type,
      agent: windowConfig.AGENT_OVERLAY_CONFIG.type,
    },
    {
      main: "notification",
      notification: "notification",
      transcriptionPreview: "notification",
      agent: "toolbar",
    }
  );
  assert.equal(windowConfig.MAIN_WINDOW_CONFIG.focusable, false);
  assert.equal(windowConfig.NOTIFICATION_WINDOW_CONFIG.focusable, false);
  assert.equal(windowConfig.TRANSCRIPTION_PREVIEW_CONFIG.focusable, false);
  assert.equal(windowConfig.AGENT_OVERLAY_CONFIG.focusable, true);
});

test("the overlay resolver preserves every unaffected platform and session", () => {
  const cases = [
    {
      name: "Sway without XWayland",
      platform: "linux",
      session: { isSway: true, xwaylandAvailable: false, isGnome: false, isKde: false },
      expected: {
        main: "toolbar",
        notification: "toolbar",
        "transcription-preview": "toolbar",
        agent: "toolbar",
      },
    },
    {
      name: "Hyprland",
      platform: "linux",
      session: { isSway: false, xwaylandAvailable: true, isGnome: false, isKde: false },
      expected: {
        main: "toolbar",
        notification: "toolbar",
        "transcription-preview": "toolbar",
        agent: "toolbar",
      },
    },
    {
      name: "GNOME Wayland",
      platform: "linux",
      session: {
        isWayland: true,
        isSway: false,
        xwaylandAvailable: true,
        desktopEnv: "gnome",
        isGnome: true,
        isKde: false,
      },
      expected: {
        main: "normal",
        notification: "toolbar",
        "transcription-preview": "toolbar",
        agent: "toolbar",
      },
    },
    {
      name: "Ubuntu Unity Wayland",
      platform: "linux",
      session: {
        isWayland: true,
        isSway: false,
        xwaylandAvailable: true,
        desktopEnv: "ubuntu:unity",
        isGnome: false,
        isKde: false,
      },
      expected: {
        main: "normal",
        notification: "toolbar",
        "transcription-preview": "toolbar",
        agent: "toolbar",
      },
    },
    {
      name: "Ubuntu Unity X11",
      platform: "linux",
      session: {
        isWayland: false,
        isSway: false,
        xwaylandAvailable: false,
        desktopEnv: "ubuntu:unity",
        isGnome: false,
        isKde: false,
      },
      expected: {
        main: "toolbar",
        notification: "toolbar",
        "transcription-preview": "toolbar",
        agent: "toolbar",
      },
    },
    {
      name: "KDE Wayland",
      platform: "linux",
      session: { isSway: false, xwaylandAvailable: true, isGnome: false, isKde: true },
      expected: {
        main: "normal",
        notification: "normal",
        "transcription-preview": "normal",
        agent: "normal",
      },
    },
    {
      name: "i3 X11",
      platform: "linux",
      session: { isSway: false, xwaylandAvailable: false, isGnome: false, isKde: false },
      expected: {
        main: "toolbar",
        notification: "toolbar",
        "transcription-preview": "toolbar",
        agent: "toolbar",
      },
    },
    {
      name: "macOS",
      platform: "darwin",
      session: {},
      expected: {
        main: "panel",
        notification: "panel",
        "transcription-preview": "panel",
        agent: "panel",
      },
    },
    {
      name: "Windows",
      platform: "win32",
      session: {},
      expected: {
        main: "normal",
        notification: "normal",
        "transcription-preview": "normal",
        agent: "normal",
      },
    },
  ];

  for (const { name, platform, session, expected } of cases) {
    assert.deepEqual(resolveAllOverlayTypes(platform, session), expected, name);
  }
});

test("a stale SWAYSOCK does not change Hyprland window types", () => {
  const windowConfig = loadWindowConfig({
    platform: "linux",
    environment: {
      XDG_SESSION_TYPE: "wayland",
      XDG_CURRENT_DESKTOP: "Hyprland",
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0",
      SWAYSOCK: "/run/user/1000/stale-sway.sock",
      HYPRLAND_INSTANCE_SIGNATURE: "hyprland-instance",
    },
  });

  assert.deepEqual(
    {
      main: windowConfig.MAIN_WINDOW_CONFIG.type,
      notification: windowConfig.NOTIFICATION_WINDOW_CONFIG.type,
      transcriptionPreview: windowConfig.TRANSCRIPTION_PREVIEW_CONFIG.type,
      agent: windowConfig.AGENT_OVERLAY_CONFIG.type,
    },
    {
      main: "toolbar",
      notification: "toolbar",
      transcriptionPreview: "toolbar",
      agent: "toolbar",
    }
  );
});
