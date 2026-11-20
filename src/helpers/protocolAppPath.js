const path = require("path");

// The app path a development protocol handler passes to Electron. Chromium
// flags can come before it (scripts/run-electron.js puts --ozone-platform=x11
// there on Wayland), so it is the first argument after the executable that
// isn't a flag, not argv[1].
function resolveProtocolAppPath(argv, cwd = process.cwd()) {
  const appPath = argv.slice(1).find((arg) => typeof arg === "string" && !arg.startsWith("-"));
  return path.resolve(cwd, appPath || ".");
}

module.exports = { resolveProtocolAppPath };
