const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

class ContextCaptureManager {
  constructor() {
    this.isSupported = process.platform === "darwin";
  }

  captureContext() {
    if (!this.isSupported) {
      return null;
    }

    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      debugLogger.info("[ContextCapture] Binary not found in any candidate path");
      return null;
    }

    try {
      const result = spawnSync(binaryPath, [], { timeout: 500 });

      if (result.error || (result.status !== 0 && result.status !== 2)) {
        debugLogger.info("[ContextCapture] Capture failed", {
          error: result.error?.message,
          status: result.status,
        });
        return null;
      }

      const stdout = result.stdout?.toString().trim();
      if (!stdout) {
        return null;
      }

      const parsed = JSON.parse(stdout);
      debugLogger.info("[ContextCapture] Context captured", {
        bundleId: parsed.bundleId,
        appName: parsed.appName,
      });
      return parsed;
    } catch (err) {
      debugLogger.info("[ContextCapture] Parse or execution error", { error: err.message });
      return null;
    }
  }

  resolveBinary() {
    const binaryName = "macos-context-capture";

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = ContextCaptureManager;
