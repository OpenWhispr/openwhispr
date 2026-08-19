// Gate logic for the auto-install-on-quit updater setting (UPDATE_AUTO_INSTALL).

// Only an explicit "false" disables auto-install; anything else keeps the
// historical default of installing on quit.
function parseAutoInstallEnv(raw) {
  return raw !== "false";
}

// electron-updater registers its quit hook only when a download finishes with
// the flag on, so re-enabling after a gated download must re-register it.
function shouldRegisterQuitHandler(enabled, updateDownloaded) {
  return enabled === true && updateDownloaded === true;
}

module.exports = { parseAutoInstallEnv, shouldRegisterQuitHandler };
