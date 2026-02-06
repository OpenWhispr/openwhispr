const { app, globalShortcut, BrowserWindow, dialog, ipcMain, session } = require("electron");
const path = require("path");
const http = require("http");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const VALID_CHANNELS = new Set(["development", "staging", "production"]);
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "openwhispr-dev",
  staging: "openwhispr-staging",
  production: "openwhispr",
};
const BASE_WINDOWS_APP_ID = "com.herotools.openwispr";
const DEFAULT_AUTH_BRIDGE_PORT = 5199;

function isElectronBinaryExec() {
  const execPath = (process.execPath || "").toLowerCase();
  return (
    execPath.includes("/electron.app/contents/macos/electron") ||
    execPath.endsWith("/electron") ||
    execPath.endsWith("\\electron.exe")
  );
}

function inferDefaultChannel() {
  if (process.env.NODE_ENV === "development" || process.defaultApp || isElectronBinaryExec()) {
    return "development";
  }
  return "production";
}

function resolveAppChannel() {
  const rawChannel = (process.env.OPENWHISPR_CHANNEL || process.env.VITE_OPENWHISPR_CHANNEL || "")
    .trim()
    .toLowerCase();

  if (VALID_CHANNELS.has(rawChannel)) {
    return rawChannel;
  }

  return inferDefaultChannel();
}

const APP_CHANNEL = resolveAppChannel();
process.env.OPENWHISPR_CHANNEL = APP_CHANNEL;

function configureChannelUserDataPath() {
  if (APP_CHANNEL === "production") {
    return;
  }

  const isolatedPath = path.join(app.getPath("appData"), `OpenWhispr-${APP_CHANNEL}`);
  app.setPath("userData", isolatedPath);
}

configureChannelUserDataPath();

// Fix transparent window flickering on Linux: --enable-transparent-visuals requires
// the compositor to set up an ARGB visual before any windows are created.
// --disable-gpu-compositing prevents GPU compositing conflicts with the compositor.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Enable native Wayland support: Ozone platform for native rendering,
// and GlobalShortcutsPortal for global shortcuts via xdg-desktop-portal
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform,WaylandWindowDecorations,GlobalShortcutsPortal");
}

// Group all windows under single taskbar entry on Windows
if (process.platform === "win32") {
  const windowsAppId =
    APP_CHANNEL === "production"
      ? BASE_WINDOWS_APP_ID
      : `${BASE_WINDOWS_APP_ID}.${APP_CHANNEL}`;
  app.setAppUserModelId(windowsAppId);
}

function getOAuthProtocol() {
  const fromEnv = (process.env.VITE_OPENWHISPR_PROTOCOL || process.env.OPENWHISPR_PROTOCOL || "")
    .trim()
    .toLowerCase();

  if (/^[a-z][a-z0-9+.-]*$/.test(fromEnv)) {
    return fromEnv;
  }

  return DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[APP_CHANNEL] || DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production;
}

const OAUTH_PROTOCOL = getOAuthProtocol();

function shouldRegisterProtocolWithAppArg() {
  return Boolean(process.defaultApp) || isElectronBinaryExec();
}

// Register custom protocol for OAuth callbacks.
// In development, always include the app path argument so macOS/Windows/Linux
// can launch the project app instead of opening bare Electron.
function registerOpenWhisprProtocol() {
  const protocol = OAUTH_PROTOCOL;

  if (shouldRegisterProtocolWithAppArg()) {
    const appArg = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(".");
    return app.setAsDefaultProtocolClient(protocol, process.execPath, [appArg]);
  }

  return app.setAsDefaultProtocolClient(protocol);
}

