#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  downloadFile,
  extractZip,
  fetchLatestRelease,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
} = require("./lib/download-utils");

const WHISPER_CPP_REPO = "OpenWhispr/whisper.cpp";

// Version can be pinned via environment variable for reproducible builds
const VERSION_OVERRIDE = process.env.WHISPER_CPP_VERSION || null;

const BINARIES = {
  "darwin-arm64": {
    zipName: "whisper-server-darwin-arm64.zip",
    binaryName: "whisper-server-darwin-arm64",
    outputName: "whisper-server-darwin-arm64",
  },
  "darwin-x64": {
    zipName: "whisper-server-darwin-x64.zip",
    binaryName: "whisper-server-darwin-x64",
    outputName: "whisper-server-darwin-x64",
  },
  "win32-x64": {
    zipName: "whisper-server-win32-x64-cpu.zip",
    binaryName: "whisper-server-win32-x64-cpu.exe",
    outputName: "whisper-server-win32-x64.exe",
  },
  "linux-x64": {
    zipName: "whisper-server-linux-x64-cpu.zip",
    binaryName: "whisper-server-linux-x64-cpu",
    outputName: "whisper-server-linux-x64",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

// Cache the release info to avoid multiple API calls
let cachedRelease = null;

async function getRelease() {
  if (cachedRelease) return cachedRelease;

  if (VERSION_OVERRIDE) {
    cachedRelease = await fetchLatestRelease(WHISPER_CPP_REPO, { tagPrefix: VERSION_OVERRIDE });
  } else {
    cachedRelease = await fetchLatestRelease(WHISPER_CPP_REPO);
  }
  return cachedRelease;
}

function getDownloadUrl(release, zipName) {
  const asset = release?.assets?.find((a) => a.name === zipName);
  return asset?.url || null;
}

async function downloadBinary(platformArch, config, release, isForce = false) {
  if (!config) {
    console.log(`  [server] ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);

  if (fs.existsSync(outputPath) && !isForce) {
    console.log(`  [server] ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }

  const url = getDownloadUrl(release, config.zipName);
  if (!url) {
    console.error(`  [server] ${platformArch}: Asset ${config.zipName} not found in release`);
    return false;
  }
  console.log(`  [server] ${platformArch}: Downloading from ${url}`);

  const zipPath = path.join(BIN_DIR, config.zipName);

  try {
    await downloadFile(url, zipPath);

    const extractDir = path.join(BIN_DIR, `temp-whisper-${platformArch}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    const binaryPath = findBinaryInDir(extractDir, config.binaryName);
    if (binaryPath) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  [server] ${platformArch}: Extracted to ${config.outputName}`);
    } else {
      console.error(`  [server] ${platformArch}: Binary "${config.binaryName}" not found in archive`);
      return false;
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return true;
  } catch (error) {
    console.error(`  [server] ${platformArch}: Failed - ${error.message}`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return false;
  }
}

async function main() {
  if (VERSION_OVERRIDE) {
    console.log(`\n[whisper-server] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[whisper-server] Fetching latest release...");
  }
  const release = await getRelease();

  if (!release) {
    console.error(`[whisper-server] Could not fetch release from ${WHISPER_CPP_REPO}`);
    console.log(`\nMake sure release exists: https://github.com/${WHISPER_CPP_REPO}/releases`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nDownloading whisper-server binaries (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(args.platformArch, BINARIES[args.platformArch], release, args.isForce);
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "whisper-server", `whisper-server-${args.platformArch}`);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      await downloadBinary(platformArch, BINARIES[platformArch], release, args.isForce);
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("whisper-server"));
  if (files.length > 0) {
    console.log("Available whisper-server binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${WHISPER_CPP_REPO}/releases`);
  }
}

main().catch(console.error);
