#!/usr/bin/env node
/**
 * Wrapper script to run Electron with proper environment.
 * This unsets ELECTRON_RUN_AS_NODE which can be inherited from parent processes
 * (e.g., when running from Claude Code or other Node.js-based tools).
 */

const { spawn } = require("child_process");
const path = require("path");
const {
  OZONE_PLATFORM_PREFIX,
  XWAYLAND_FLAG,
  shouldForceXWayland,
} = require("../src/helpers/xwayland");

// Remove ELECTRON_RUN_AS_NODE from environment
delete process.env.ELECTRON_RUN_AS_NODE;

// Get the app directory (parent of scripts directory)
const appDir = path.resolve(__dirname, "..");

function resolveElectronPath() {
  try {
    return require("electron");
  } catch (err) {
    console.error(
      "[run-electron] Electron is installed as an npm package, but its platform binary is missing."
    );
    console.error(
      "[run-electron] This usually means npm lifecycle scripts were skipped or the Electron download failed."
    );
    if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
      console.error(
        "[run-electron] ELECTRON_SKIP_BINARY_DOWNLOAD is set; unset it before reinstalling Electron."
      );
    }
    console.error(
      "[run-electron] Try: npm config set ignore-scripts false && npm rebuild electron"
    );
    console.error(
      "[run-electron] If that still fails, remove node_modules and run npm install again."
    );
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

// Get the electron path
const electronPath = resolveElectronPath();

// Pass through any command line arguments
const args = process.argv.slice(2);

console.log("[run-electron] Starting Electron with cleaned environment...");
console.log("[run-electron] Electron path:", electronPath);
console.log("[run-electron] App dir:", appDir);
console.log("[run-electron] Args:", args);

// Adding the flag here avoids the self-relaunch in main.js, which kills concurrently in dev mode.
if (shouldForceXWayland(args)) {
  args.push(XWAYLAND_FLAG);
  console.log("[run-electron] Wayland detected, forcing XWayland");
}

// Chromium flags must come before the app path, app args after.
const chromiumFlags = args.filter((a) => a.startsWith(OZONE_PLATFORM_PREFIX));
const appArgs = args.filter((a) => !a.startsWith(OZONE_PLATFORM_PREFIX));
const child = spawn(electronPath, [...chromiumFlags, appDir, ...appArgs], {
  stdio: "inherit",
  env: process.env,
  cwd: appDir,
});

child.on("close", (code) => {
  process.exit(code || 0);
});

child.on("error", (err) => {
  console.error("[run-electron] Failed to start Electron:", err);
  process.exit(1);
});
