#!/usr/bin/env node
/**
 * Downloads prebuilt text monitor binary from GitHub releases.
 * Selects the correct binary for the current platform (Linux or Windows).
 *
 * Usage:
 *   node scripts/download-text-monitor.js [--force]
 */

const fs = require("fs");
const path = require("path");
const {
  downloadFile,
  extractArchive,
  fetchLatestRelease,
  setExecutable,
} = require("./lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

const PLATFORM_CONFIG = {
  linux: {
    label: "linux-text-monitor",
    tagPrefix: "linux-text-monitor-v",
    archiveName: "linux-text-monitor-linux-x64.tar.gz",
    binaryName: "linux-text-monitor",
    versionEnv: "LINUX_TEXT_MONITOR_VERSION",
    compileHint: "install libatspi2.0-dev and libglib2.0-dev",
  },
  win32: {
    label: "windows-text-monitor",
    tagPrefix: "windows-text-monitor-v",
    archiveName: "windows-text-monitor-win32-x64.zip",
    binaryName: "windows-text-monitor.exe",
    versionEnv: "WINDOWS_TEXT_MONITOR_VERSION",
    compileHint: "install Visual Studio Build Tools or MinGW-w64",
  },
};

async function main() {
  const config = PLATFORM_CONFIG[process.platform];
  if (!config) {
    console.log(`[text-monitor] Skipping download (unsupported platform: ${process.platform})`);
    return;
  }

  const { label, tagPrefix, archiveName, binaryName, versionEnv, compileHint } = config;
  const versionOverride = process.env[versionEnv] || null;
  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, binaryName);

  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log(`[${label}] Already exists (use --force to re-download)`);
    console.log(`  ${outputPath}`);
    return;
  }

  if (versionOverride) {
    console.log(`\n[${label}] Using pinned version: ${versionOverride}`);
  } else {
    console.log(`\n[${label}] Fetching latest release...`);
  }
  const tagToFind = versionOverride || tagPrefix;
  const release = await fetchLatestRelease(REPO, { tagPrefix: tagToFind });

  if (!release) {
    console.error(`[${label}] Could not find a release matching prefix:`, tagPrefix);
    console.log(`[${label}] Auto-learn correction monitoring will be disabled`);
    return;
  }

  const asset = release.assets.find((a) => a.name === archiveName);
  if (!asset) {
    console.error(`[${label}] Release ${release.tag} does not contain ${archiveName}`);
    console.log(`[${label}] Available assets:`, release.assets.map((a) => a.name).join(", "));
    return;
  }

  console.log(`\nDownloading ${label} (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const archivePath = path.join(BIN_DIR, archiveName);
  console.log(`  Downloading from: ${asset.url}`);

  try {
    await downloadFile(asset.url, archivePath);

    const extractDir = path.join(BIN_DIR, `temp-${label}`);
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractArchive(archivePath, extractDir);

    const binaryPath = path.join(extractDir, binaryName);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${binaryName}`);
    } else {
      throw new Error(`Binary not found in archive: ${binaryName}`);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }

    const stats = fs.statSync(outputPath);
    console.log(
      `\n[${label}] Successfully downloaded ${release.tag} (${Math.round(stats.size / 1024)}KB)`
    );
  } catch (error) {
    console.error(`\n[${label}] Download failed: ${error.message}`);

    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }

    console.log(`[${label}] Auto-learn correction monitoring will be disabled`);
    console.log(`[${label}] To compile locally, ${compileHint}`);
  }
}

main().catch((error) => {
  console.error("[text-monitor] Unexpected error:", error);
});
