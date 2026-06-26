#!/usr/bin/env node
/**
 * Wrapper script to run Electron with proper environment.
 * This unsets ELECTRON_RUN_AS_NODE which can be inherited from parent processes
 * (e.g., when running from Claude Code or other Node.js-based tools).
 */

const { spawn } = require("child_process");
const path = require("path");

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

// On KDE/GNOME Wayland, force XWayland so globalShortcut and window positioning work.
// Adding it here avoids the self-relaunch in main.js which kills concurrently in dev mode.
if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland" &&
  !args.includes("--ozone-platform=x11")
) {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase();
  if (desktop.includes("kde") || /gnome|ubuntu|unity/.test(desktop)) {
    args.push("--ozone-platform=x11");
    console.log("[run-electron] KDE/GNOME Wayland detected, forcing XWayland");
  }
}

// Chromium flags must come before the app path, app args after.
const chromiumFlags = args.filter((a) => a.startsWith("--ozone-platform="));
const appArgs = args.filter((a) => !a.startsWith("--ozone-platform="));
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
