const path = require("path");
const { getLinuxSessionInfo } = require("./linuxSession");
const { ASSISTANT_PANEL_SIZE_LIMITS } = require("./voiceSurfaceGeometry");

const FOCUSLESS_OVERLAY_ROLES = new Set(["main", "notification"]);

function usesGnomeOverlayPolicy(linuxSession) {
  return (
    linuxSession.isWayland &&
    (linuxSession.isGnome || /ubuntu|unity/.test(linuxSession.desktopEnv || ""))
  );
}

function resolveOverlayWindowType({ role, platform, linuxSession }) {
  if (platform === "darwin") return "panel";
  if (platform !== "linux") return "normal";

  // Sway asks wlroots whether an unmanaged XWayland surface wants focus.
  // "toolbar" opts in; "notification" keeps the existing text field focused.
  if (linuxSession.isSway && linuxSession.xwaylandAvailable && FOCUSLESS_OVERLAY_ROLES.has(role)) {
    return "notification";
  }

  if (linuxSession.isKde || (role === "main" && usesGnomeOverlayPolicy(linuxSession))) {
    return "normal";
  }
  return "toolbar";
}

const linuxSession = getLinuxSessionInfo();
const OVERLAY_WINDOW_TYPES = {
  main: resolveOverlayWindowType({ role: "main", platform: process.platform, linuxSession }),
  notification: resolveOverlayWindowType({
    role: "notification",
    platform: process.platform,
    linuxSession,
  }),
};

const ASSISTANT_WINDOW_SIZE = {
  width: ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth + ASSISTANT_PANEL_SIZE_LIMITS.gutter,
  height: ASSISTANT_PANEL_SIZE_LIMITS.ratioHeight + ASSISTANT_PANEL_SIZE_LIMITS.gutter,
};

const DICTATION_ERROR_WINDOW_LIMITS = {
  width: ASSISTANT_WINDOW_SIZE.width,
  gutter: 24,
  minSurfaceHeight: 88,
};

function fitAssistantWindowToWorkArea(requestedSize, workArea) {
  const limits = ASSISTANT_PANEL_SIZE_LIMITS;
  const ratio = limits.ratioWidth / limits.ratioHeight;
  const availableSurfaceWidth = Math.max(1, workArea.width - limits.gutter);
  const availableSurfaceHeight = Math.max(1, workArea.height - limits.gutter);
  const maximumSurfaceWidth = Math.max(
    1,
    Math.min(
      limits.maxSurfaceWidth,
      availableSurfaceWidth,
      Math.floor(availableSurfaceHeight * ratio)
    )
  );
  const minimumSurfaceWidth = Math.min(limits.minSurfaceWidth, maximumSurfaceWidth);
  const requestedSurfaceWidth = Math.round(requestedSize.width - limits.gutter);
  const surfaceWidth = Math.max(
    minimumSurfaceWidth,
    Math.min(maximumSurfaceWidth, requestedSurfaceWidth)
  );
  const surfaceHeight = Math.round(surfaceWidth / ratio);

  return {
    width: surfaceWidth + limits.gutter,
    height: surfaceHeight + limits.gutter,
  };
}

// Shared shape of both content-height fits: clamp a renderer-measured surface
// height between the limits' floor and the caller's ceiling, then add the
// gutter frame back around the surface.
function fitContentWindowToWorkArea(
  limits,
  requestedSurfaceHeight,
  { width, maximumSurfaceHeight }
) {
  const minimumSurfaceHeight = Math.min(limits.minSurfaceHeight, maximumSurfaceHeight);
  const numericHeight = Number(requestedSurfaceHeight);
  const safeHeight = Number.isFinite(numericHeight)
    ? Math.round(numericHeight)
    : minimumSurfaceHeight;
  const surfaceHeight = Math.max(minimumSurfaceHeight, Math.min(safeHeight, maximumSurfaceHeight));

  return {
    width,
    height: surfaceHeight + limits.gutter,
  };
}

function fitAssistantContentWindowToWorkArea(requestedSurfaceHeight, workArea) {
  const limits = ASSISTANT_PANEL_SIZE_LIMITS;
  const maximumWindow = fitAssistantWindowToWorkArea(ASSISTANT_WINDOW_SIZE, workArea);
  return fitContentWindowToWorkArea(limits, requestedSurfaceHeight, {
    width: maximumWindow.width,
    maximumSurfaceHeight: maximumWindow.height - limits.gutter,
  });
}

