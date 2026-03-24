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

// Get the electron path
const electronPath = require("electron");

// Get the app directory (parent of scripts directory)
const appDir = path.resolve(__dirname, "..");

// Pass through any command line arguments
const args = process.argv.slice(2);

console.log("[run-electron] Starting Electron with cleaned environment...");
console.log("[run-electron] Electron path:", electronPath);
console.log("[run-electron] App dir:", appDir);
console.log("[run-electron] Args:", args);

// On KDE Wayland, force XWayland so globalShortcut works via X11.
// This must be a command-line flag, not app.commandLine.appendSwitch,
// because Chromium picks the display backend before main.js runs.
const chromiumFlags = [];
if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland" &&
  /kde/i.test(process.env.XDG_CURRENT_DESKTOP || "")
) {
  chromiumFlags.push("--ozone-platform=x11");
  console.log("[run-electron] KDE Wayland detected, forcing XWayland");
}

// Spawn electron with the cleaned environment
const child = spawn(electronPath, [...chromiumFlags, appDir, ...args], {
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
