const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

// Resolves a bundled helper binary across the dev layout (resources/) and the
// packaged layouts (process.resourcesPath, asar-unpacked). Returns null when
// no executable candidate exists so callers can fall back gracefully.
function resolveBundledBinary(binaryName, logContext) {
  const candidates = [
    path.join(__dirname, "..", "..", "resources", "bin", binaryName),
    path.join(__dirname, "..", "..", "resources", binaryName),
  ];

  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, binaryName),
      path.join(process.resourcesPath, "bin", binaryName),
      path.join(process.resourcesPath, "resources", "bin", binaryName),
      path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName)
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        debugLogger.info("Resolved binary", { name: binaryName, path: candidate }, logContext);
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

module.exports = { resolveBundledBinary };
