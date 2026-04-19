#!/usr/bin/env node

// macOS uses a native Swift binary compiled from resources/macos-text-monitor.swift.
// Linux uses a native C binary compiled from resources/linux-text-monitor.c.
// Windows uses a prebuilt binary downloaded from GitHub releases (or compiled locally).
const path = require("path");
const { execFileSync } = require("child_process");

const scripts = {
  darwin: "build-macos-text-monitor.js",
  linux: "build-linux-text-monitor.js",
  win32: "build-windows-text-monitor.js",
};

const script = scripts[process.platform];
if (script) {
  execFileSync("node", [path.join(__dirname, script)], { stdio: "inherit" });
}
