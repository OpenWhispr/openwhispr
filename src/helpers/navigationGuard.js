// will-navigate also fires for renderer-initiated location.reload() with the
// window's own URL (appUrl), so that URL must stay allowed.
function isAllowedAppNavigation(url, appUrl) {
  if (url.startsWith("devtools://")) return true;
  if (!appUrl) return false;

  try {
    const candidate = new URL(url);
    const app = new URL(appUrl);
    // file:// URLs all share the opaque "null" origin, so protocol and
    // pathname carry the comparison there.
    return (
      candidate.origin === app.origin &&
      candidate.protocol === app.protocol &&
      candidate.pathname === app.pathname
    );
  } catch {
    return false;
  }
}

function isExternalBrowserUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

module.exports = { isAllowedAppNavigation, isExternalBrowserUrl };
