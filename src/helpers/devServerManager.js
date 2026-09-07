const DEFAULT_DEV_SERVER_PORT = 5183;
const parseDevServerPort = () => {
  const raw =
    process.env.OPENWHISPR_DEV_SERVER_PORT ||
    process.env.VITE_DEV_SERVER_PORT ||
    String(DEFAULT_DEV_SERVER_PORT);
  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_DEV_SERVER_PORT;
  }

  return parsed;
};

const DEV_SERVER_PORT = parseDevServerPort();
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}/`;

class DevServerManager {
  static async waitForDevServer(url = DEV_SERVER_URL, maxAttempts = 30, delay = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const http = require("http");
        const urlObj = new URL(url);

        const result = await new Promise((resolve) => {
          const req = http.get(
            {
              hostname: urlObj.hostname,
              port: urlObj.port || 80,
              path: urlObj.pathname,
              timeout: 2000,
            },
            (res) => {
              resolve(res.statusCode >= 200 && res.statusCode < 400);
            }
          );

          req.on("error", () => resolve(false));
          req.on("timeout", () => {
            req.destroy();
            resolve(false);
          });
        });

        if (result) {
          return true;
        }
      } catch {
        // Dev server not ready yet, continue waiting
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
  }

  static getAppUrl(isControlPanel = false) {
    if (process.env.NODE_ENV === "development") {
      return isControlPanel ? `${DEV_SERVER_URL}?panel=true` : DEV_SERVER_URL;
    } else {
      // For production, return null - caller should use loadFile() instead
      return null;
    }
  }

  /**
   * Get the path to the index.html file for production builds.
   * In Electron 36+, loadFile() is preferred over loadURL() with file:// protocol.
   * @param {boolean} isControlPanel - Whether this is for the control panel
   * @returns {{ path: string, query: object } | null} - Path info for loadFile() or null for dev
   */
  static getAppFilePath(isControlPanel = false) {
    if (process.env.NODE_ENV === "development") {
      return null; // Use getAppUrl() for dev server
    }

    const path = require("path");
    const { app } = require("electron");

    // In packaged app, files are relative to app.getAppPath()
    const appPath = app.getAppPath();
    const htmlPath = path.join(appPath, "src", "dist", "index.html");

    return {
      path: htmlPath,
      query: isControlPanel ? { panel: "true" } : {},
    };
  }
}

module.exports = DevServerManager;
module.exports.DEV_SERVER_PORT = DEV_SERVER_PORT;
module.exports.DEV_SERVER_URL = DEV_SERVER_URL;
