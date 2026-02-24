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
  app.commandLine.appendSwitch("gtk-version", "3");
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Enable native Wayland support: Ozone platform for native rendering,
// and GlobalShortcutsPortal for global shortcuts via xdg-desktop-portal
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch(
    "enable-features",
    "UseOzonePlatform,WaylandWindowDecorations,GlobalShortcutsPortal"
  );
}

// Group all windows under single taskbar entry on Windows
if (process.platform === "win32") {
  const windowsAppId =
    APP_CHANNEL === "production" ? BASE_WINDOWS_APP_ID : `${BASE_WINDOWS_APP_ID}.${APP_CHANNEL}`;
  app.setAppUserModelId(windowsAppId);
}

function getOAuthProtocol() {
  const fromEnv = (process.env.VITE_OPENWHISPR_PROTOCOL || process.env.OPENWHISPR_PROTOCOL || "")
    .trim()
    .toLowerCase();

  if (/^[a-z][a-z0-9+.-]*$/.test(fromEnv)) {
    return fromEnv;
  }

  return (
    DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[APP_CHANNEL] || DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production
  );
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
const WhisperCudaManager = require("./src/helpers/whisperCudaManager");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");

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
let whisperCudaManager = null;
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

// Phase 1: Initialize managers + IPC handlers before window content loads
function initializeCoreManagers() {
  setupProductionPath();

  debugLogger = require("./src/helpers/debugLogger");
  debugLogger.ensureFileLogging();

  environmentManager = new EnvironmentManager();
  const uiLanguage = environmentManager.getUiLanguage();
  process.env.UI_LANGUAGE = uiLanguage;
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  hotkeyManager = windowManager.hotkeyManager;
  databaseManager = new DatabaseManager();
  clipboardManager = new ClipboardManager();
  whisperManager = new WhisperManager();
  if (process.platform !== "darwin") {
    whisperCudaManager = new WhisperCudaManager();
  }
  parakeetManager = new ParakeetManager();
  updateManager = new UpdateManager();
  windowsKeyManager = new WindowsKeyManager();

  // IPC handlers must be registered before window content loads
  new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    whisperManager,
    parakeetManager,
    windowManager,
    updateManager,
    windowsKeyManager,
    whisperCudaManager,
    getTrayManager: () => trayManager,
  });
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  clipboardManager.preWarmAccessibility();
  trayManager = new TrayManager();
  globeKeyManager = new GlobeKeyManager();

  if (process.platform === "darwin") {
    globeKeyManager.on("error", (error) => {
      if (globeKeyAlertShown) {
        return;
      }
      globeKeyAlertShown = true;

      const detailLines = [
        error?.message || i18nMain.t("startup.globeHotkey.details.unknown"),
        i18nMain.t("startup.globeHotkey.details.fallback"),
      ];

      if (process.env.NODE_ENV === "development") {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.devHint"));
      } else {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.reinstallHint"));
      }

      dialog.showMessageBox({
        type: "warning",
        title: i18nMain.t("startup.globeHotkey.title"),
        message: i18nMain.t("startup.globeHotkey.message"),
        detail: detailLines.join("\n\n"),
      });
    });
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!url.startsWith(`${OAUTH_PROTOCOL}://`)) return;

  handleOAuthDeepLink(url);

  if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
  }
});

// Extract the session verifier from the deep link and navigate the control
// panel to its app URL with the verifier param so the Neon Auth SDK can
// read it from window.location.search and complete authentication.
function navigateControlPanelWithVerifier(verifier) {
  if (!verifier) return;
  if (!isLiveWindow(windowManager?.controlPanelWindow)) return;

  const appUrl = DevServerManager.getAppUrl(true);

  if (appUrl) {
    const separator = appUrl.includes("?") ? "&" : "?";
    const urlWithVerifier = `${appUrl}${separator}neon_auth_session_verifier=${encodeURIComponent(verifier)}`;
    windowManager.controlPanelWindow.loadURL(urlWithVerifier);
  } else {
    const fileInfo = DevServerManager.getAppFilePath(true);
    if (!fileInfo) return;
    fileInfo.query.neon_auth_session_verifier = verifier;
    windowManager.controlPanelWindow.loadFile(fileInfo.path, { query: fileInfo.query });
  }

  if (debugLogger) {
    debugLogger.debug("Navigating control panel with OAuth verifier", {
      appChannel: APP_CHANNEL,
      oauthProtocol: OAUTH_PROTOCOL,
    });
  }
  windowManager.controlPanelWindow.show();
  windowManager.controlPanelWindow.focus();
}

