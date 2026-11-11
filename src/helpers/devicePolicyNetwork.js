function isLoopback(url) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
}

function devicePolicyNetworkAllowed(snapshot, target, controlOrigins = []) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || isLoopback(url)) return true;
  if (!snapshot.deviceReady || snapshot.code === "DEVICE_POLICY_INVALID" || snapshot.localOnly)
    return false;
  // A device policy that can't be met yet (sign-in required, or no workspace
  // verdict) leaves only the control plane. A workspace's own policy is the
  // product gates' to apply, and a verdict still loading stops nothing.
  if (snapshot.status === "error" && snapshot.deviceManaged) {
    return (
      controlOrigins.includes(url.origin) &&
      (url.pathname.startsWith("/api/auth/") ||
        url.pathname === "/api/check-user" ||
        url.pathname === "/api/workspace-policy")
    );
  }
  return true;
}

function installManagedNetworkGuard({ app, session, isAllowed }) {
  const assetSession = require("./downloadUtils").getAssetDownloadSession();
  const updateSession = session.fromPartition("electron-updater", { cache: false });
  const sessions = new Set();
  const guard = (target) => {
    if (target === assetSession || target === updateSession) return;
    sessions.add(target);
    const filter = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
    target.webRequest.onBeforeRequest(filter, (details, callback) =>
      callback({ cancel: !isAllowed(details.url) })
    );
    target.webRequest.onHeadersReceived(filter, (details, callback) =>
      callback({ cancel: !isAllowed(details.url) })
    );
  };
  guard(session.defaultSession);
  app.on("session-created", guard);
  return () => {
    app.removeListener("session-created", guard);
    for (const target of sessions) {
      target.webRequest.onBeforeRequest(null);
      target.webRequest.onHeadersReceived(null);
    }
  };
}

module.exports = { devicePolicyNetworkAllowed, installManagedNetworkGuard };
