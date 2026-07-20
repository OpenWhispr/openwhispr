#!/usr/bin/env node
/**
 * Ensures platform-specific sidecar binaries are present for local development.
 *
 * Production builds pull these via prebuild:* hooks; predev only ran compile:native
 * before, so Windows dev was missing nircmd (paste fallback + submit-after-paste).
 * Each download script no-ops when the binary already exists.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

// Invoke download scripts directly — nested `npm run` via spawnSync breaks on Windows
// (spawnSync npm.cmd → EINVAL on Node 20+).
const PLATFORM_SCRIPTS = {
  win32: [
    ["download-nircmd.js"],
    ["download-sherpa-onnx.js", "--current"],
  ],
};

function runNodeScript(scriptName, args = []) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(
      `[ensure-dev-binaries] Failed to run ${scriptName}: ${result.error.message}`
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const scripts = PLATFORM_SCRIPTS[process.platform];
if (!scripts?.length) {
  process.exit(0);
}

console.log(`\n[ensure-dev-binaries] Checking ${process.platform} dev sidecars...\n`);
for (const [scriptName, ...args] of scripts) {
  runNodeScript(scriptName, args);
}
