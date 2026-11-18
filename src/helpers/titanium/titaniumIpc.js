// Main-process wiring for Titanium sign-in: one TitaniumSession per app, IPC for the
// renderer, and a broadcast whenever the state changes.
const path = require("path");
const { app, ipcMain, shell, safeStorage, BrowserWindow } = require("electron");
const { TitaniumSession } = require("./titaniumSession");
const { isTitaniumServiceUrl } = require("./titaniumHosts");

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

/**
 * The signed-in user's license key, but only for a request to one of our own
 * services (the fork's default STT host, plus TITANIUM.serviceHosts). A Custom
 * endpoint the user points elsewhere never receives the Titanium credential.
 */
function titaniumServiceKeyFor(url, forkConfig = require("../../config/forkConfig")) {
  if (!session || !isTitaniumServiceUrl(url, forkConfig)) return null;
  return session.getLicenseKey();
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
