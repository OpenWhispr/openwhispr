#!/usr/bin/env node
/**
 * Downloads prebuilt Windows mic listener binary from GitHub releases.
 * Used for microphone activity detection on Windows.
 *
 * Usage:
 *   node scripts/download-windows-mic-listener.js [--force]
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
const TAG_PREFIX = "windows-mic-listener-v";
const ZIP_NAME = "windows-mic-listener-win32-x64.zip";
const BINARY_NAME = "windows-mic-listener.exe";

// Version can be pinned via environment variable for reproducible builds
const VERSION_OVERRIDE = process.env.WINDOWS_MIC_LISTENER_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

async function main() {
  // Only needed on Windows
  if (process.platform !== "win32") {
    console.log("[windows-mic-listener] Skipping download (not Windows)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  // Check if already exists
  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[windows-mic-listener] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  // Fetch release (pinned version or latest)
  if (VERSION_OVERRIDE) {
    console.log(`\n[windows-mic-listener] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[windows-mic-listener] Fetching latest release...");
  }
  const tagToFind = VERSION_OVERRIDE || TAG_PREFIX;
  const release = await fetchLatestRelease(REPO, { tagPrefix: tagToFind });

  if (!release) {
    console.error("[windows-mic-listener] Could not find a release matching prefix:", TAG_PREFIX);
    console.log(
      "[windows-mic-listener] Mic detection will use fallback mode (polling)"
    );
    return;
  }

  // Find the zip asset
  const zipAsset = release.assets.find((a) => a.name === ZIP_NAME);
  if (!zipAsset) {
    console.error(`[windows-mic-listener] Release ${release.tag} does not contain ${ZIP_NAME}`);
    console.log(
      "[windows-mic-listener] Available assets:",
      release.assets.map((a) => a.name).join(", ")
    );
    return;
  }

  console.log(`\nDownloading Windows mic listener (${release.tag})...\n`);

  // Ensure bin directory exists
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const zipPath = path.join(BIN_DIR, ZIP_NAME);
  console.log(`  Downloading from: ${zipAsset.url}`);

  try {
    await downloadFile(zipAsset.url, zipPath);

    // Extract zip
    const extractDir = path.join(BIN_DIR, "temp-windows-mic-listener");
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
      `\n[windows-mic-listener] Successfully downloaded ${release.tag} (${Math.round(stats.size / 1024)}KB)`
    );
  } catch (error) {
    console.error(`\n[windows-mic-listener] Download failed: ${error.message}`);

    // Cleanup on failure
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    // Don't fail the build — mic detection can fall back to polling
    console.log(
      "[windows-mic-listener] Mic detection will use fallback mode (polling)"
    );
    console.log(
      "[windows-mic-listener] To compile locally, install Visual Studio Build Tools or MinGW-w64"
    );
  }
}

main().catch((error) => {
  console.error("[windows-mic-listener] Unexpected error:", error);
  // Don't fail the build
});
