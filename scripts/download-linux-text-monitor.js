#!/usr/bin/env node
/**
 * Downloads prebuilt Linux text monitor binary from GitHub releases.
 * Used for auto-learn correction monitoring on Linux.
 *
 * Usage:
 *   node scripts/download-linux-text-monitor.js [--force]
 *
 * Options:
 *   --force    Re-download even if binary already exists
 */

const fs = require("fs");
const path = require("path");
const { downloadFile, extractArchive, fetchLatestRelease, setExecutable } = require("./lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const TAG_PREFIX = "linux-text-monitor-v";
const ARCHIVE_NAME = "linux-text-monitor-linux-x64.tar.gz";
const BINARY_NAME = "linux-text-monitor";

const VERSION_OVERRIDE = process.env.LINUX_TEXT_MONITOR_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

async function main() {
  if (process.platform !== "linux") {
    console.log("[linux-text-monitor] Skipping download (not Linux)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[linux-text-monitor] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  if (VERSION_OVERRIDE) {
    console.log(`\n[linux-text-monitor] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[linux-text-monitor] Fetching latest release...");
  }
  const tagToFind = VERSION_OVERRIDE || TAG_PREFIX;
  const release = await fetchLatestRelease(REPO, { tagPrefix: tagToFind });

  if (!release) {
    console.error("[linux-text-monitor] Could not find a release matching prefix:", TAG_PREFIX);
    console.log("[linux-text-monitor] Auto-learn correction monitoring will be disabled");
    return;
  }

  const archiveAsset = release.assets.find((a) => a.name === ARCHIVE_NAME);
  if (!archiveAsset) {
    console.error(`[linux-text-monitor] Release ${release.tag} does not contain ${ARCHIVE_NAME}`);
    console.log("[linux-text-monitor] Available assets:", release.assets.map((a) => a.name).join(", "));
    return;
  }

  console.log(`\nDownloading Linux text monitor (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const archivePath = path.join(BIN_DIR, ARCHIVE_NAME);
  console.log(`  Downloading from: ${archiveAsset.url}`);

  try {
    await downloadFile(archiveAsset.url, archivePath);

    const extractDir = path.join(BIN_DIR, "temp-linux-text-monitor");
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractArchive(archivePath, extractDir);

    const binaryPath = path.join(extractDir, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${BINARY_NAME}`);
    } else {
      throw new Error(`Binary not found in archive: ${BINARY_NAME}`);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }

    const stats = fs.statSync(outputPath);
    console.log(`\n[linux-text-monitor] Successfully downloaded ${release.tag} (${Math.round(stats.size / 1024)}KB)`);
  } catch (error) {
    console.error(`\n[linux-text-monitor] Download failed: ${error.message}`);

    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }

    console.log("[linux-text-monitor] Auto-learn correction monitoring will be disabled");
    console.log("[linux-text-monitor] To compile locally, install libatspi2.0-dev and libglib2.0-dev");
  }
}

main().catch((error) => {
  console.error("[linux-text-monitor] Unexpected error:", error);
});
