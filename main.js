// KDE/GNOME Wayland: self-relaunch with --ozone-platform=x11 to force XWayland.
// Chromium picks the display backend before JS runs, so appendSwitch is too late.
if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland" &&
  !process.argv.includes("--ozone-platform=x11")
) {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase();
  if (desktop.includes("kde") || /gnome|ubuntu|unity|cosmic/.test(desktop)) {
    const { spawn } = require("child_process");
    spawn(process.execPath, [...process.argv.slice(1), "--ozone-platform=x11"], {
      stdio: "inherit",
      detached: true,
    }).unref();
    process.exit(0);
  }
}

const {
  app,
  desktopCapturer,
  globalShortcut,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  session,
  systemPreferences,
} = require("electron");
const path = require("path");
const http = require("http");
const tls = require("tls");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Extend Node's TLS trust with the OS store so ws and https.get see corporate
// CAs that Chromium already trusts.
try {
  const currentCAs = tls.getCACertificates();
  const systemCAs = tls.getCACertificates("system");
  if (systemCAs?.length) {
    tls.setDefaultCACertificates([...currentCAs, ...systemCAs]);
  }
} catch (err) {
  require("./src/helpers/debugLogger").warn("System CA merge failed; using existing CA list", {
    error: err?.message,
  });
}

const VALID_CHANNELS = new Set(["development", "staging", "production"]);
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "openwhispr-dev",
  staging: "openwhispr-staging",
  production: "openwhispr",
};
const BASE_WINDOWS_APP_ID = "com.gizmolabs.openwhispr";
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

// Load userData .env (contains DICTATION_KEY, API keys, etc.) early — before
// hotkey registration, which needs DICTATION_KEY before the renderer loads.
require("dotenv").config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});

// Fix transparent window flickering on Linux: --enable-transparent-visuals requires
// the compositor to set up an ARGB visual before any windows are created.
// --disable-gpu-compositing prevents GPU compositing conflicts with the compositor.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("gtk-version", "3");
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Wayland: packaged builds use the wrapper script (scripts/afterPack.js) to
// force --ozone-platform=x11 before Electron starts. appendSwitch below is a
// best-effort fallback for unpackaged dev mode (may not take effect on E39+).
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
}