function handleOAuthDeepLink(deepLinkUrl) {
  try {
    const parsed = new URL(deepLinkUrl);
    const verifier = parsed.searchParams.get("neon_auth_session_verifier");
    if (!verifier) return;
    navigateControlPanelWithVerifier(verifier);
  } catch (err) {
    if (debugLogger) debugLogger.error("Failed to handle OAuth deep link:", err);
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
    res.end(
      "<html><body><h3>OpenWhispr sign-in complete.</h3><p>You can close this tab.</p></body></html>"
    );
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
  // Phase 1: Core managers + IPC handlers before windows
  initializeCoreManagers();
  startAuthBridgeServer();

  // Electron's file:// sends no Origin header, which Neon Auth rejects.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://*.neon.tech/*"] },
    (details, callback) => {
      try {
        details.requestHeaders["Origin"] = new URL(details.url).origin;
      } catch {
        /* malformed URL — leave Origin as-is */
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  windowManager.setActivationModeCache(environmentManager.getActivationMode());
  windowManager.setFloatingIconAutoHide(environmentManager.getFloatingIconAutoHide());

  ipcMain.on("activation-mode-changed", (_event, mode) => {
    windowManager.setActivationModeCache(mode);
    environmentManager.saveActivationMode(mode);
  });

  ipcMain.on("floating-icon-auto-hide-changed", (_event, enabled) => {
    windowManager.setFloatingIconAutoHide(enabled);
    environmentManager.saveFloatingIconAutoHide(enabled);
    // Relay to the floating icon window so it can react immediately
    if (windowManager.mainWindow && !windowManager.mainWindow.isDestroyed()) {
      windowManager.mainWindow.webContents.send("floating-icon-auto-hide-changed", enabled);
    }
  });

  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
  }

  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Create windows FIRST so the user sees UI as soon as possible
  await windowManager.createMainWindow();
  await windowManager.createControlPanelWindow();

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();

  // Non-blocking server pre-warming
  const whisperSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    whisperModel: process.env.LOCAL_WHISPER_MODEL,
    useCuda: process.env.WHISPER_CUDA_ENABLED === "true" && whisperCudaManager?.isDownloaded(),
  };
  whisperManager.initializeAtStartup(whisperSettings).catch((err) => {
    debugLogger.debug("Whisper startup init error (non-fatal)", { error: err.message });
  });

  const parakeetSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    parakeetModel: process.env.PARAKEET_MODEL,
  };
  parakeetManager.initializeAtStartup(parakeetSettings).catch((err) => {
    debugLogger.debug("Parakeet startup init error (non-fatal)", { error: err.message });
  });

  if (process.env.REASONING_PROVIDER === "local" && process.env.LOCAL_REASONING_MODEL) {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.prewarmServer(process.env.LOCAL_REASONING_MODEL).catch((err) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: err.message });
    });
  }

  if (process.platform === "win32") {
    const nircmdStatus = clipboardManager.getNircmdStatus();
    debugLogger.debug("Windows paste tool status", nircmdStatus);
  }

  trayManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  await trayManager.createTray();

  updateManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  updateManager.checkForUpdatesOnStartup();

  if (process.platform === "darwin") {
    let globeKeyDownTime = 0;
    let globeKeyIsRecording = false;
    let globeLastStopTime = 0;
    const MIN_HOLD_DURATION_MS = 150;
    const POST_STOP_COOLDOWN_MS = 300;

    globeKeyManager.on("globe-down", async () => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
      const mainWindowLive = isLiveWindow(windowManager.mainWindow);
      debugLogger?.debug("[Globe] globe-down received", {
        currentHotkey,
        mainWindowLive,
        activationMode: mainWindowLive ? windowManager.getActivationMode() : "n/a",
      });

      // Forward to control panel for hotkey capture
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-pressed");
      }

      // Handle dictation if Globe is the current hotkey
      if (currentHotkey === "GLOBE") {
        if (mainWindowLive) {
          const activationMode = windowManager.getActivationMode();
          if (activationMode === "push") {
            const now = Date.now();
            if (now - globeLastStopTime < POST_STOP_COOLDOWN_MS) {
              debugLogger?.debug("[Globe] Ignored — cooldown active");
              return;
            }
            windowManager.showDictationPanel();
            const pressTime = now;
            globeKeyDownTime = pressTime;
            globeKeyIsRecording = false;
            setTimeout(async () => {
              if (globeKeyDownTime === pressTime && !globeKeyIsRecording) {
                globeKeyIsRecording = true;
                debugLogger?.debug("[Globe] Starting dictation (push hold)");
                windowManager.sendStartDictation();
              }
            }, MIN_HOLD_DURATION_MS);
          } else {
            windowManager.showDictationPanel();
            windowManager.mainWindow.webContents.send("toggle-dictation");
          }
        } else {
          debugLogger?.debug("[Globe] Ignored — mainWindow not live");
        }
      } else {
        debugLogger?.debug("[Globe] Ignored — hotkey is not GLOBE", { currentHotkey });
      }
    });

    globeKeyManager.on("globe-up", async () => {
      debugLogger?.debug("[Globe] globe-up received", { wasRecording: globeKeyIsRecording });

      // Forward to control panel for hotkey capture (Fn key released)
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-released");
      }

      // Handle push-to-talk release if Globe is the current hotkey
      if (hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey() === "GLOBE") {
        const activationMode = windowManager.getActivationMode();
        if (activationMode === "push") {
          globeKeyDownTime = 0;
          globeLastStopTime = Date.now();
          if (globeKeyIsRecording) {
            globeKeyIsRecording = false;
            debugLogger?.debug("[Globe] Stopping dictation (push release)");
            windowManager.sendStopDictation();
          }
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
    let rightModLastStopTime = 0;

    globeKeyManager.on("right-modifier-down", async (modifier) => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
      if (currentHotkey !== modifier) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        const now = Date.now();
        if (now - rightModLastStopTime < POST_STOP_COOLDOWN_MS) return;
        windowManager.showDictationPanel();
        const pressTime = now;
        rightModDownTime = pressTime;
        rightModIsRecording = false;
        setTimeout(() => {
          if (rightModDownTime === pressTime && !rightModIsRecording) {
            rightModIsRecording = true;
            windowManager.sendStartDictation();
          }
        }, MIN_HOLD_DURATION_MS);
      } else {
        windowManager.showDictationPanel();
        windowManager.mainWindow.webContents.send("toggle-dictation");
      }
    });

    globeKeyManager.on("right-modifier-up", async (modifier) => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();

      if (currentHotkey === modifier) {
        if (!isLiveWindow(windowManager.mainWindow)) return;

        const activationMode = windowManager.getActivationMode();
        if (activationMode === "push") {
          rightModDownTime = 0;
          rightModLastStopTime = Date.now();
          if (rightModIsRecording) {
            rightModIsRecording = false;
            windowManager.sendStopDictation();
          } else {
            windowManager.hideDictationPanel();
          }
        }
      }

      const rightModToBase = {
        RightCommand: "command",
        RightOption: "option",
        RightControl: "control",
        RightShift: "shift",
      };
      const baseMod = rightModToBase[modifier];
      if (baseMod && windowManager?.handleMacPushModifierUp) {
        windowManager.handleMacPushModifierUp(baseMod);
      }
    });

    globeKeyManager.start();

    // Reset native key state when hotkey changes
    ipcMain.on("hotkey-changed", (_event, _newHotkey) => {
      globeKeyDownTime = 0;
      globeKeyIsRecording = false;
      globeLastStopTime = 0;
      rightModDownTime = 0;
      rightModIsRecording = false;
      rightModLastStopTime = 0;
    });
  }

  // Set up Windows Push-to-Talk handling
  if (process.platform === "win32") {
    debugLogger.debug("[Push-to-Talk] Windows Push-to-Talk setup starting");

    const isValidHotkey = (hotkey) => hotkey && hotkey !== "GLOBE";

    const isRightSideMod = (hotkey) =>
      /^Right(Control|Ctrl|Alt|Option|Shift|Super|Win|Meta|Command|Cmd)$/i.test(hotkey);

    const { isModifierOnlyHotkey } = require("./src/helpers/hotkeyManager");

    const needsNativeListener = (hotkey, mode) => {
      if (!isValidHotkey(hotkey)) return false;
      if (mode === "push") return true;
      return isRightSideMod(hotkey) || isModifierOnlyHotkey(hotkey);
    };

    windowsKeyManager.on("key-down", (_key) => {
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        windowManager.startWindowsPushToTalk();
      } else if (activationMode === "tap") {
        windowManager.showDictationPanel();
        windowManager.mainWindow.webContents.send("toggle-dictation");
      }
    });

    windowsKeyManager.on("key-up", () => {
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        windowManager.handleWindowsPushKeyUp();
      }
    });

    windowsKeyManager.on("error", (error) => {
      debugLogger.warn("[Push-to-Talk] Windows key listener error", { error: error.message });
      if (isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "error",
          message: error.message,
        });
      }
    });

    windowsKeyManager.on("unavailable", () => {
      debugLogger.debug(
        "[Push-to-Talk] Windows key listener not available - falling back to toggle mode"
      );
      if (isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "binary_not_found",
          message: i18nMain.t("windows.pttUnavailable"),
        });
      }
    });

    windowsKeyManager.on("ready", () => {
      debugLogger.debug("[Push-to-Talk] WindowsKeyManager is ready and listening");
    });

    const startWindowsKeyListener = () => {
      if (!isLiveWindow(windowManager.mainWindow)) return;
      const activationMode = windowManager.getActivationMode();
      const currentHotkey = hotkeyManager.getCurrentHotkey();

      if (needsNativeListener(currentHotkey, activationMode)) {
        windowsKeyManager.start(currentHotkey);
      }
    };

    const STARTUP_DELAY_MS = 3000;
    setTimeout(startWindowsKeyListener, STARTUP_DELAY_MS);

    ipcMain.on("activation-mode-changed", (_event, mode) => {
      windowManager.resetWindowsPushState();
      const currentHotkey = hotkeyManager.getCurrentHotkey();
      if (needsNativeListener(currentHotkey, mode)) {
        windowsKeyManager.start(currentHotkey);
      } else {
        windowsKeyManager.stop();
      }
    });

    ipcMain.on("hotkey-changed", (_event, hotkey) => {
      if (!isLiveWindow(windowManager.mainWindow)) return;
      windowManager.resetWindowsPushState();
      const activationMode = windowManager.getActivationMode();
      windowsKeyManager.stop();
      if (needsNativeListener(hotkey, activationMode)) {
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
    const url = commandLine.find((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`));
    if (url) {
      handleOAuthDeepLink(url);
    }
  });

  app
    .whenReady()
    .then(() => {
      // On Linux, --enable-transparent-visuals requires a short delay before creating
      // windows to allow the compositor to set up the ARGB visual correctly.
      // Without this delay, transparent windows flicker on both X11 and Wayland.
      const delay = process.platform === "linux" ? 300 : 0;
      return new Promise((resolve) => setTimeout(resolve, delay));
    })
    .then(() => {
      startApp().catch((error) => {
        console.error("Failed to start app:", error);
        dialog.showErrorBox(
          i18nMain.t("startup.error.title"),
          i18nMain.t("startup.error.message", { error: error.message })
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
