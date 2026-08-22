function isAllowedAppNavigation(url, appUrl) {
  if (url.startsWith("devtools://")) return true;
  if (!appUrl) return false;

  try {
    const candidate = new URL(url);
    const app = new URL(appUrl);
    return candidate.origin === app.origin && candidate.pathname === app.pathname;
  } catch {
    return false;
  }
}

module.exports = { isAllowedAppNavigation };
