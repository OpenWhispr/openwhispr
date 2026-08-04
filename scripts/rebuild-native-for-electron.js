#!/usr/bin/env node
"use strict";

/**
 * Rebuild ABI-locked native modules for Electron, reliably.
 *
 * `electron-builder install-app-deps` on its own is NOT sufficient: @electron/rebuild
 * skips a module whose build directory already exists, so after
 * `npm rebuild better-sqlite3` (which the test suite needs, and which produces a
 * Node-ABI binding) it reports "completed installing native dependencies" and
 * changes nothing. The packaged app then dies on launch with
 * "compiled against a different Node.js version".
 *
 * Observed directly: install-app-deps ran to completion and left the binding at
 * NODE_MODULE_VERSION 141 while Electron 41 requires 145.
 *
 * Deleting the stale build directory first forces a real rebuild. Packaging
 * scripts call this instead of install-app-deps; scripts/afterPack.js still
 * asserts the resulting ABI, so a regression here fails the build rather than
 * shipping.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Only modules locked to a specific NODE_MODULE_VERSION. N-API modules
// (onnxruntime-node, @napi-rs/keyring) are ABI-stable and must not be touched.
const ABI_LOCKED_MODULES = ["better-sqlite3"];

function abiOfNativeModule(filePath) {
  const match = fs.readFileSync(filePath).toString("latin1").match(/node_register_module_v(\d+)/);
  return match ? Number(match[1]) : null;
}

function expectedElectronAbi() {
  const electronVersion = require("electron/package.json").version;
  return { electronVersion, abi: Number(require("node-abi").getAbi(electronVersion, "electron")) };
}

function main() {
  const root = path.join(__dirname, "..");

  for (const name of ABI_LOCKED_MODULES) {
    const buildDir = path.join(root, "node_modules", name, "build");
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
      console.log(`[rebuild-native] cleared stale build dir for ${name}`);
    }
  }

  console.log("[rebuild-native] running electron-builder install-app-deps...");
  execFileSync("npx", ["electron-builder", "install-app-deps"], {
    cwd: root,
    stdio: "inherit",
  });

  const { electronVersion, abi } = expectedElectronAbi();
  for (const name of ABI_LOCKED_MODULES) {
    const binding = path.join(root, "node_modules", name, "build", "Release", `${name.replace(/-/g, "_")}.node`);
    if (!fs.existsSync(binding)) {
      throw new Error(`[rebuild-native] ${name}: expected binding at ${binding} after rebuild`);
    }
    const actual = abiOfNativeModule(binding);
    if (actual !== null && actual !== abi) {
      throw new Error(
        `[rebuild-native] ${name} is at NODE_MODULE_VERSION ${actual} but Electron ${electronVersion} needs ${abi}. ` +
          `The rebuild did not take effect.`
      );
    }
    console.log(`[rebuild-native] ${name} OK — ABI ${actual} matches Electron ${electronVersion}`);
  }
}

main();
