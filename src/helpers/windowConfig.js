const path = require("path");

const isGnomeWayland =
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland" &&
  /gnome|ubuntu|unity/i.test(process.env.XDG_CURRENT_DESKTOP || "");

const isKDEWayland =
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland" &&
  /kde/i.test(process.env.XDG_CURRENT_DESKTOP || "");

const MAIN_OVERLAY_TYPE =
  process.platform === "darwin"
    ? "panel"
    : process.platform === "linux"
      ? isGnomeWayland || isKDEWayland
        ? "normal"
        : "toolbar"
      : "normal";

const FLOATING_OVERLAY_TYPE =
  process.platform === "darwin"
    ? "panel"
    : process.platform === "linux"
      ? isKDEWayland
        ? "normal"
        : "toolbar"
      : "normal";

const WINDOW_SIZES = {
  BASE: { width: 96, height: 96 },
  WITH_MENU: { width: 240, height: 280 },
  WITH_TOAST: { width: 400, height: 500 },
  EXPANDED: { width: 400, height: 500 },
};

// Main dictation window configuration
const MAIN_WINDOW_CONFIG = {
  width: WINDOW_SIZES.BASE.width,
  height: WINDOW_SIZES.BASE.height,
  title: "Voice Recorder",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  frame: false,
  alwaysOnTop: true,
  resizable: false,
  transparent: true,
  show: false,
  skipTaskbar: true,
  focusable: true,
  visibleOnAllWorkspaces: process.platform !== "win32",
  fullScreenable: false,
  hasShadow: false,
  acceptsFirstMouse: true,
  type: MAIN_OVERLAY_TYPE,
};

// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: 1200,
  height: 800,
  backgroundColor: "#1c1c2e",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    // sandbox: false is required because the preload script bridges IPC
    // between the renderer and main process.
    sandbox: false,
    // webSecurity: false disables same-origin policy. Required because in
    // production the renderer loads from a file:// origin but makes
    // cross-origin fetch calls to Neon Auth, Gemini, OpenAI, and Groq APIs
    // directly from the browser. These would be blocked by CORS otherwise.
    webSecurity: false,
    spellcheck: false,
    backgroundThrottling: false,
  },
  title: "Control Panel",
  resizable: true,
  show: false,
  frame: false,
  ...(process.platform === "darwin" && {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
  }),
  transparent: false,
  minimizable: true,
  maximizable: true,
  closable: true,
  fullscreenable: true,
  skipTaskbar: false,
  alwaysOnTop: false,
  visibleOnAllWorkspaces: false,
  type: "normal",
};

const NOTIFICATION_WINDOW_CONFIG = {
  width: 392,
  height: 92,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  focusable: false,
  hasShadow: false,
  show: false,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  visibleOnAllWorkspaces: process.platform !== "win32",
  type: FLOATING_OVERLAY_TYPE,
};

const TRANSCRIPTION_PREVIEW_SIZE_LIMITS = {
  minWidth: 400,
  defaultWidth: 460,
  maxWidth: 640,
  minHeight: 96,
  defaultHeight: 132,
  maxHeight: 520,
};

const TRANSCRIPTION_PREVIEW_CONFIG = {
  width: TRANSCRIPTION_PREVIEW_SIZE_LIMITS.defaultWidth,
  height: TRANSCRIPTION_PREVIEW_SIZE_LIMITS.defaultHeight,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  focusable: false,
  hasShadow: false,
  show: false,
  acceptsFirstMouse: true,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  visibleOnAllWorkspaces: process.platform !== "win32",
  type: FLOATING_OVERLAY_TYPE,
};

class WindowPositionUtil {
  static getMainWindowPosition(display, customSize = null, position = "bottom-right") {
    const { width, height } = customSize || WINDOW_SIZES.BASE;
    const MARGIN = 4;
    const workArea = display.workArea || display.bounds;

    let x, y;
    if (position === "bottom-left") {
      x = workArea.x + MARGIN;
      y = Math.max(0, workArea.y + workArea.height - height - MARGIN);
    } else if (position === "center") {
      x = Math.round(workArea.x + (workArea.width - width) / 2);
      y = Math.max(0, workArea.y + workArea.height - height - MARGIN);
    } else {
      // bottom-right (default)
      x = Math.max(0, workArea.x + workArea.width - width - MARGIN);
      y = Math.max(0, workArea.y + workArea.height - height - MARGIN);
    }

    return { x, y, width, height };
  }

  static getNotificationPosition(display) {
    const { width, height } = NOTIFICATION_WINDOW_CONFIG;
    const MARGIN = 16;
    const workArea = display.workArea || display.bounds;
    const x = Math.max(0, workArea.x + workArea.width - width - MARGIN);
    const y = Math.max(0, workArea.y + MARGIN);
    return { x, y, width, height };
  }

  static getTranscriptionPreviewPosition(display, mainWindowBounds, size = {}) {
    const width =
      size.width ||
      TRANSCRIPTION_PREVIEW_CONFIG.width ||
      TRANSCRIPTION_PREVIEW_SIZE_LIMITS.defaultWidth;
    const height =
      size.height ||
      TRANSCRIPTION_PREVIEW_CONFIG.height ||
      TRANSCRIPTION_PREVIEW_SIZE_LIMITS.defaultHeight;
    const GAP = 8;
    const workArea = display.workArea || display.bounds;

    let x = Math.round(mainWindowBounds.x + (mainWindowBounds.width - width) / 2);
    let y = mainWindowBounds.y - height - GAP;

    x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
    y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));

    return { x, y, width, height };
  }

  static setupAlwaysOnTop(window) {
    if (process.platform === "darwin") {
      // macOS: Use panel level for proper floating behavior
      // This ensures the window stays on top across spaces and fullscreen apps
      window.setAlwaysOnTop(true, "floating", 1);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true, // Keep Dock/Command-Tab behaviour
      });
      window.setFullScreenable(false);

      if (window.isVisible()) {
        window.setAlwaysOnTop(true, "floating", 1);
      }
    } else if (process.platform === "win32") {
      window.setAlwaysOnTop(true, "pop-up-menu");
    } else if (isGnomeWayland) {
      window.setAlwaysOnTop(true, "floating");
    } else {
      // KDE XWayland and other Linux — "screen-saver" is the strongest z-level
      window.setAlwaysOnTop(true, "screen-saver");
    }
  }
}

const AGENT_OVERLAY_CONFIG = {
  width: 420,
  height: 300,
  minWidth: 360,
  minHeight: 200,
  maxWidth: 800,
  maxHeight: 10000,
  frame: false,
  alwaysOnTop: true,
  transparent: true,
  show: false,
  skipTaskbar: true,
  hasShadow: false,
  focusable: true,
  resizable: false,
  fullScreenable: false,
  acceptsFirstMouse: true,
  type: FLOATING_OVERLAY_TYPE,
  visibleOnAllWorkspaces: process.platform !== "win32",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    webSecurity: false,
    spellcheck: false,
    backgroundThrottling: false,
  },
};

module.exports = {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  AGENT_OVERLAY_CONFIG,
  NOTIFICATION_WINDOW_CONFIG,
  TRANSCRIPTION_PREVIEW_CONFIG,
  TRANSCRIPTION_PREVIEW_SIZE_LIMITS,
  WINDOW_SIZES,
  WindowPositionUtil,
};
