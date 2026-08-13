// Launch at login, for ipcHandlers.js and main.js. setLoginItemSettings covers
// macOS and Windows; on Linux it does nothing, so an XDG autostart entry stands in
// (linuxAutostart.js). Decisions live in autoStartPolicy.js.

const { app } = require("electron");
const linuxAutostart = require("./linuxAutostart");
const {
  getLoginItemArgs,
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
} = require("./autoStartPolicy");

const isLinux = () => process.platform === "linux";

function readLoginItemSettings() {
  return app.getLoginItemSettings({ args: getLoginItemArgs(process.platform) });
}

function writeLoginItem(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: getLoginItemArgs(process.platform),
  });
}

// { enabled, requiresApproval } — requiresApproval is macOS-only.
function getAutoStartState() {
  if (isLinux()) {
    return { enabled: linuxAutostart.isAutostartEnabled(), requiresApproval: false };
  }
  return resolveAutoStartState({
    platform: process.platform,
    loginItemSettings: readLoginItemSettings(),
  });
}

function setAutoStartEnabled(enabled) {
  if (isLinux()) {
    linuxAutostart.setAutostartEnabled(enabled);
    return;
  }
  writeLoginItem(enabled);
}

function wasLaunchedAtLoginHidden() {
  return wasLaunchedHidden({
    platform: process.platform,
    argv: process.argv,
    loginItemSettings: process.platform === "darwin" ? app.getLoginItemSettings() : null,
  });
}

// Repairs an entry that still exists but no longer starts this executable, or
// starts it without the flag that sends it to the tray. True when it rewrote one.
function syncAutoStartEntry() {
  if (isLinux()) return linuxAutostart.syncAutostartEntry();

  const loginItemSettings = readLoginItemSettings();
  if (!needsHiddenFlagMigration({ platform: process.platform, loginItemSettings })) return false;

  writeLoginItem(true);
  return true;
}

module.exports = {
  getAutoStartState,
  setAutoStartEnabled,
  wasLaunchedAtLoginHidden,
  syncAutoStartEntry,
};
