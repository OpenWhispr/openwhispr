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
 *
 * The release tag is pinned to MIC_LISTENER_VERSION in the C source (override
 * with the WINDOWS_MIC_LISTENER_VERSION env var). In CI a failed download
 * fails the job; locally it falls back to polling mode.
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
const SOURCE_FILE = path.join(__dirname, "..", "resources", "windows-mic-listener.c");

// Full tag override via environment variable (e.g. windows-mic-listener-v1.1.0)
const VERSION_OVERRIDE = process.env.WINDOWS_MIC_LISTENER_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

// The C source's MIC_LISTENER_VERSION is the single source of truth for which
// release tag matches this checkout, so a build can never silently pick up a
// binary published from older source (the publisher workflow tags from the
// same constant).
function readPinnedTag() {
  const source = fs.readFileSync(SOURCE_FILE, "utf8");
  const match = source.match(/MIC_LISTENER_VERSION "([0-9.]+)"/);
  if (!match) {
    throw new Error(`MIC_LISTENER_VERSION not found in ${SOURCE_FILE}`);
  }
  return `${TAG_PREFIX}${match[1]}`;
}

// CI must never fall back to polling silently — a missing pinned release means
// the publisher workflow has not finished (or failed) and the job should retry
// instead of baking a stale or absent binary into the build cache.
function failDownload(message) {
  console.error(`[windows-mic-listener] ${message}`);
  if (process.env.CI) {
    process.exitCode = 1;
    return;
  }
  console.log("[windows-mic-listener] Mic detection will use fallback mode (polling)");
  console.log(
    "[windows-mic-listener] To compile locally, install Visual Studio Build Tools or MinGW-w64"
  );
}

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

  const tagToFind = VERSION_OVERRIDE || readPinnedTag();
  console.log(`\n[windows-mic-listener] Using pinned version: ${tagToFind}`);
  const release = await fetchLatestRelease(REPO, { tagPrefix: tagToFind });

  if (!release) {
    failDownload(`Could not find a release matching: ${tagToFind}`);
    return;
  }

  // Find the zip asset
  const zipAsset = release.assets.find((a) => a.name === ZIP_NAME);
  if (!zipAsset) {
    failDownload(
      `Release ${release.tag} does not contain ${ZIP_NAME} ` +
        `(available: ${release.assets.map((a) => a.name).join(", ")})`
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
    // Cleanup on failure
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    failDownload(`Download failed: ${error.message}`);
  }
}

main().catch((error) => {
  failDownload(`Unexpected error: ${error.message}`);
});