const protocolRegistered = registerOpenWhisprProtocol();
if (!protocolRegistered) {
  console.warn(`[Auth] Failed to register ${OAUTH_PROTOCOL}:// protocol handler`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

const isLiveWindow = (window) => window && !window.isDestroyed();

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== "OpenWhispr") {
  app.setName("OpenWhispr");
}

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process for EPIPE errors as they're harmless
  if (error.code === "EPIPE") {
    return;
  }
  // For other errors, log and continue
  console.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Import helper module classes (but don't instantiate yet - wait for app.whenReady())
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const ClipboardManager = require("./src/helpers/clipboard");
const WhisperManager = require("./src/helpers/whisper");
const ParakeetManager = require("./src/helpers/parakeet");
const TrayManager = require("./src/helpers/tray");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const UpdateManager = require("./src/updater");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");
const DevServerManager = require("./src/helpers/devServerManager");
const WindowsKeyManager = require("./src/helpers/windowsKeyManager");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let hotkeyManager = null;
let databaseManager = null;
let clipboardManager = null;
let whisperManager = null;
let parakeetManager = null;
let trayManager = null;
let updateManager = null;
let globeKeyManager = null;
let windowsKeyManager = null;
let globeKeyAlertShown = false;
let authBridgeServer = null;

function parseAuthBridgePort() {
  const raw = (process.env.OPENWHISPR_AUTH_BRIDGE_PORT || "").trim();
  if (!raw) return DEFAULT_AUTH_BRIDGE_PORT;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_AUTH_BRIDGE_PORT;
  }

  return parsed;
}

const AUTH_BRIDGE_HOST = "127.0.0.1";
const AUTH_BRIDGE_PORT = parseAuthBridgePort();
const AUTH_BRIDGE_PATH = "/oauth/callback";

// Set up PATH for production builds to find system tools (whisper.cpp, ffmpeg)
function setupProductionPath() {
  if (process.platform === "darwin" && process.env.NODE_ENV !== "development") {
    const commonPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];

    const currentPath = process.env.PATH || "";
    const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

    if (pathsToAdd.length > 0) {
      process.env.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
    }
  }
}

// Initialize all managers - called after app.whenReady()
function initializeManagers() {
  // Set up PATH before initializing managers
  setupProductionPath();

  // Now it's safe to call app.getPath() and initialize managers
  debugLogger = require("./src/helpers/debugLogger");
  // Ensure file logging is initialized now that app is ready
  debugLogger.ensureFileLogging();

  environmentManager = new EnvironmentManager();
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  hotkeyManager = windowManager.hotkeyManager;
  databaseManager = new DatabaseManager();
  clipboardManager = new ClipboardManager();
  clipboardManager.preWarmAccessibility();
  whisperManager = new WhisperManager();
  parakeetManager = new ParakeetManager();
  trayManager = new TrayManager();
  updateManager = new UpdateManager();
  globeKeyManager = new GlobeKeyManager();
  windowsKeyManager = new WindowsKeyManager();

  // Set up Globe key error handler on macOS
  if (process.platform === "darwin") {
    globeKeyManager.on("error", (error) => {
      if (globeKeyAlertShown) {
        return;
      }
      globeKeyAlertShown = true;

      const detailLines = [
        error?.message || "Unknown error occurred while starting the Globe listener.",
        "The Globe key shortcut will remain disabled; existing keyboard shortcuts continue to work.",
      ];

      if (process.env.NODE_ENV === "development") {
        detailLines.push(
          "Run `npm run compile:globe` and rebuild the app to regenerate the listener binary."
        );
      } else {
        detailLines.push("Try reinstalling OpenWhispr or contact support if the issue persists.");
      }

      dialog.showMessageBox({
        type: "warning",
        title: "Globe Hotkey Unavailable",
        message: "OpenWhispr could not activate the Globe key hotkey.",
        detail: detailLines.join("\n\n"),
      });
    });
  }

  // Initialize IPC handlers with all managers
  const _ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    whisperManager,
    parakeetManager,
    windowManager,
    updateManager,
    windowsKeyManager,
  });
}

// Handle the protocol on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith(`${OAUTH_PROTOCOL}://`)) {
    handleOAuthDeepLink(url);
  }
});

