const { pathToFileURL } = require("url");

// will-navigate policy for app windows. `appUrl` is where the window's content
// is served from: the dev-server URL in development, the packaged index.html
// file URL in production. The query string is deliberately ignored —
// location.reload() re-fires will-navigate with the window's own URL including
// whatever query loadFile()/loadURL() attached (e.g. ?panel=true), and blocking
// it would break sign-out, onboarding restart, and the ErrorBoundary reload.
function isAllowedAppNavigation(url, appUrl) {
  // Fail closed on any surprise: a throw here would leave preventDefault
  // unreached and reopen the fail-open hole this guard exists to fix.
  try {
    if (url.startsWith("devtools://")) {
      return true;
    }
    if (!appUrl) {
      return false;
    }
    const candidate = new URL(url);
    const app = new URL(appUrl);
    return (
      candidate.protocol === app.protocol &&
      candidate.host === app.host &&
      candidate.pathname === app.pathname
    );
  } catch {
    return false;
  }
}

function resolveAppNavigationUrl({ devServerUrl, appFilePath }) {
  if (devServerUrl) {
    return devServerUrl;
  }
  if (appFilePath) {
    return pathToFileURL(appFilePath).href;
  }
  return null;
}

module.exports = { isAllowedAppNavigation, resolveAppNavigationUrl };
