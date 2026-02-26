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

// Spawn electron with the cleaned environment
const child = spawn(electronPath, [appDir, ...args], {
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
