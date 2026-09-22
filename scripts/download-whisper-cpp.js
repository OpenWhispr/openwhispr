#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  copyLibraries,
  downloadFile,
  extractZip,
  fetchLatestRelease,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
} = require("./lib/download-utils");
const {
  WHISPER_CPP_TAG,
  WINDOWS_MSVC_RUNTIME_LIBRARIES,
} = require("../src/helpers/whisperCppRelease");

const WHISPER_CPP_REPO = "OpenWhispr/whisper.cpp";

// Pinned to a tested build. Tracking the latest release let an upstream whisper.cpp bump
// change transcription output between app releases with no diff to review. See #1348.
// 0.0.10 is the first release whose win32 zips bundle the MSVC runtime DLLs (CUS-113).
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
    // MSVC runtime DLLs the exe links dynamically; without them beside the exe,
    // machines lacking the VC++ redistributable die at load with 0xC0000135 (CUS-113)
    libPattern: "*.dll",
    requiredLibraries: WINDOWS_MSVC_RUNTIME_LIBRARIES,
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

  cachedRelease = await fetchLatestRelease(WHISPER_CPP_REPO, { tag: WHISPER_CPP_TAG });
  return cachedRelease;
}

function getDownloadUrl(release, zipName) {
  const asset = release?.assets?.find((a) => a.name === zipName);
  return asset?.url || null;
}

function isCompleteInstall(markerPath, binaryPath, config) {
  if (!fs.existsSync(binaryPath)) return false;

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.version !== WHISPER_CPP_TAG || !Array.isArray(marker.libraries)) return false;

    const binDir = path.dirname(markerPath);
    if (marker.libraries.some((library) => !fs.existsSync(path.join(binDir, library)))) {
      return false;
    }

    const installedLibraries = new Set(marker.libraries.map((library) => library.toLowerCase()));
    return (config.requiredLibraries || []).every((library) =>
      installedLibraries.has(library.toLowerCase())
    );
  } catch {
    return false;
  }
}

async function downloadBinary(platformArch, config, release, isForce = false) {
  if (!config) {
    console.log(`  [server] ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);
  const installMarkerPath = path.join(BIN_DIR, `.whisper-cpp-${platformArch}.json`);

  if (!isForce && isCompleteInstall(installMarkerPath, outputPath, config)) {
    console.log(`  [server] ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }
  if (isForce && fs.existsSync(installMarkerPath)) fs.unlinkSync(installMarkerPath);

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

      let copiedLibraries = [];
      if (config.libPattern) {
        copiedLibraries = copyLibraries(extractDir, BIN_DIR, config.libPattern);
        for (const libName of copiedLibraries) {
          console.log(`  [server] ${platformArch}: Copied library ${libName}`);
        }
      }

      const copiedLibraryNames = new Set(copiedLibraries.map((library) => library.toLowerCase()));
      const missingLibraries = (config.requiredLibraries || []).filter(
        (library) => !copiedLibraryNames.has(library.toLowerCase())
      );
      if (missingLibraries.length > 0) {
        throw new Error(`Archive missing required libraries: ${missingLibraries.join(", ")}`);
      }

      fs.writeFileSync(
        installMarkerPath,
        JSON.stringify({ version: WHISPER_CPP_TAG, libraries: copiedLibraries })
      );
    } else {
      console.error(
        `  [server] ${platformArch}: Binary "${config.binaryName}" not found in archive`
      );
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

async function downloadAllBinaries(release, isForce, download = downloadBinary) {
  let allSucceeded = true;

  for (const platformArch of Object.keys(BINARIES)) {
    const succeeded = await download(platformArch, BINARIES[platformArch], release, isForce);
    if (!succeeded) allSucceeded = false;
  }

  return allSucceeded;
}

async function main() {
  console.log(`\n[whisper-server] Using pinned version: ${WHISPER_CPP_TAG}`);
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
      cleanupFiles(BIN_DIR, "whisper-server", `whisper-server-${args.platformArch}`);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    const allSucceeded = await downloadAllBinaries(release, args.isForce);
    if (!allSucceeded) process.exitCode = 1;
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

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { BINARIES, WHISPER_CPP_TAG, downloadAllBinaries, isCompleteInstall };