// Extract the session verifier from the deep link and navigate the control
// panel to its app URL with the verifier param so the Neon Auth SDK can
// read it from window.location.search and complete authentication.
function navigateControlPanelWithVerifier(verifier) {
  if (!verifier) return;
  if (!isLiveWindow(windowManager?.controlPanelWindow)) return;

  const appUrl = DevServerManager.getAppUrl(true);
  if (!appUrl) return;

  const separator = appUrl.includes('?') ? '&' : '?';
  const urlWithVerifier = `${appUrl}${separator}neon_auth_session_verifier=${encodeURIComponent(verifier)}`;
  if (debugLogger) {
    debugLogger.debug("Navigating control panel with OAuth verifier", {
      appChannel: APP_CHANNEL,
      oauthProtocol: OAUTH_PROTOCOL,
      devServerUrl: appUrl,
      authBridgeUrl: `http://${AUTH_BRIDGE_HOST}:${AUTH_BRIDGE_PORT}${AUTH_BRIDGE_PATH}`,
    });
  }
  windowManager.controlPanelWindow.loadURL(urlWithVerifier);
  windowManager.controlPanelWindow.show();
  windowManager.controlPanelWindow.focus();
}

function handleOAuthDeepLink(deepLinkUrl) {
  try {
    const parsed = new URL(deepLinkUrl);
    const verifier = parsed.searchParams.get('neon_auth_session_verifier');
    if (!verifier) return;
    navigateControlPanelWithVerifier(verifier);
  } catch (err) {
    if (debugLogger) debugLogger.error('Failed to handle OAuth deep link:', err);
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function writeCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function startAuthBridgeServer() {
  if (APP_CHANNEL !== "development" || authBridgeServer) {
    return;
  }

  authBridgeServer = http.createServer(async (req, res) => {
    writeCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${AUTH_BRIDGE_HOST}:${AUTH_BRIDGE_PORT}`);
    if (requestUrl.pathname !== AUTH_BRIDGE_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    let verifier = requestUrl.searchParams.get("neon_auth_session_verifier");
    if (!verifier && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        verifier = body?.neon_auth_session_verifier || body?.verifier || null;
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(error.message || "Invalid request");
        return;
      }
    }

    if (!verifier) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing neon_auth_session_verifier");
      return;
    }

    navigateControlPanelWithVerifier(verifier);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body><h3>OpenWhispr sign-in complete.</h3><p>You can close this tab.</p></body></html>");
  });

  authBridgeServer.on("error", (error) => {
    if (debugLogger) {
      debugLogger.error("OAuth auth bridge server failed:", error);
    }
  });

  authBridgeServer.listen(AUTH_BRIDGE_PORT, AUTH_BRIDGE_HOST, () => {
    if (debugLogger) {
      debugLogger.debug("OAuth auth bridge server started", {
        url: `http://${AUTH_BRIDGE_HOST}:${AUTH_BRIDGE_PORT}${AUTH_BRIDGE_PATH}`,
      });
    }
  });
}

