const { compareVersions } = require("./parakeetCapability");

const PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

// macOS 27.3 grants app control by picking the app from a list, replacing the
// drag into Accessibility. Callers check for macOS first: other platforms
// report unrelated version numbers.
function usesAppControlPicker(systemVersion = process.getSystemVersion?.()) {
  return compareVersions(systemVersion, "27.3") >= 0;
}

module.exports = { PRIVACY_SETTINGS_URL, usesAppControlPicker };
