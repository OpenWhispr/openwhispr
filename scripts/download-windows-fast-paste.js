#!/usr/bin/env node
/**
 * Downloads prebuilt Windows fast-paste binary from GitHub releases.
 * Used for terminal-aware clipboard paste on Windows.
 *
 * Usage:
 *   node scripts/download-windows-fast-paste.js [--force]
 *
 * Options:
 *   --force    Re-download even if binary already exists
 */

const fs = require("fs");
const path = require("path");
const { downloadFile, extractZip, fetchLatestRelease, setExecutable } = require("./lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const TAG_PREFIX = "windows-fast-paste-v";
const ZIP_NAME = "windows-fast-paste-win32-x64.zip";
const BINARY_NAME = "windows-fast-paste.exe";

const VERSION_OVERRIDE = process.env.WINDOWS_FAST_PASTE_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

async function main() {
  if (process.platform !== "win32") {
    console.log("[windows-fast-paste] Skipping download (not Windows)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[windows-fast-paste] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  if (VERSION_OVERRIDE) {
    console.log(`\n[windows-fast-paste] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[windows-fast-paste] Fetching latest release...");
  }
  const tagToFind = VERSION_OVERRIDE || TAG_PREFIX;
  const release = await fetchLatestRelease(REPO, { tagPrefix: tagToFind });

  if (!release) {
    console.error("[windows-fast-paste] Could not find a release matching prefix:", TAG_PREFIX);
    console.log("[windows-fast-paste] Paste will use nircmd/PowerShell fallback");
    return;
  }

  const zipAsset = release.assets.find((a) => a.name === ZIP_NAME);
  if (!zipAsset) {
    console.error(`[windows-fast-paste] Release ${release.tag} does not contain ${ZIP_NAME}`);
    console.log("[windows-fast-paste] Available assets:", release.assets.map((a) => a.name).join(", "));
    return;
  }

  console.log(`\nDownloading Windows fast-paste (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const zipPath = path.join(BIN_DIR, ZIP_NAME);
  console.log(`  Downloading from: ${zipAsset.url}`);

  try {
    await downloadFile(zipAsset.url, zipPath);

    const extractDir = path.join(BIN_DIR, "temp-windows-fast-paste");
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractZip(zipPath, extractDir);

    const binaryPath = path.join(extractDir, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${BINARY_NAME}`);
    } else {
      throw new Error(`Binary not found in archive: ${BINARY_NAME}`);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    const stats = fs.statSync(outputPath);
    console.log(`\n[windows-fast-paste] Successfully downloaded ${release.tag} (${Math.round(stats.size / 1024)}KB)`);
  } catch (error) {
    console.error(`\n[windows-fast-paste] Download failed: ${error.message}`);

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    console.log("[windows-fast-paste] Paste will use nircmd/PowerShell fallback");
  }
}

main().catch((error) => {
  console.error("[windows-fast-paste] Unexpected error:", error);
  // Don't fail the build
});