// Main application startup
async function startApp() {
  // Initialize all managers now that app is ready
  initializeManagers();
  startAuthBridgeServer();

  // Electron's file:// sends no Origin header, which Neon Auth rejects.
  // Inject the request's own origin at the Chromium network layer.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://*.neon.tech/*"] },
    (details, callback) => {
      details.requestHeaders["Origin"] = new URL(details.url).origin;
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // Initialize activation mode cache from persisted .env value
  windowManager.setActivationModeCache(environmentManager.getActivationMode());

  // Update cache + persist when renderer changes activation mode (all platforms)
  ipcMain.on("activation-mode-changed", (_event, mode) => {
    windowManager.setActivationModeCache(mode);
    environmentManager.saveActivationMode(mode);
  });

  // In development, add a small delay to let Vite start properly
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // On macOS, set activation policy to allow dock icon to be shown/hidden dynamically
  // The dock icon visibility is managed by WindowManager based on control panel state
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
  }

  // Initialize Whisper manager at startup (don't await to avoid blocking)
  // Settings can be provided via environment variables for server pre-warming:
  // - LOCAL_TRANSCRIPTION_PROVIDER=whisper to enable local whisper mode
  // - LOCAL_WHISPER_MODEL=base (or tiny, small, medium, large, turbo)
  const whisperSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    whisperModel: process.env.LOCAL_WHISPER_MODEL,
  };
  whisperManager.initializeAtStartup(whisperSettings).catch((err) => {
    // Whisper not being available at startup is not critical
    debugLogger.debug("Whisper startup init error (non-fatal)", { error: err.message });
  });

  // Initialize Parakeet manager at startup (don't await to avoid blocking)
  // Settings can be provided via environment variables for server pre-warming:
  // - LOCAL_TRANSCRIPTION_PROVIDER=nvidia to enable parakeet
  // - PARAKEET_MODEL=parakeet-tdt-0.6b-v3 (model name)
  const parakeetSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    parakeetModel: process.env.PARAKEET_MODEL,
  };
  parakeetManager.initializeAtStartup(parakeetSettings).catch((err) => {
    // Parakeet not being available at startup is not critical
    debugLogger.debug("Parakeet startup init error (non-fatal)", { error: err.message });
  });

  // Pre-warm llama-server if local reasoning is configured
  // Settings can be provided via environment variables:
  // - REASONING_PROVIDER=local to enable local reasoning
  // - LOCAL_REASONING_MODEL=qwen3-8b-q4_k_m (or another model ID)
  if (process.env.REASONING_PROVIDER === "local" && process.env.LOCAL_REASONING_MODEL) {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.prewarmServer(process.env.LOCAL_REASONING_MODEL).catch((err) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: err.message });
    });
  }

  // Log nircmd status on Windows (for debugging bundled dependencies)
  if (process.platform === "win32") {
    const nircmdStatus = clipboardManager.getNircmdStatus();
    debugLogger.debug("Windows paste tool status", nircmdStatus);
  }

  // Create main window
  await windowManager.createMainWindow();

  // Create control panel window
  await windowManager.createControlPanelWindow();

  // Set up tray
  trayManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  await trayManager.createTray();

  // Set windows for update manager and check for updates
  updateManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  updateManager.checkForUpdatesOnStartup();

  if (process.platform === "darwin") {
    let globeKeyDownTime = 0;
    let globeKeyIsRecording = false;
    const MIN_HOLD_DURATION_MS = 150; // Minimum hold time to trigger push-to-talk

    globeKeyManager.on("globe-down", async () => {
      // Forward to control panel for hotkey capture
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-pressed");
      }

      // Handle dictation if Globe is the current hotkey
      if (hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey() === "GLOBE") {
        if (isLiveWindow(windowManager.mainWindow)) {
          const activationMode = await windowManager.getActivationMode();
          windowManager.showDictationPanel();
          if (activationMode === "push") {
            // Track when key was pressed for push-to-talk
            globeKeyDownTime = Date.now();
            globeKeyIsRecording = false;
            // Start recording after a brief delay to distinguish tap from hold
            setTimeout(async () => {
              // Only start if key is still being held
              if (globeKeyDownTime > 0 && !globeKeyIsRecording) {
                globeKeyIsRecording = true;
                windowManager.sendStartDictation();
              }
            }, MIN_HOLD_DURATION_MS);
          } else {
            windowManager.mainWindow.webContents.send("toggle-dictation");
          }
        }
      }
    });

    globeKeyManager.on("globe-up", async () => {
      // Forward to control panel for hotkey capture (Fn key released)
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-released");
      }

      // Handle push-to-talk release if Globe is the current hotkey
      if (hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey() === "GLOBE") {
        const activationMode = await windowManager.getActivationMode();
        if (activationMode === "push") {
          globeKeyDownTime = 0;
          // Only stop if we actually started recording
          if (globeKeyIsRecording) {
            globeKeyIsRecording = false;
            windowManager.sendStopDictation();
          }
          // If released too quickly, don't do anything (tap is ignored in push mode)
        }
      }

      // Fn release also stops compound push-to-talk for Fn+F-key hotkeys
      windowManager.handleMacPushModifierUp("fn");
    });

    globeKeyManager.on("modifier-up", (modifier) => {
      if (windowManager?.handleMacPushModifierUp) {
        windowManager.handleMacPushModifierUp(modifier);
      }
    });

    // Right-side single modifier handling (e.g., RightOption as hotkey)
    let rightModDownTime = 0;
    let rightModIsRecording = false;

    globeKeyManager.on("right-modifier-down", async (modifier) => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
      if (currentHotkey !== modifier) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = await windowManager.getActivationMode();
      windowManager.showDictationPanel();
      if (activationMode === "push") {
        rightModDownTime = Date.now();
        rightModIsRecording = false;
        setTimeout(() => {
          if (rightModDownTime > 0 && !rightModIsRecording) {
            rightModIsRecording = true;
            windowManager.sendStartDictation();
          }
        }, MIN_HOLD_DURATION_MS);
      } else {
        windowManager.mainWindow.webContents.send("toggle-dictation");
      }
    });

    globeKeyManager.on("right-modifier-up", async (modifier) => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
      if (currentHotkey !== modifier) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = await windowManager.getActivationMode();
      if (activationMode === "push") {
        rightModDownTime = 0;
        if (rightModIsRecording) {
          rightModIsRecording = false;
          windowManager.sendStopDictation();
        } else {
          windowManager.hideDictationPanel();
        }
      }
    });

    globeKeyManager.start();

    // Reset native key state when hotkey changes
    ipcMain.on("hotkey-changed", (_event, newHotkey) => {
      globeKeyDownTime = 0;
      globeKeyIsRecording = false;
      rightModDownTime = 0;
      rightModIsRecording = false;
    });
  }

  // Set up Windows Push-to-Talk handling
  if (process.platform === "win32") {
    debugLogger.debug("[Push-to-Talk] Windows Push-to-Talk setup starting");
    let winKeyDownTime = 0;
    let winKeyIsRecording = false;

    // Minimum duration (ms) the key must be held before starting recording.
    // This distinguishes a "tap" (ignored in push mode) from a "hold" (starts recording).
    // 150ms is short enough to feel instant but long enough to detect intent.
    const WIN_MIN_HOLD_DURATION_MS = 150;

    // Helper to check if hotkey is valid for Windows key listener
    const isValidHotkey = (hotkey) => {
      if (!hotkey) return false;
      if (hotkey === "GLOBE") return false;
      return true;
    };

    // Right-side single modifiers need the native listener even in tap mode
    const isRightSideMod = (hotkey) => /^Right(Control|Ctrl|Alt|Option|Shift|Super|Win|Meta|Command|Cmd)$/i.test(hotkey);

    // Whether native listener is needed (push mode always, tap mode only for right-side modifiers)
    const needsNativeListener = (hotkey, mode) => {
      if (!isValidHotkey(hotkey)) return false;
      if (mode === "push") return true;
      return isRightSideMod(hotkey);
    };

    windowsKeyManager.on("key-down", async (key) => {
      debugLogger.debug("[Push-to-Talk] Key DOWN received", { key });
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = await windowManager.getActivationMode();
      debugLogger.debug("[Push-to-Talk] Activation mode check", { activationMode });
      if (activationMode === "push") {
        debugLogger.debug("[Push-to-Talk] Starting recording sequence");
        windowManager.showDictationPanel();
        winKeyDownTime = Date.now();
        winKeyIsRecording = false;
        setTimeout(async () => {
          if (winKeyDownTime > 0 && !winKeyIsRecording) {
            winKeyIsRecording = true;
            debugLogger.debug("[Push-to-Talk] Sending start dictation command");
            windowManager.sendStartDictation();
          }
        }, WIN_MIN_HOLD_DURATION_MS);
      } else if (activationMode === "tap") {
        // Tap mode with native listener (right-side modifiers)
        windowManager.showDictationPanel();
        windowManager.mainWindow.webContents.send("toggle-dictation");
      }
    });

    windowsKeyManager.on("key-up", async () => {
      debugLogger.debug("[Push-to-Talk] Key UP received");
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = await windowManager.getActivationMode();
      if (activationMode === "push") {
        const wasRecording = winKeyIsRecording;
        winKeyDownTime = 0;
        winKeyIsRecording = false;
        if (wasRecording) {
          debugLogger.debug("[Push-to-Talk] Sending stop dictation command");
          windowManager.sendStopDictation();
        } else {
          debugLogger.debug("[Push-to-Talk] Short tap detected, hiding panel");
          windowManager.hideDictationPanel();
        }
      }
    });

    windowsKeyManager.on("error", (error) => {
      debugLogger.warn("[Push-to-Talk] Windows key listener error", { error: error.message });
      windowManager.setWindowsPushToTalkAvailable(false);
      if (isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "error",
          message: error.message,
        });
      }
    });

    windowsKeyManager.on("unavailable", () => {
      debugLogger.debug("[Push-to-Talk] Windows key listener not available - falling back to toggle mode");
      windowManager.setWindowsPushToTalkAvailable(false);
      if (isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "binary_not_found",
          message: "Push-to-Talk native listener not available",
        });
      }
    });

    windowsKeyManager.on("ready", () => {
      debugLogger.debug("[Push-to-Talk] WindowsKeyManager is ready and listening");
      windowManager.setWindowsPushToTalkAvailable(true);
    });

    // Start the Windows key listener with the current hotkey
    const startWindowsKeyListener = async () => {
      debugLogger.debug("[Push-to-Talk] Checking if should start Windows key listener");
      if (!isLiveWindow(windowManager.mainWindow)) {
        debugLogger.debug("[Push-to-Talk] Main window not live, skipping");
        return;
      }
      const activationMode = await windowManager.getActivationMode();
      const currentHotkey = hotkeyManager.getCurrentHotkey();
      debugLogger.debug("[Push-to-Talk] Current state", { activationMode, currentHotkey });

      if (needsNativeListener(currentHotkey, activationMode)) {
        debugLogger.debug("[Push-to-Talk] Starting Windows key listener", { hotkey: currentHotkey });
        windowsKeyManager.start(currentHotkey);
      } else {
        debugLogger.debug("[Push-to-Talk] Native listener not needed for current configuration");
      }
    };

    const STARTUP_DELAY_MS = 3000;
    debugLogger.debug("[Push-to-Talk] Scheduling listener start", { delayMs: STARTUP_DELAY_MS });
    setTimeout(startWindowsKeyListener, STARTUP_DELAY_MS);

    // Listen for activation mode changes from renderer
    ipcMain.on("activation-mode-changed", async (_event, mode) => {
      debugLogger.debug("[Push-to-Talk] IPC: Activation mode changed", { mode });
      const currentHotkey = hotkeyManager.getCurrentHotkey();
      if (needsNativeListener(currentHotkey, mode)) {
        debugLogger.debug("[Push-to-Talk] Starting listener", { hotkey: currentHotkey });
        windowsKeyManager.start(currentHotkey);
      } else {
        debugLogger.debug("[Push-to-Talk] Stopping listener");
        windowsKeyManager.stop();
      }
    });

    // Listen for hotkey changes from renderer
    ipcMain.on("hotkey-changed", async (_event, hotkey) => {
      debugLogger.debug("[Push-to-Talk] IPC: Hotkey changed", { hotkey });
      if (!isLiveWindow(windowManager.mainWindow)) return;
      const activationMode = await windowManager.getActivationMode();
      windowsKeyManager.stop();
      if (needsNativeListener(hotkey, activationMode)) {
        debugLogger.debug("[Push-to-Talk] Starting listener for new hotkey", { hotkey });
        windowsKeyManager.start(hotkey);
      }
    });
  }
}

