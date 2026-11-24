const { compareVersions } = require("./parakeetCapability");

const PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

function usesAppControlPicker(systemVersion = process.getSystemVersion?.()) {
  return compareVersions(systemVersion, "27.3") >= 0;
}

module.exports = { PRIVACY_SETTINGS_URL, usesAppControlPicker };
