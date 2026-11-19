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

// Qdrant publishes releases before their binary build jobs finish. Pin a complete
// release so every platform packages the same version, independent of upstream timing.
const QDRANT_VERSION = process.env.QDRANT_VERSION || "v1.20.1";

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

  cachedRelease = await fetchLatestRelease(QDRANT_REPO, { tag: QDRANT_VERSION });
  return cachedRelease;
}

function getDownloadUrl(release, archiveName) {
  const asset = release?.assets?.find((a) => a.name === archiveName);
  return asset?.url || null;
}

function isCurrentVersion(markerPath, version) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8")).version === version;
  } catch {
    return false;
  }
}

async function downloadBinary(platformArch, config, release, isForce = false) {
  if (!config) {
    console.log(`  [qdrant] ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);
  const markerPath = path.join(BIN_DIR, `.qdrant-${platformArch}.json`);

  if (fs.existsSync(outputPath) && !isForce && isCurrentVersion(markerPath, release.tag)) {
    console.log(`  [qdrant] ${platformArch}: Already up to date (${release.tag})`);
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
      fs.writeFileSync(markerPath, JSON.stringify({ version: release.tag }));
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
  console.log(`\n[qdrant] Using pinned version: ${QDRANT_VERSION}`);
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