// Listen for usage limit reached from dictation overlay, forward to control panel
ipcMain.on("limit-reached", (_event, data) => {
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.send("limit-reached", data);
  }
});

// App event handlers
if (gotSingleInstanceLock) {
  app.on("second-instance", async (_event, commandLine) => {
    await app.whenReady();
    if (!windowManager) {
      return;
    }

    if (isLiveWindow(windowManager.controlPanelWindow)) {
      if (windowManager.controlPanelWindow.isMinimized()) {
        windowManager.controlPanelWindow.restore();
      }
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
    } else {
      windowManager.createControlPanelWindow();
    }

    if (isLiveWindow(windowManager.mainWindow)) {
      windowManager.enforceMainWindowOnTop();
    } else {
      windowManager.createMainWindow();
    }

    // Check for OAuth protocol URL in command line arguments (Windows/Linux)
    const url = commandLine.find(arg => arg.startsWith(`${OAUTH_PROTOCOL}://`));
    if (url) {
      handleOAuthDeepLink(url);
    }
  });

  app.whenReady().then(() => {
    // On Linux, --enable-transparent-visuals requires a short delay before creating
    // windows to allow the compositor to set up the ARGB visual correctly.
    // Without this delay, transparent windows flicker on both X11 and Wayland.
    const delay = process.platform === "linux" ? 300 : 0;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }).then(() => {
    startApp().catch((error) => {
      console.error("Failed to start app:", error);
      dialog.showErrorBox(
        "OpenWhispr Startup Error",
        `Failed to start the application:\n\n${error.message}\n\nPlease report this issue.`
      );
      app.exit(1);
    });
  });

  app.on("window-all-closed", () => {
    // Don't quit on macOS when all windows are closed
    // The app should stay in the dock/menu bar
    if (process.platform !== "darwin") {
      app.quit();
    }
    // On macOS, keep the app running even without windows
  });

  app.on("browser-window-focus", (event, window) => {
    // Only apply always-on-top to the dictation window, not the control panel
    if (windowManager && isLiveWindow(windowManager.mainWindow)) {
      // Check if the focused window is the dictation window
      if (window === windowManager.mainWindow) {
        windowManager.enforceMainWindowOnTop();
      }
    }

    // Control panel doesn't need any special handling on focus
    // It should behave like a normal window
  });

  app.on("activate", () => {
    // On macOS, re-create windows when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      if (windowManager) {
        windowManager.createMainWindow();
        windowManager.createControlPanelWindow();
      }
    } else {
      // Show control panel when dock icon is clicked (most common user action)
      if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
        // Ensure dock icon is visible when control panel opens
        if (process.platform === "darwin" && app.dock) {
          app.dock.show();
        }
        if (windowManager.controlPanelWindow.isMinimized()) {
          windowManager.controlPanelWindow.restore();
        }
        windowManager.controlPanelWindow.show();
        windowManager.controlPanelWindow.focus();
      } else if (windowManager) {
        // If control panel doesn't exist, create it
        windowManager.createControlPanelWindow();
      }

      // Ensure dictation panel maintains its always-on-top status
      if (windowManager && isLiveWindow(windowManager.mainWindow)) {
        windowManager.enforceMainWindowOnTop();
      }
    }
  });

  app.on("will-quit", () => {
    if (authBridgeServer) {
      authBridgeServer.close();
      authBridgeServer = null;
    }
    if (hotkeyManager) {
      hotkeyManager.unregisterAll();
    } else {
      globalShortcut.unregisterAll();
    }
    if (globeKeyManager) {
      globeKeyManager.stop();
    }
    if (windowsKeyManager) {
      windowsKeyManager.stop();
    }
    if (updateManager) {
      updateManager.cleanup();
    }
    // Stop whisper server if running
    if (whisperManager) {
      whisperManager.stopServer().catch(() => {});
    }
    // Stop parakeet WS server if running
    if (parakeetManager) {
      parakeetManager.stopServer().catch(() => {});
    }
    // Stop llama-server if running
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.stopServer().catch(() => {});
  });
}
