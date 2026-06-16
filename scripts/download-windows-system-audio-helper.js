#!/usr/bin/env node
/**
 * Downloads prebuilt Windows system audio helper binary from GitHub releases.
 * Used for WASAPI process-loopback system audio capture in meeting notes.
 *
 * Usage:
 *   node scripts/download-windows-system-audio-helper.js [--force]
 *
 * Options:
 *   --force    Re-download even if binary already exists
 */

const fs = require("fs");
const path = require("path");
const {
  downloadFile,
  extractZip,
  fetchLatestRelease,
  setExecutable,
} = require("./lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const TAG_PREFIX = "windows-system-audio-helper-v";
const ZIP_NAME = "windows-system-audio-helper-win32-x64.zip";
const BINARY_NAME = "windows-system-audio-helper.exe";

// Version can be pinned via environment variable for reproducible builds
const VERSION_OVERRIDE = process.env.WINDOWS_SYSTEM_AUDIO_HELPER_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

async function main() {
  // Only needed on Windows
  if (process.platform !== "win32") {
    console.log("[windows-system-audio-helper] Skipping download (not Windows)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  // Check if already exists
  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[windows-system-audio-helper] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  // Fetch release (pinned version or latest)
  if (VERSION_OVERRIDE) {
    console.log(`\n[windows-system-audio-helper] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[windows-system-audio-helper] Fetching latest release...");
  }
  const release = await fetchLatestRelease(
    REPO,
    VERSION_OVERRIDE ? { tag: VERSION_OVERRIDE } : { tagPrefix: TAG_PREFIX }
  );

  if (!release) {
    console.error(
      "[windows-system-audio-helper] Could not find a release matching:",
      VERSION_OVERRIDE || TAG_PREFIX
    );
    console.log(
      "[windows-system-audio-helper] Meeting system audio will use Chromium loopback fallback"
    );
    return;
  }

  // Find the zip asset
  const zipAsset = release.assets.find((a) => a.name === ZIP_NAME);
  if (!zipAsset) {
    console.error(
      `[windows-system-audio-helper] Release ${release.tag} does not contain ${ZIP_NAME}`
    );
    console.log(
      "[windows-system-audio-helper] Available assets:",
      release.assets.map((a) => a.name).join(", ")
    );
    return;
  }

  console.log(`\nDownloading Windows system audio helper (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const zipPath = path.join(BIN_DIR, ZIP_NAME);
  console.log(`  Downloading from: ${zipAsset.url}`);

  try {
    await downloadFile(zipAsset.url, zipPath);

    // Extract zip
    const extractDir = path.join(BIN_DIR, "temp-windows-system-audio-helper");
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractZip(zipPath, extractDir);

    // Find and copy the binary
    const binaryPath = path.join(extractDir, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${BINARY_NAME}`);
    } else {
      throw new Error(`Binary not found in archive: ${BINARY_NAME}`);
    }

    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    const stats = fs.statSync(outputPath);
    console.log(
      `\n[windows-system-audio-helper] Successfully downloaded ${release.tag} (${Math.round(stats.size / 1024)}KB)`
    );
  } catch (error) {
    console.error(`\n[windows-system-audio-helper] Download failed: ${error.message}`);

    // Cleanup on failure
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    // Don't fail the build — meeting capture falls back to Chromium loopback
    console.log(
      "[windows-system-audio-helper] Meeting system audio will use Chromium loopback fallback"
    );
    console.log(
      "[windows-system-audio-helper] To compile locally, install Visual Studio Build Tools or MinGW-w64"
    );
  }
}

main().catch((error) => {
  console.error("[windows-system-audio-helper] Unexpected error:", error);
  // Don't fail the build
});
