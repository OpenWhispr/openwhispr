// Main-process wiring for Titanium sign-in: one TitaniumSession per app, IPC for the
// renderer, and a broadcast whenever the state changes.
const path = require("path");
const { app, ipcMain, shell, safeStorage, BrowserWindow } = require("electron");
const { TitaniumSession } = require("./titaniumSession");

let session = null;
const stateListeners = new Set();

// Main-process subscribers to sign-in / sign-out / account changes (e.g. to drop
// connections opened under the previous license). Returns an unsubscribe.
function onTitaniumStateChanged(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function notifyTitaniumStateChanged(state) {
  for (const listener of [...stateListeners]) {
    try {
      listener(state);
    } catch {
      // A failing subscriber must not stop the others or the broadcast.
    }
  }
}

function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(text);
}

function decrypt(buffer) {
  return safeStorage.decryptString(buffer);
}

function broadcast(state) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("titanium-auth-changed", state);
  }
}

function initTitaniumAuth({ forkConfig, urlScheme, logger }) {
  if (session) return session;
  session = new TitaniumSession({
    config: forkConfig.TITANIUM,
    // The registered protocol for this channel (titaniumwhisper, -dev, -staging).
    urlScheme,
    filePath: path.join(app.getPath("userData"), "titanium-session.bin"),
    encrypt,
    decrypt,
    openExternal: (url) => shell.openExternal(url),
    logger,
  });
  session.load();
  session.on("changed", (state) => {
    broadcast(state);
    notifyTitaniumStateChanged(state);
  });

  ipcMain.handle("titanium-auth-get-state", () => session.getState());
  ipcMain.handle("titanium-auth-sign-in", async () => {
    try {
      return await session.startSignIn();
    } catch (error) {
      return { started: false, error: error?.message || "sign_in_unavailable" };
    }
  });
  ipcMain.handle("titanium-auth-sign-out", () => session.signOut());
  ipcMain.handle("titanium-service-key", (_event, url) => titaniumServiceKeyFor(url));
  return session;
}

function getTitaniumSession() {
  return session;
}

// The origin (scheme + host + port) of an https URL with no userinfo, else "".
// Anything else (http, ftp, userinfo tricks, unparsable) can never be one of
// our service origins.
function httpsOriginOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

/**
 * The signed-in user's license key, but only for an https request whose exact
 * origin (scheme + host + port) equals the origin of the fork's default STT
 * endpoint, SERVICES_URL, or a TITANIUM.serviceHosts entry (a bare host, taken
 * as https on the default port). A configured origin that is not itself https
 * (e.g. an http override) allows nothing. A Custom endpoint the user points
 * elsewhere never receives the Titanium credential.
 */
// The allowlist comes from the shipped fork.config.json, never from runtime
// VITE_* overrides: an overridden SERVICES_URL still receives requests, but
// never the license key.
function titaniumServiceKeyFor(url, forkConfig = require("../../config/fork.config.json")) {
  if (!session) return null;
  const requested = httpsOriginOf(url);
  if (!requested) return null;
  const allowed = new Set(
    [
      httpsOriginOf(forkConfig.DEFAULT_STT?.baseUrl),
      httpsOriginOf(forkConfig.SERVICES_URL),
      ...(forkConfig.TITANIUM?.serviceHosts || []).map((host) =>
        /^[a-z0-9.-]+$/i.test(String(host || "")) ? httpsOriginOf(`https://${host}`) : ""
      ),
    ].filter(Boolean)
  );
  return allowed.has(requested) ? session.getLicenseKey() : null;
}

function _setSessionForTest(value) {
  session = value;
}

module.exports = {
  initTitaniumAuth,
  getTitaniumSession,
  titaniumServiceKeyFor,
  onTitaniumStateChanged,
  notifyTitaniumStateChanged,
  _setSessionForTest,
};