// Set desktop filename so Wayland compositors can match windows to the .desktop entry.
// This allows XDG portals (e.g. PipeWire) to persist permissions across sessions.
if (process.platform === "linux") {
  app.setDesktopName("open-whispr.desktop");
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

function getDefaultHtmlHandler() {
  try {
    const { execFileSync } = require("child_process");
    return (
      execFileSync("xdg-mime", ["query", "default", "text/html"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function restoreHtmlHandlerIfChanged(original) {
  try {
    const { execFileSync } = require("child_process");
    const current = execFileSync("xdg-mime", ["query", "default", "text/html"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (current && current !== original) {
      execFileSync("xdg-mime", ["default", original, "text/html"], { timeout: 3000 });
    }
  } catch {
    // xdg-mime unavailable or failed
  }
}

// True source of truth for whether openwhispr:// resolves on Linux — the same
// MIME database xdg-open consults. Returns true for deb/rpm/flatpak/AUR installs
// (scheme registered via the packaged .desktop MimeType) and false for AppImage/
// tar.gz runs where it genuinely isn't registered, so we never enable a dead-end
// OAuth flow. Used to recover from setAsDefaultProtocolClient's KDE false negative.
function isOAuthSchemeRegistered() {
  if (process.platform !== "linux") return false;
  try {
    const { execFileSync } = require("child_process");
    const handler = execFileSync(
      "xdg-mime",
      ["query", "default", `x-scheme-handler/${OAUTH_PROTOCOL}`],
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    return handler.length > 0;
  } catch {
    return false;
  }
}

// Register custom protocol for OAuth callbacks.
// In development, always include the app path argument so macOS/Windows/Linux
// can launch the project app instead of opening bare Electron.
function registerOpenWhisprProtocol() {
  const protocol = OAUTH_PROTOCOL;
  const htmlHandler = process.platform === "linux" ? getDefaultHtmlHandler() : null;

  let result;
  if (shouldRegisterProtocolWithAppArg()) {
    const appArg = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(".");
    result = app.setAsDefaultProtocolClient(protocol, process.execPath, [appArg]);
  } else {
    result = app.setAsDefaultProtocolClient(protocol);
  }

  if (htmlHandler) {
    restoreHtmlHandlerIfChanged(htmlHandler);
  }

  return result;
}

// setAsDefaultProtocolClient returns a false negative on KDE/Wayland, so on Linux
// fall back to probing the system MIME database for an actual handler. This keeps
// OAuth enabled where the callback can resolve (deb/rpm/flatpak/AUR) and correctly
// gated where it can't (AppImage/tar.gz with no scheme registration).
const protocolRegistered = registerOpenWhisprProtocol() || isOAuthSchemeRegistered();
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
const DiarizationManager = require("./src/helpers/diarization");
const TrayManager = require("./src/helpers/tray");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const CliBridge = require("./src/helpers/cliBridge");
const UpdateManager = require("./src/updater");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");
const DevServerManager = require("./src/helpers/devServerManager");
const WindowsKeyManager = require("./src/helpers/windowsKeyManager");
const LinuxKeyManager = require("./src/helpers/linuxKeyManager");
const TextEditMonitor = require("./src/helpers/textEditMonitor");
const WhisperCudaManager = require("./src/helpers/whisperCudaManager");
const GoogleCalendarManager = require("./src/helpers/googleCalendarManager");
const MeetingProcessDetector = require("./src/helpers/meetingProcessDetector");
const AudioActivityDetector = require("./src/helpers/audioActivityDetector");
const AudioTapManager = require("./src/helpers/audioTapManager");
const LinuxPortalAudioManager = require("./src/helpers/linuxPortalAudioManager");
const WindowsLoopbackAudioManager = require("./src/helpers/windowsLoopbackAudioManager");
const MeetingAecManager = require("./src/helpers/meetingAecManager");
const MeetingDetectionEngine = require("./src/helpers/meetingDetectionEngine");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");
const { ensureYdotool } = require("./src/helpers/ensureYdotool");
const sidecarRegistry = require("./src/helpers/sidecarRegistry");
const { reapStaleSidecars } = require("./src/helpers/sidecarReaper");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let hotkeyManager = null;
let databaseManager = null;
let clipboardManager = null;
let whisperManager = null;
let parakeetManager = null;
let diarizationManager = null;
let trayManager = null;
let updateManager = null;
let globeKeyManager = null;
let windowsKeyManager = null;
let linuxKeyManager = null;
let textEditMonitor = null;
let whisperCudaManager = null;
let googleCalendarManager = null;
let meetingDetectionEngine = null;
let audioTapManager = null;
let linuxPortalAudioManager = null;
let windowsLoopbackAudioManager = null;
let meetingAecManager = null;
let qdrantManager = null;
let ipcHandlers = null;
let cliBridge = null;
let globeKeyAlertShown = false;
let authBridgeServer = null;
const WHISPER_WAKE_REWARM_DELAY_MS = 3000;
let wakeRewarmTimer = null;

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
// Best-effort cleanup of the orphaned portal restore-token file older builds wrote. See PR #904.
const LINUX_RESTORE_TOKEN_FILENAME = ".linux-system-audio-restore-token.json";

function cleanupOrphanedLinuxRestoreToken() {
  if (process.platform !== "linux") return;
  try {
    const fs = require("fs");
    fs.unlinkSync(path.join(app.getPath("userData"), LINUX_RESTORE_TOKEN_FILENAME));
  } catch {}
}

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
  diarizationManager = new DiarizationManager();
  googleCalendarManager = new GoogleCalendarManager(databaseManager, windowManager);
  meetingDetectionEngine = new MeetingDetectionEngine(
    googleCalendarManager,
    new MeetingProcessDetector(),
    new AudioActivityDetector(),
    windowManager,
    databaseManager
  );
  windowManager.meetingDetectionEngine = meetingDetectionEngine;
  updateManager = new UpdateManager();
  updateManager.setWindowManager(windowManager);
  windowsKeyManager = new WindowsKeyManager();
  linuxKeyManager = new LinuxKeyManager();
  textEditMonitor = new TextEditMonitor();
  audioTapManager = new AudioTapManager();
  linuxPortalAudioManager = new LinuxPortalAudioManager();
  windowsLoopbackAudioManager = new WindowsLoopbackAudioManager();
  // Warm the capability cache off the hot path so the first meeting start
  // doesn't pay the probe spawn. No-ops on non-Windows.
  windowsLoopbackAudioManager.getCapability().catch(() => {});
  cleanupOrphanedLinuxRestoreToken();
  meetingAecManager = new MeetingAecManager();
  windowManager.textEditMonitor = textEditMonitor;
  windowManager.windowsKeyManager = windowsKeyManager;
  windowManager.linuxKeyManager = linuxKeyManager;

  // IPC handlers must be registered before window content loads
  ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    whisperManager,
    parakeetManager,
    diarizationManager,
    windowManager,
    updateManager,
    windowsKeyManager,
    linuxKeyManager,
    textEditMonitor,
    whisperCudaManager,
    googleCalendarManager,
    meetingDetectionEngine,
    audioTapManager,
    linuxPortalAudioManager,
    windowsLoopbackAudioManager,
    meetingAecManager,
    getTrayManager: () => trayManager,
    oauthProtocolRegistered: protocolRegistered,
    oauthProtocol: OAUTH_PROTOCOL,
  });
}

function registerSidecars() {
  if (whisperManager) sidecarRegistry.register("whisper", () => whisperManager.stopServer());
  if (parakeetManager) sidecarRegistry.register("parakeet", () => parakeetManager.stopServer());
  if (diarizationManager) {
    sidecarRegistry.register("diarization", () => diarizationManager.shutdown());
  }
  const modelManager = require("./src/helpers/modelManagerBridge").default;
  sidecarRegistry.register("llama", () => modelManager.stopServer());
  const onnxWorkerClient = require("./src/helpers/onnxWorkerClient");
  sidecarRegistry.register("onnx", () => onnxWorkerClient.stop());
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  ensureYdotool().catch((err) => {
    require("./src/helpers/debugLogger").warn(
      "ydotool setup error",
      { error: err?.message },
      "clipboard"
    );
  });
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

  googleCalendarManager.start();
  meetingDetectionEngine.start();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!url.startsWith(`${OAUTH_PROTOCOL}://`)) return;

  if (url.includes("upgrade-success")) {
    handleUpgradeDeepLink();
    return;
  }

  if (isInvitationDeepLink(url)) {
    handleInvitationDeepLink(url);
    return;
  }

  void handleOAuthDeepLink(url);

  if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
  }
});

function isInvitationDeepLink(url) {
  return url.slice(`${OAUTH_PROTOCOL}://`.length).startsWith("invitations/");
}

function handleInvitationDeepLink(deepLinkUrl) {
  try {
    const match = deepLinkUrl.match(/invitations\/([^/?#]+)/);
    const token = match?.[1];
    if (!token) return;
    if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
      windowManager.controlPanelWindow.webContents.send("workspace-invitation-token", token);
    } else if (windowManager) {
      windowManager.createControlPanelWindow();
      // Defer the send until renderer is ready; main.js relies on `did-finish-load`
      const win = windowManager.controlPanelWindow;
      if (win) {
        win.webContents.once("did-finish-load", () => {
          win.webContents.send("workspace-invitation-token", token);
        });
      }
    }
  } catch (error) {
    console.error("Invitation deep link parse failed:", error);
  }
}

function resolveAuthUrl() {
  const fs = require("fs");
  const envPath = path.join(__dirname, "src", "dist", "runtime-env.json");
  let runtimeEnv = {};
  try {
    if (fs.existsSync(envPath)) runtimeEnv = JSON.parse(fs.readFileSync(envPath, "utf8"));
  } catch {}
  return (
    process.env.AUTH_URL ||
    process.env.VITE_AUTH_URL ||
    runtimeEnv.VITE_AUTH_URL ||
    "https://auth.openwhispr.com"
  );
}

function getOauthCookieName() {
  return process.env.NODE_ENV === "production"
    ? "__Secure-openwhispr.session_token"
    : "openwhispr.session_token";
}

// Older website builds send the signed cookie value as `?token=`; trade it
// for the raw session.token the bearer plugin expects.
async function exchangeSignedTokenForRawBearer(signedToken) {
  try {
    const res = await net.fetch(`${resolveAuthUrl()}/api/auth/get-session`, {
      headers: { Cookie: `${getOauthCookieName()}=${signedToken}` },
      signal: AbortSignal.timeout(5000),
      useSessionCookies: false,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.session?.token || null;
  } catch (err) {
    if (debugLogger) {
      debugLogger.warn("Signed-token bearer exchange failed (non-fatal)", {
        error: err?.message,
      });
    }
    return null;
  }
}

// One-time bridge for users upgrading from a build that injected the session
// cookie into Electron's jar: exchange the existing cookie for a raw bearer
// token, store it, and remove the cookie. Non-fatal — failures fall through
// to the normal sign-in flow.
async function migrateCookieToBearerToken() {
  const tokenStore = require("./src/helpers/tokenStore");
  if (tokenStore.get()) return;

  const cookieName = getOauthCookieName();
  const authUrl = resolveAuthUrl();

  try {
    const cookies = await session.defaultSession.cookies.get({ url: authUrl, name: cookieName });
    if (!cookies.length) return;

    const rawToken = await exchangeSignedTokenForRawBearer(cookies[0].value);
    if (!rawToken) return;

    tokenStore.set(rawToken);
    await session.defaultSession.cookies.remove(authUrl, cookieName);
    if (debugLogger) debugLogger.debug("Migrated cookie to bearer token");
  } catch (err) {
    if (debugLogger) {
      debugLogger.warn("Cookie→bearer token migration failed (non-fatal)", {
        error: err?.message,
      });
    }
  }
}

// Persist the bearer token and reload the control panel so the renderer's
// authClient sends `Authorization: Bearer <token>` on its next request.
async function applySessionTokenAndRefresh(token) {
  if (!token) return;
  if (!isLiveWindow(windowManager?.controlPanelWindow)) return;

  const tokenStore = require("./src/helpers/tokenStore");
  tokenStore.set(token);

  const appUrl = DevServerManager.getAppUrl(true);
  if (appUrl) {
    windowManager.controlPanelWindow.loadURL(appUrl);
  } else {
    const fileInfo = DevServerManager.getAppFilePath(true);
    if (fileInfo) {
      windowManager.controlPanelWindow.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  if (debugLogger) {
    debugLogger.debug("Applied bearer token and reloaded control panel", {
      appChannel: APP_CHANNEL,
      oauthProtocol: OAUTH_PROTOCOL,
    });
  }
  windowManager.controlPanelWindow.show();
  windowManager.controlPanelWindow.focus();
}

async function handleOAuthDeepLink(deepLinkUrl) {
  try {
    const parsed = new URL(deepLinkUrl);
    const bearerToken = parsed.searchParams.get("bearer_token");
    if (bearerToken) {
      void applySessionTokenAndRefresh(bearerToken);
      return;
    }
    const signedToken = parsed.searchParams.get("token");
    if (!signedToken) return;
    const rawToken = await exchangeSignedTokenForRawBearer(signedToken);
    if (rawToken) void applySessionTokenAndRefresh(rawToken);
  } catch (err) {
    if (debugLogger) debugLogger.error("Failed to handle OAuth deep link:", err);
  }
}

function handleUpgradeDeepLink() {
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.executeJavaScript(
      'window.dispatchEvent(new Event("upgrade-success"))'
    );
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
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

    let token = requestUrl.searchParams.get("bearer_token") || requestUrl.searchParams.get("token");
    if (!token && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        token = body?.bearer_token || body?.token || null;
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(error.message || "Invalid request");
        return;
      }
    }

    if (!token) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing token");
      return;
    }

    void applySessionTokenAndRefresh(token);

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
  reapStaleSidecars();

  // Phase 1: Core managers + IPC handlers before windows
  initializeCoreManagers();
  await environmentManager.init();
  registerSidecars();
  startAuthBridgeServer();

  cliBridge = new CliBridge(ipcHandlers);
  cliBridge.start().catch((err) => {
    debugLogger.error("CLI bridge failed to start", { error: err.message });
    cliBridge = null;
  });

  await migrateCookieToBearerToken();

  // Electron's file:// renderer sends Origin: null, which Better Auth's
  // trustedOrigins check rejects. Spoof Origin to the request's own URL so
  // calls to OpenWhispr's auth and API hosts are treated as same-origin.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        "https://auth.openwhispr.com/*",
        "https://api.openwhispr.com/*",
        "http://localhost:3000/*",
        "http://127.0.0.1:3000/*",
      ],
    },
    (details, callback) => {
      try {
        details.requestHeaders["Origin"] = new URL(details.url).origin;
      } catch {
        // malformed URL — leave Origin as-is
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  windowManager.setActivationModeCache(environmentManager.getActivationMode());
  windowManager.setFloatingIconAutoHide(environmentManager.getFloatingIconAutoHide());
  windowManager.setPanelStartPosition(environmentManager.getPanelStartPosition());

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

  ipcMain.on("start-minimized-changed", (_event, enabled) => {
    if (debugLogger) debugLogger.info("Start minimized changed", { enabled });
    environmentManager.saveStartMinimized(enabled);
  });

  ipcMain.on("panel-start-position-changed", (_event, position) => {
    windowManager.setPanelStartPosition(position);
    environmentManager.savePanelStartPosition(position);
  });

  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
  }

  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Create windows FIRST so the user sees UI as soon as possible
  const startMinimized = environmentManager.getStartMinimized();
  if (debugLogger) debugLogger.info("Start minimized", { enabled: startMinimized });
  await windowManager.createMainWindow();
  if (!startMinimized) {
    await windowManager.createControlPanelWindow();
  }

  // Create agent window (hidden) and set up agent hotkey
  await windowManager.createAgentWindow();

  const agentHotkeyCallback = () => {
    if (hotkeyManager.isInListeningMode()) return;
    windowManager.toggleAgentOverlay();
  };
  windowManager._agentHotkeyCallback = agentHotkeyCallback;

  const savedAgentKey = environmentManager.getAgentKey?.() || "";
  if (savedAgentKey) {
    const result = await hotkeyManager.registerSlot("agent", savedAgentKey, agentHotkeyCallback);
    if (!result.success) {
      debugLogger.warn("Failed to restore agent hotkey", { hotkey: savedAgentKey }, "hotkey");
    }
  }

  // Set up voice agent hotkey (dictation routed straight to the dictation
  // agent, bypassing cleanup)
  const voiceAgentHotkeyCallback = () => {
    windowManager.sendToggleVoiceAgent();
  };
  windowManager._voiceAgentHotkeyCallback = voiceAgentHotkeyCallback;

  const savedVoiceAgentKey = environmentManager.getVoiceAgentKey?.() || "";
  if (savedVoiceAgentKey) {
    const result = await hotkeyManager.registerSlot(
      "voiceAgent",
      savedVoiceAgentKey,
      voiceAgentHotkeyCallback
    );
    if (!result.success) {
      debugLogger.warn(
        "Failed to restore voice agent hotkey",
        { hotkey: savedVoiceAgentKey },
        "hotkey"
      );
    }
  }

  // Set up meeting mode hotkey
  const meetingHotkeyCallback = () => {
    if (hotkeyManager.isInListeningMode()) return;
    debugLogger.info("Meeting hotkey triggered", {}, "meeting");
    meetingDetectionEngine?.startManualMeeting();
  };

  const savedMeetingKey = environmentManager.getMeetingKey?.() || "";
  if (savedMeetingKey) {
    const result = await hotkeyManager.registerSlot(
      "meeting",
      savedMeetingKey,
      meetingHotkeyCallback
    );
    debugLogger.info(
      "Meeting hotkey startup registration",
      { savedMeetingKey, ...result },
      "meeting"
    );
  }

  ipcMain.handle("register-meeting-hotkey", async (_event, hotkey) => {
    if (hotkey) {
      const result = await hotkeyManager.registerSlot("meeting", hotkey, meetingHotkeyCallback, {
        atomic: true,
      });
      windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        environmentManager.saveMeetingKey(hotkey);
        return { success: true };
      }
      return { success: false, message: result.error };
    } else {
      hotkeyManager.unregisterSlot("meeting");
      environmentManager.saveMeetingKey("");
      windowManager.reconcileNativeKeyListeners();
      return { success: true };
    }
  });

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();

  app.on("browser-window-focus", () => {
    if (googleCalendarManager) googleCalendarManager.syncOnFocus();
  });

  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => {
    if (googleCalendarManager) {
      googleCalendarManager.onWakeFromSleep();
    }
    // Sleep evicts the local GPU model from VRAM; reload it once the driver settles. See #766.
    if (wakeRewarmTimer) clearTimeout(wakeRewarmTimer);
    wakeRewarmTimer = setTimeout(() => {
      wakeRewarmTimer = null;
      whisperManager?.onWakeFromSleep().catch((err) => {
        debugLogger.debug("whisper wake re-warm error (non-fatal)", { error: err.message });
      });
    }, WHISPER_WAKE_REWARM_DELAY_MS);
  });

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

  // TODO: drop legacy REASONING_PROVIDER / LOCAL_REASONING_MODEL fallbacks after 2 releases.
  const cleanupProvider = process.env.CLEANUP_PROVIDER || process.env.REASONING_PROVIDER;
  const cleanupLocalModel = process.env.LOCAL_CLEANUP_MODEL || process.env.LOCAL_REASONING_MODEL;
  if (cleanupProvider === "local" && cleanupLocalModel) {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.prewarmServer(cleanupLocalModel).catch((err) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: err.message });
    });
  }

  if (
    process.env.DICTATION_AGENT_PROVIDER === "local" &&
    process.env.LOCAL_DICTATION_AGENT_MODEL &&
    process.env.LOCAL_DICTATION_AGENT_MODEL !== cleanupLocalModel
  ) {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.prewarmServer(process.env.LOCAL_DICTATION_AGENT_MODEL).catch((err) => {
      debugLogger.debug("dictation-agent llama-server pre-warm error (non-fatal)", {
        error: err.message,
      });
    });
  }

  // Auto-download diarization models if binary is available
  if (
    diarizationManager.getBinaryPath() &&
    (!diarizationManager.isModelDownloaded() || !diarizationManager.isVadModelDownloaded())
  ) {
    diarizationManager.downloadModels().catch((err) => {
      debugLogger.debug("Diarization model auto-download error (non-fatal)", {
        error: err.message,
      });
    });
  }

  const QdrantManager = require("./src/helpers/qdrantManager");
  qdrantManager = new QdrantManager();
  sidecarRegistry.register("qdrant", () => qdrantManager.stop());
  if (qdrantManager.isAvailable()) {
    qdrantManager
      .start()
      .then(() => {
        if (qdrantManager.isReady()) {
          const vectorIndex = require("./src/helpers/vectorIndex");
          vectorIndex.init(qdrantManager.getPort());
          vectorIndex.ensureCollection().catch((err) => {
            debugLogger.debug("Qdrant collection setup error (non-fatal)", { error: err.message });
          });
        }
      })
      .catch((err) => {
        debugLogger.debug("Qdrant startup error (non-fatal)", { error: err.message });
      });
  }

  const localEmbeddings = require("./src/helpers/localEmbeddings");
  if (!localEmbeddings.isAvailable()) {
    localEmbeddings.downloadModel().catch((err) => {
      debugLogger.debug("Embedding model download error (non-fatal)", { error: err.message });
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

  updateManager.checkForUpdatesOnStartup();

  if (process.platform === "darwin") {
    const { isGlobeLikeHotkey, isMouseButtonHotkey } = require("./src/helpers/hotkeyManager");
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

      // Handle dictation if Globe/Fn is one of the dictation hotkeys
      const dictationUsesGlobe = hotkeyManager.getSlotHotkeys("dictation").some(isGlobeLikeHotkey);
      if (dictationUsesGlobe) {
        if (mainWindowLive) {
          // Capture target app PID BEFORE showing the overlay
          if (textEditMonitor) textEditMonitor.captureTargetPid();
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
            windowManager.sendToggleDictation();
          }
        } else {
          debugLogger?.debug("[Globe] Ignored — mainWindow not live");
        }
      }

      // Check agent and voice agent slots for Globe/Fn key
      const agentUsesGlobe = hotkeyManager.getSlotHotkeys("agent").some(isGlobeLikeHotkey);
      const voiceAgentUsesGlobe = hotkeyManager
        .getSlotHotkeys("voiceAgent")
        .some(isGlobeLikeHotkey);
      if (agentUsesGlobe) {
        windowManager.toggleAgentOverlay();
      }
      if (voiceAgentUsesGlobe) {
        windowManager.sendToggleVoiceAgent();
      }
      if (!agentUsesGlobe && !voiceAgentUsesGlobe && !dictationUsesGlobe) {
        debugLogger?.debug("[Globe] Ignored — hotkey is not GLOBE", { currentHotkey });
      }
    });

    globeKeyManager.on("globe-up", async () => {
      debugLogger?.debug("[Globe] globe-up received", { wasRecording: globeKeyIsRecording });

      // Forward to control panel for hotkey capture (Fn key released)
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-released");
      }

      if (hotkeyManager.getSlotHotkeys("dictation").some(isGlobeLikeHotkey)) {
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
    let rightModActiveKey = null;

    globeKeyManager.on("right-modifier-down", async (modifier) => {
      // Check agent and voice agent slots for right-modifier
      if (hotkeyManager.slotHasHotkey("agent", modifier)) {
        windowManager.toggleAgentOverlay();
      }
      if (hotkeyManager.slotHasHotkey("voiceAgent", modifier)) {
        windowManager.sendToggleVoiceAgent();
      }

      if (!hotkeyManager.slotHasHotkey("dictation", modifier)) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (textEditMonitor) textEditMonitor.captureTargetPid();
      if (activationMode === "push") {
        if (rightModActiveKey && rightModActiveKey !== modifier) return;
        const now = Date.now();
        if (now - rightModLastStopTime < POST_STOP_COOLDOWN_MS) return;
        windowManager.showDictationPanel();
        const pressTime = now;
        rightModActiveKey = modifier;
        rightModDownTime = pressTime;
        rightModIsRecording = false;
        setTimeout(() => {
          if (rightModDownTime === pressTime && !rightModIsRecording) {
            rightModIsRecording = true;
            windowManager.sendStartDictation();
          }
        }, MIN_HOLD_DURATION_MS);
      } else {
        windowManager.sendToggleDictation();
      }
    });

    globeKeyManager.on("right-modifier-up", async (modifier) => {
      if (hotkeyManager.slotHasHotkey("dictation", modifier)) {
        if (!isLiveWindow(windowManager.mainWindow)) return;

        const activationMode = windowManager.getActivationMode();
        if (activationMode === "push" && (!rightModActiveKey || rightModActiveKey === modifier)) {
          rightModActiveKey = null;
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

    const syncSuppressedMouseButtons = () => {
      const buttons = [];
      for (const slotName of ["dictation", "agent", "voiceAgent"]) {
        for (const hotkey of hotkeyManager.getSlotHotkeys(slotName)) {
          if (isMouseButtonHotkey(hotkey)) buttons.push(hotkey);
        }
      }
      globeKeyManager.setSuppressedMouseButtons(buttons);
    };

    // Mouse Button 4/5 handling (e.g., Logitech MX Master side buttons)
    let mouseButtonDownTime = 0;
    let mouseButtonIsRecording = false;
    let mouseButtonLastStopTime = 0;
    let mouseButtonActiveButton = null;

    globeKeyManager.on("mouse-button-down", async (button) => {
      if (hotkeyManager.isInListeningMode && hotkeyManager.isInListeningMode()) return;
      if (!isMouseButtonHotkey(button)) return;

      if (hotkeyManager.slotHasHotkey("agent", button)) {
        windowManager.toggleAgentOverlay();
      }
      if (hotkeyManager.slotHasHotkey("voiceAgent", button)) {
        windowManager.sendToggleVoiceAgent();
      }

      if (!hotkeyManager.slotHasHotkey("dictation", button)) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (textEditMonitor) textEditMonitor.captureTargetPid();

      if (activationMode === "push") {
        if (mouseButtonActiveButton && mouseButtonActiveButton !== button) return;
        const now = Date.now();
        if (now - mouseButtonLastStopTime < POST_STOP_COOLDOWN_MS) return;
        windowManager.showDictationPanel();
        const pressTime = now;
        mouseButtonActiveButton = button;
        mouseButtonDownTime = pressTime;
        mouseButtonIsRecording = false;
        setTimeout(() => {
          if (mouseButtonDownTime === pressTime && !mouseButtonIsRecording) {
            mouseButtonIsRecording = true;
            windowManager.sendStartDictation();
          }
        }, MIN_HOLD_DURATION_MS);
      } else {
        windowManager.sendToggleDictation();
      }
    });

    globeKeyManager.on("mouse-button-up", async (button) => {
      if (hotkeyManager.isInListeningMode && hotkeyManager.isInListeningMode()) return;
      if (!isMouseButtonHotkey(button)) return;

      if (!hotkeyManager.slotHasHotkey("dictation", button)) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (
        activationMode === "push" &&
        (!mouseButtonActiveButton || mouseButtonActiveButton === button)
      ) {
        mouseButtonActiveButton = null;
        mouseButtonDownTime = 0;
        mouseButtonLastStopTime = Date.now();
        if (mouseButtonIsRecording) {
          mouseButtonIsRecording = false;
          windowManager.sendStopDictation();
        } else {
          windowManager.hideDictationPanel();
        }
      }
    });

    syncSuppressedMouseButtons();
    globeKeyManager.start();
    hotkeyManager.once("hotkey-loaded", syncSuppressedMouseButtons);

    ipcMain.on("hotkey-listening-mode-changed", (_event, enabled) => {
      if (enabled) {
        globeKeyManager.setSuppressedMouseButtons([]);
      } else {
        syncSuppressedMouseButtons();
      }
    });

    // After starting globe-listener, check if accessibility is granted.
    // If not, notify the control panel so it can prompt the user.
    const checkAndNotifyAccessibility = () => {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        debugLogger.info("[Accessibility] macOS accessibility not trusted — notifying renderers");
        if (isLiveWindow(windowManager.controlPanelWindow)) {
          windowManager.controlPanelWindow.webContents.send("accessibility-missing");
        }
      }
    };

    // Check shortly after startup (give windows time to load)
    setTimeout(checkAndNotifyAccessibility, 3000);

    // Allow renderer to request an accessibility check (e.g. on sign-in).
    // Also sends accessibility-missing events if untrusted.
    ipcMain.handle("check-accessibility-trusted", () => {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        checkAndNotifyAccessibility();
      }
      return trusted;
    });

    // Reset native key state when hotkey changes
    ipcMain.on("hotkey-changed", (_event, _newHotkey) => {
      globeKeyDownTime = 0;
      globeKeyIsRecording = false;
      globeLastStopTime = 0;
      rightModDownTime = 0;
      rightModIsRecording = false;
      rightModLastStopTime = 0;
      mouseButtonDownTime = 0;
      mouseButtonIsRecording = false;
      mouseButtonLastStopTime = 0;
      syncSuppressedMouseButtons();
    });
  }

  // Windows and Linux share the same native low-level key listener model: one hook
  // process per watched key (Electron globalShortcut can't see modifier-only or
  // right-side-modifier combos), routed to the owning slot here. macOS is handled
  // separately above via globeKeyManager.
  if (process.platform === "win32" || process.platform === "linux") {
    const isWindows = process.platform === "win32";
    const nativeKeyManager = isWindows ? windowsKeyManager : linuxKeyManager;
    debugLogger.debug("[Push-to-Talk] Native key listener setup starting");

    // Dictation supports push-to-talk and needs the overlay window; agent/meeting
    // drive other windows (matching their globalShortcut callbacks and macOS).
    const dispatchNativeKeyDown = (key) => {
      if (hotkeyManager.slotHasHotkey("dictation", key)) {
        if (!isLiveWindow(windowManager.mainWindow)) return;
        if (windowManager.getActivationMode() === "push") {
          windowManager.startWindowsPushToTalk(key);
        } else {
          windowManager.sendToggleDictation();
        }
        return;
      }
      if (hotkeyManager.slotHasHotkey("voiceAgent", key)) {
        windowManager.sendToggleVoiceAgent();
      } else if (hotkeyManager.slotHasHotkey("agent", key)) {
        if (!hotkeyManager.isInListeningMode()) windowManager.toggleAgentOverlay();
      } else if (hotkeyManager.slotHasHotkey("meeting", key)) {
        if (!hotkeyManager.isInListeningMode()) meetingDetectionEngine?.startManualMeeting();
      }
    };

    // Only dictation drives push-to-talk, so only its key-up matters.
    const dispatchNativeKeyUp = (key) => {
      if (!hotkeyManager.slotHasHotkey("dictation", key)) return;
      if (windowManager.winPushState?.active) {
        windowManager.handleWindowsPushKeyUp(key);
      } else if (
        isLiveWindow(windowManager.mainWindow) &&
        windowManager.getActivationMode() === "push"
      ) {
        windowManager.handleWindowsPushKeyUp(key);
      }
    };

    nativeKeyManager.on("key-down", dispatchNativeKeyDown);
    nativeKeyManager.on("key-up", dispatchNativeKeyUp);

    nativeKeyManager.on("error", (error) => {
      debugLogger.warn("[Push-to-Talk] Native key listener error", { error: error.message });
      if (isWindows && isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "error",
          message: error.message,
        });
      }
    });

    nativeKeyManager.on("unavailable", () => {
      debugLogger.debug(
        "[Push-to-Talk] Native key listener unavailable - falling back to toggle mode"
      );
      if (isWindows && isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "binary_not_found",
          message: i18nMain.t("windows.pttUnavailable"),
        });
      }
    });

    nativeKeyManager.on("ready", () => {
      debugLogger.debug("[Push-to-Talk] Native key listener ready and listening");
    });

    if (!isWindows) {
      nativeKeyManager.on("permission-denied", () => {
        debugLogger.warn(
          "[Push-to-Talk] Linux key listener has no permission to access input devices"
        );
        if (isLiveWindow(windowManager.mainWindow)) {
          windowManager.mainWindow.webContents.send("linux-ptt-permission-denied");
        }
      });
    }

    const STARTUP_DELAY_MS = 3000;
    setTimeout(() => windowManager.reconcileNativeKeyListeners(), STARTUP_DELAY_MS);

    ipcMain.on("activation-mode-changed", () => {
      windowManager.resetWindowsPushState();
      windowManager.reconcileNativeKeyListeners();
    });

    ipcMain.on("hotkey-changed", () => {
      windowManager.resetWindowsPushState();
      windowManager.reconcileNativeKeyListeners();
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
      if (windowManager.controlPanelWindow.webContents.isCrashed()) {
        windowManager.loadControlPanel();
      }
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
      if (url.includes("upgrade-success")) {
        handleUpgradeDeepLink();
      } else if (isInvitationDeepLink(url)) {
        handleInvitationDeepLink(url);
      } else {
        void handleOAuthDeepLink(url);
      }
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
      if (process.platform === "win32") {
        session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
          // Only the loopback audio track is used; the video source is
          // discarded by the renderer, so skip thumbnail generation.
          desktopCapturer
            .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
            .then((sources) => {
              if (sources.length > 0) {
                callback({ video: sources[0], audio: "loopback" });
              } else {
                callback(null);
              }
            })
            .catch((error) => {
              console.error("Display media request failed:", error);
              callback(null);
            });
        });
      }

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

  let isShuttingDown = false;
  app.on("before-quit", (event) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (updateManager && updateManager.isQuittingForUpdate) {
      // Quit must proceed for the installer to run, so no preventDefault;
      // sidecar shutdown is best-effort (the reaper cleans up orphans on relaunch).
      performSyncTeardown();
      sidecarRegistry.shutdownAll().catch(() => {});
      return;
    }
    event.preventDefault();
    performSyncTeardown();
    sidecarRegistry.shutdownAll().finally(() => app.exit(0));
  });
}

function performSyncTeardown() {
  if (wakeRewarmTimer) {
    clearTimeout(wakeRewarmTimer);
    wakeRewarmTimer = null;
  }
  if (authBridgeServer) {
    authBridgeServer.close();
    authBridgeServer = null;
  }
  if (cliBridge) {
    cliBridge.stop().catch(() => {});
    cliBridge = null;
  }
  if (windowManager && isLiveWindow(windowManager.agentWindow)) {
    windowManager.agentWindow.destroy();
  }
  if (windowManager && isLiveWindow(windowManager.transcriptionPreviewWindow)) {
    windowManager.transcriptionPreviewWindow.destroy();
  }
  if (hotkeyManager) {
    hotkeyManager.unregisterAll();
  } else {
    globalShortcut.unregisterAll();
  }
  if (globeKeyManager) globeKeyManager.stop();
  if (windowsKeyManager) windowsKeyManager.stop();
  if (linuxKeyManager) linuxKeyManager.stop();
  if (meetingDetectionEngine) meetingDetectionEngine.stop();
  if (googleCalendarManager) googleCalendarManager.stop();
  if (audioTapManager) audioTapManager.stop().catch(() => {});
  if (linuxPortalAudioManager) linuxPortalAudioManager.stop().catch(() => {});
  if (windowsLoopbackAudioManager) windowsLoopbackAudioManager.stop().catch(() => {});
  if (meetingAecManager) meetingAecManager.stop().catch(() => {});
  if (ipcHandlers) ipcHandlers._cleanupTextEditMonitor();
  if (textEditMonitor) textEditMonitor.stopMonitoring();
  if (updateManager) updateManager.cleanup();
}
