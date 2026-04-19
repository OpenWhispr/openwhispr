#!/usr/bin/env node
// Compiles src/assets/openwhispr.icon (Apple Icon Composer bundle) into
// src/assets/Assets.car so macOS 26+ can render Liquid Glass layers.
// The legacy src/assets/icon.icns is maintained separately for macOS <26.
//
// Skips gracefully when not running on macOS or when Xcode's actool is
// unavailable — CI runners without full Xcode will simply fall back to the
// existing .icns.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ICON_BUNDLE = path.join(__dirname, "..", "src", "assets", "openwhispr.icon");
const OUTPUT_CAR = path.join(__dirname, "..", "src", "assets", "Assets.car");
const APP_ICON_NAME = "openwhispr";

if (process.platform !== "darwin") {
  console.log("compile-macos-icon: not macOS, skipping");
  process.exit(0);
}

if (!fs.existsSync(ICON_BUNDLE)) {
  console.log(`compile-macos-icon: ${ICON_BUNDLE} not found, skipping`);
  process.exit(0);
}

const actoolLookup = spawnSync("xcrun", ["--find", "actool"], { encoding: "utf8" });
if (actoolLookup.status !== 0) {
  console.warn(
    "compile-macos-icon: actool unavailable (requires full Xcode, not just CLT). " +
      "Existing icon.icns will be used as legacy fallback; no Liquid Glass on macOS 26+."
  );
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-icon-"));
try {
  execFileSync(
    "xcrun",
    [
      "actool",
      ICON_BUNDLE,
      "--compile",
      tmpDir,
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      "12.0",
      "--app-icon",
      APP_ICON_NAME,
      "--output-partial-info-plist",
      path.join(tmpDir, "plist.plist"),
      "--include-all-app-icons",
    ],
    { stdio: "inherit" }
  );

  const producedCar = path.join(tmpDir, "Assets.car");
  if (!fs.existsSync(producedCar)) {
    console.warn(
      "compile-macos-icon: actool ran but did not emit Assets.car " +
        "(likely a partial Xcode install on the runner). " +
        "Falling back to icon.icns; no Liquid Glass on macOS 26+."
    );
    return;
  }

  fs.copyFileSync(producedCar, OUTPUT_CAR);
  const bytes = fs.statSync(OUTPUT_CAR).size;
  console.log(`compile-macos-icon: wrote ${OUTPUT_CAR} (${bytes} bytes)`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