function fitDictationErrorContentWindowToWorkArea(requestedSurfaceHeight, workArea) {
  const limits = DICTATION_ERROR_WINDOW_LIMITS;
  const fitted = fitContentWindowToWorkArea(limits, requestedSurfaceHeight, {
    width: fitAssistantWindowToWorkArea(ASSISTANT_WINDOW_SIZE, workArea).width,
    maximumSurfaceHeight: Math.max(1, workArea.height - limits.gutter),
  });
  return { ...fitted, height: Math.min(workArea.height, fitted.height) };
}

function fitDictationErrorWindowToWorkArea(requestedSize, workArea) {
  const width = fitAssistantWindowToWorkArea(ASSISTANT_WINDOW_SIZE, workArea).width;
  const numericHeight = Number(requestedSize.height);
  const safeHeight = Number.isFinite(numericHeight) ? Math.round(numericHeight) : 1;

  return {
    width,
    height: Math.max(1, Math.min(safeHeight, workArea.height)),
  };
}

const WINDOW_SIZES = {
  // The pill docks 12px from the window's bottom corner (voice-pill-position
  // classes); the remaining area is click-through headroom so the hover
  // tooltip and the Signal glow's halo render without clipping at the window
  // bounds. Sized with dictation-panel.css's dock insets — change together.
  BASE: { width: 176, height: 120 },
  RECORDING: { width: 208, height: 120 },
  DICTATION_ERROR: { width: DICTATION_ERROR_WINDOW_LIMITS.width, height: 112 },
  DICTATION_ERROR_WITH_TRANSCRIPT: {
    width: DICTATION_ERROR_WINDOW_LIMITS.width,
    height: 168,
  },
  WITH_MENU: { width: 240, height: 280 },
  WITH_TOAST: { width: 400, height: 500 },
  EXPANDED: { width: 400, height: 500 },
  ASSISTANT: ASSISTANT_WINDOW_SIZE,
};

/**
 * Resolve the horizontal voice-animation origin from where the native overlay
 * actually sits. The saved preference is only a fallback for an exact center
 * or unavailable geometry; dragging the pill must be able to override it.
 */
function resolveHorizontalWindowDirection(bounds, display, preferredPosition = "bottom-right") {
  if (preferredPosition === "center") return "right";

  const workArea = display?.workArea || display?.bounds;
  const windowCenter = Number(bounds?.x) + Number(bounds?.width) / 2;
  const displayCenter = Number(workArea?.x) + Number(workArea?.width) / 2;
  if (!Number.isFinite(windowCenter) || !Number.isFinite(displayCenter)) {
    return preferredPosition === "bottom-left" ? "left" : "right";
  }
  if (windowCenter === displayCenter) {
    return preferredPosition === "bottom-left" ? "left" : "right";
  }
  return windowCenter < displayCenter ? "left" : "right";
}

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
    // The hotkey shows this window from hidden right as the entrance animation
    // and resize mask run; a throttled renderer stutters them for seconds.
    backgroundThrottling: false,
  },
  frame: false,
  alwaysOnTop: true,
  resizable: false,
  transparent: true,
  show: false,
  skipTaskbar: true,
  focusable: false,
  visibleOnAllWorkspaces: process.platform !== "win32",
  fullScreenable: false,
  hasShadow: false,
  acceptsFirstMouse: true,
  type: OVERLAY_WINDOW_TYPES.main,
};

// The expanded flow deliberately uses a denser frame than the main control
// panel. Its typography, cards and spacing are sized for this 1000x740 canvas;
// clampedBounds still handles displays whose work area is smaller.
const ONBOARDING_WINDOW_SIZES = {
  COMPACT: { width: 480, height: 624 },
  EXPANDED: { width: 1000, height: 740 },
};

// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: 1200,
  height: 800,
  // macOS: fully transparent, so nothing paints into the compact onboarding
  // frame's rounded corners. Windows/Linux keep an opaque backing (the renderer
  // paints its own background on top) — see the transparent flag below.
  backgroundColor: process.platform === "darwin" ? "#00000000" : "#1c1c2e",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    // sandbox: false is required because the preload script bridges IPC
    // between the renderer and main process.
    sandbox: false,
    // webSecurity: false disables same-origin policy. Required because in
    // production the renderer loads from a file:// origin but makes
    // cross-origin fetch calls to Better Auth, Gemini, OpenAI, and Groq APIs
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
  // macOS only: transparent so a renderer that insets or rounds itself shows
  // the desktop rather than a square page backing bleeding out behind it. Safe
  // for the other control panel screens because each paints its own opaque
  // background (ControlPanel's root is `bg-background`); only the compact
  // onboarding steps clear body/#root — see index.css. Not on Windows/Linux:
  // transparency is creation-time-only and this window outlives onboarding, and
  // on Windows `transparent` forces thickFrame:false (no maximize/Aero-snap)
  // and renders black when compositing is off. The compact onboarding frame
  // falls back to square corners there by design.
  transparent: process.platform === "darwin",
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
  acceptFirstMouse: true,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  visibleOnAllWorkspaces: process.platform !== "win32",
  type: OVERLAY_WINDOW_TYPES.notification,
};

const AUTO_END_NOTIFICATION_WINDOW_SIZE = {
  width: 480,
  height: 128,
};

function getMeetingNotificationWindowSize(promptData) {
  if (promptData?.kind === "auto-end") {
    return AUTO_END_NOTIFICATION_WINDOW_SIZE;
  }
  return {
    width: NOTIFICATION_WINDOW_CONFIG.width,
    height: NOTIFICATION_WINDOW_CONFIG.height,
  };
}

class WindowPositionUtil {
  static getMainWindowPosition(display, customSize = null, position = "bottom-right") {
    const { width, height } = customSize || WINDOW_SIZES.BASE;
    const MARGIN = 4;
    const workArea = display.workArea || display.bounds;

    let x, y;
    if (position === "bottom-left") {
      x = workArea.x + MARGIN;
      y = workArea.y + workArea.height - height - MARGIN;
    } else if (position === "center") {
      x = Math.round(workArea.x + (workArea.width - width) / 2);
      y = workArea.y + workArea.height - height - MARGIN;
    } else {
      // bottom-right (default)
      x = workArea.x + workArea.width - width - MARGIN;
      y = workArea.y + workArea.height - height - MARGIN;
    }

    // Clamped to the display's own work area, never to zero: a monitor placed
    // above or left of the primary one has a negative origin, so flooring at zero
    // lands the window on a coordinate that display doesn't cover.
    return {
      ...WindowPositionUtil.clampToWorkArea({ x, y, width, height }, display),
      width,
      height,
    };
  }

  // Keeps a window's whole frame inside one display's work area. Displays of
  // different sizes leave dead space beside the smaller one, and a window parked
  // there is invisible even though the window server still reports it on screen.
  static clampToWorkArea(bounds, display) {
    const workArea = display.workArea || display.bounds;
    return {
      x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
      y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height)),
    };
  }

  static getNotificationPosition(display, customSize = null) {
    const { width, height } = customSize || NOTIFICATION_WINDOW_CONFIG;
    const MARGIN = 16;
    const workArea = display.workArea || display.bounds;
    // Same negative-origin trap as getMainWindowPosition: clamp to the display,
    // not to zero, or a monitor above the primary one puts the prompt nowhere.
    const bounds = {
      x: workArea.x + workArea.width - width - MARGIN,
      y: workArea.y + MARGIN,
      width,
      height,
    };
    return { ...WindowPositionUtil.clampToWorkArea(bounds, display), width, height };
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
    } else if (usesGnomeOverlayPolicy(linuxSession)) {
      window.setAlwaysOnTop(true, "floating");
    } else {
      // KDE XWayland and other Linux — "screen-saver" is the strongest z-level
      window.setAlwaysOnTop(true, "screen-saver");
    }
  }
}

module.exports = {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  ONBOARDING_WINDOW_SIZES,
  NOTIFICATION_WINDOW_CONFIG,
  ASSISTANT_PANEL_SIZE_LIMITS,
  fitAssistantContentWindowToWorkArea,
  fitAssistantWindowToWorkArea,
  fitDictationErrorContentWindowToWorkArea,
  fitDictationErrorWindowToWorkArea,
  resolveHorizontalWindowDirection,
  AUTO_END_NOTIFICATION_WINDOW_SIZE,
  getMeetingNotificationWindowSize,
  WINDOW_SIZES,
  WindowPositionUtil,
  resolveOverlayWindowType,
};
