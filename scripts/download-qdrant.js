#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  downloadFile,
  extractArchive,
  fetchLatestRelease,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
} = require("./lib/download-utils");

const QDRANT_REPO = "qdrant/qdrant";

// Version can be pinned via environment variable for reproducible builds
const VERSION_OVERRIDE = process.env.QDRANT_VERSION || null;

const BINARIES = {
  "darwin-arm64": {
    archiveName: "qdrant-aarch64-apple-darwin.tar.gz",
    binaryName: "qdrant",
    outputName: "qdrant-darwin-arm64",
  },
  "darwin-x64": {
    archiveName: "qdrant-x86_64-apple-darwin.tar.gz",
    binaryName: "qdrant",
    outputName: "qdrant-darwin-x64",
  },
  "linux-x64": {
    archiveName: "qdrant-x86_64-unknown-linux-gnu.tar.gz",
    binaryName: "qdrant",
    outputName: "qdrant-linux-x64",
  },
  "win32-x64": {
    archiveName: "qdrant-x86_64-pc-windows-msvc.zip",
    binaryName: "qdrant.exe",
    outputName: "qdrant-win32-x64.exe",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

// Cache the release info to avoid multiple API calls
let cachedRelease = null;

async function getRelease() {
  if (cachedRelease) return cachedRelease;

  if (VERSION_OVERRIDE) {
    cachedRelease = await fetchLatestRelease(QDRANT_REPO, { tagPrefix: VERSION_OVERRIDE });
  } else {
    cachedRelease = await fetchLatestRelease(QDRANT_REPO);
  }
  return cachedRelease;
}

function getDownloadUrl(release, archiveName) {
  const asset = release?.assets?.find((a) => a.name === archiveName);
  return asset?.url || null;
}

async function downloadBinary(platformArch, config, release, isForce = false) {
  if (!config) {
    console.log(`  [qdrant] ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);

  if (fs.existsSync(outputPath) && !isForce) {
    console.log(`  [qdrant] ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }

  const url = getDownloadUrl(release, config.archiveName);
  if (!url) {
    console.error(`  [qdrant] ${platformArch}: Asset ${config.archiveName} not found in release`);
    return false;
  }
  console.log(`  [qdrant] ${platformArch}: Downloading from ${url}`);

  const archivePath = path.join(BIN_DIR, config.archiveName);

  try {
    await downloadFile(url, archivePath);

    const extractDir = path.join(BIN_DIR, `temp-qdrant-${platformArch}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir);

    const binaryPath = findBinaryInDir(extractDir, config.binaryName);
    if (binaryPath) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  [qdrant] ${platformArch}: Extracted to ${config.outputName}`);
    } else {
      console.error(
        `  [qdrant] ${platformArch}: Binary "${config.binaryName}" not found in archive`
      );
      return false;
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    return true;
  } catch (error) {
    console.error(`  [qdrant] ${platformArch}: Failed - ${error.message}`);
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    return false;
  }
}

async function main() {
  if (VERSION_OVERRIDE) {
    console.log(`\n[qdrant] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[qdrant] Fetching latest release...");
  }
  const release = await getRelease();

  if (!release) {
    console.error(`[qdrant] Could not fetch release from ${QDRANT_REPO}`);
    console.log(`\nMake sure release exists: https://github.com/${QDRANT_REPO}/releases`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nDownloading qdrant binaries (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(
      args.platformArch,
      BINARIES[args.platformArch],
      release,
      args.isForce
    );
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "qdrant", `qdrant-${args.platformArch}`);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      await downloadBinary(platformArch, BINARIES[platformArch], release, args.isForce);
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("qdrant"));
  if (files.length > 0) {
    console.log("Available qdrant binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${QDRANT_REPO}/releases`);
  }
}

main().catch(console.error);
