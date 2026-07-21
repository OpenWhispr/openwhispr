#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

const projectRoot = path.resolve(__dirname, "..");

// Dev builds are launched from a terminal, so macOS attributes the helper's
// calendar permission request to the terminal app, which lacks calendar usage
// strings — the TCC prompt is silently aborted. The manager therefore spawns
// the helper through this shim in dev, disclaiming responsibility so the
// helper's embedded Info.plist usage strings apply. Packaged builds are
// self-responsible (usage strings via electron-builder's mac.extendInfo) and
// don't use the shim, so it is not in the electron-builder bin filter.
function buildDisclaimShim() {
  if (process.platform !== "darwin") return;

  const source = path.join(projectRoot, "resources", "macos-disclaim-exec.c");
  const output = path.join(projectRoot, "resources", "bin", "macos-disclaim-exec");
  try {
    if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
      return;
    }
  } catch {
    // fall through to rebuild
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync("cc", ["-O2", "-o", output, source], { stdio: "inherit" });
  if (result.status !== 0) {
    console.warn(
      "[calendar-listener] Warning: failed to compile macos-disclaim-exec; " +
        "calendar permission prompts will not work in dev."
    );
    return;
  }
  try {
    fs.chmodSync(output, 0o755);
  } catch (error) {
    console.warn(`[calendar-listener] Unable to set shim permissions: ${error.message}`);
  }
  console.log("[calendar-listener] Built macos-disclaim-exec.");
}

buildDisclaimShim();

buildMacosSwiftBinary({
  label: "calendar-listener",
  sourceName: "macos-calendar-listener.swift",
  binaryName: "macos-calendar-listener",
  frameworks: ["EventKit", "Foundation"],
  linkerInfoPlist: path.join(projectRoot, "resources", "macos-calendar-listener-Info.plist"),
});
