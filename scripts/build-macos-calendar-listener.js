#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

// Dev Electron ships without calendar usage strings; without them the TCC
// request from the spawned helper aborts. Patch the dev app bundle once and
// re-ad-hoc-sign it. Packaged builds get the strings via electron-builder's
// mac.extendInfo instead.
function patchDevElectronPlist({ projectRoot, log }) {
  const electronApp = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");
  const plistPath = path.join(electronApp, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) return;

  const usage =
    "OpenWhispr reads your calendar to detect upcoming meetings and link meeting notes to events.";
  const keys = ["NSCalendarsUsageDescription", "NSCalendarsFullAccessUsageDescription"];
  const missing = keys.filter(
    (key) => spawnSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath]).status !== 0
  );
  if (missing.length === 0) return;

  for (const key of missing) {
    const result = spawnSync("plutil", ["-insert", key, "-string", usage, plistPath]);
    if (result.status !== 0) {
      log(`Warning: failed to insert ${key} into dev Electron Info.plist`);
      return;
    }
  }

  const signResult = spawnSync("codesign", ["--force", "--sign", "-", electronApp]);
  if (signResult.status !== 0) {
    log("Warning: failed to re-sign dev Electron after Info.plist patch");
    return;
  }
  log("Patched dev Electron Info.plist with calendar usage strings and re-signed the bundle.");
  log(
    "NOTE: re-signing changes dev Electron's code hash, so macOS drops its previously granted " +
      "permissions (Accessibility, Microphone, Screen & System Audio Recording). Re-grant them " +
      "in System Settings > Privacy & Security when prompted."
  );
}

buildMacosSwiftBinary({
  label: "calendar-listener",
  sourceName: "macos-calendar-listener.swift",
  binaryName: "macos-calendar-listener",
  frameworks: ["EventKit", "Foundation"],
  beforeBuild: patchDevElectronPlist,
});
