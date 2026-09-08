#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  cleanupFiles,
  downloadFile,
  findBinaryInDir,
  findLibrariesInDir,
  parseArgs,
  setExecutable,
} = require("./lib/download-utils");
const {
  PARAKEET_MINIMUM_MACOS_VERSION,
  compareVersions,
} = require("../src/helpers/parakeetCapability");

const SHERPA_ONNX_VERSION = "1.13.7";
const GITHUB_RELEASE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`;

// Binary configurations for each platform
// Note: macOS uses universal2 builds that work on both arm64 and x64
const BINARIES = {
  "darwin-arm64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-universal2-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-darwin-arm64",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-darwin-arm64",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization",
    diarizeOutputName: "sherpa-onnx-diarize-darwin-arm64",
    libPattern: "*.dylib",
  },
  "darwin-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-universal2-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-darwin-x64",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-darwin-x64",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization",
    diarizeOutputName: "sherpa-onnx-diarize-darwin-x64",
    libPattern: "*.dylib",
  },
  "win32-x64": {
    // Since 1.13.4 the Windows assets carry an MSVC runtime/build-type suffix
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-win-x64-shared-MD-Release.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server.exe",
    outputName: "sherpa-onnx-ws-win32-x64.exe",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server.exe",
    onlineOutputName: "sherpa-onnx-online-ws-win32-x64.exe",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization.exe",
    diarizeOutputName: "sherpa-onnx-diarize-win32-x64.exe",
    libPattern: "*.dll",
  },
  "linux-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-linux-x64-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-linux-x64",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-linux-x64",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization",
    diarizeOutputName: "sherpa-onnx-diarize-linux-x64",
    libPattern: "*.so*",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

const MACOS_ONNX_RUNTIME_LIBRARY = "libonnxruntime.dylib";
const REQUIRED_MACOS_ARCHITECTURES = ["x86_64", "arm64"];

function getDownloadUrl(archiveName) {
  return `${GITHUB_RELEASE_URL}/${archiveName}`;
}

function parseMacosDeploymentTargets(vtoolOutput) {
  const targets = [];
  let architecture = null;
  let isMacosBuildVersion = false;

  for (const line of String(vtoolOutput).split("\n")) {
    const architectureMatch = line.match(/\(architecture ([^)]+)\):\s*$/);
    if (architectureMatch) {
      architecture = architectureMatch[1];
      isMacosBuildVersion = false;
      continue;
    }

    if (/^\s*platform MACOS\s*$/.test(line)) {
      isMacosBuildVersion = true;
      continue;
    }

    const minimumMatch = line.match(/^\s*minos (\S+)\s*$/);
    if (architecture && isMacosBuildVersion && minimumMatch) {
      targets.push({ architecture, minimumVersion: minimumMatch[1] });
      isMacosBuildVersion = false;
    }
  }

  return targets;
}

function validateMacosDeploymentTargets(targets) {
  const architectures = new Set(targets.map((target) => target.architecture));
  for (const architecture of REQUIRED_MACOS_ARCHITECTURES) {
    if (!architectures.has(architecture)) {
      throw new Error(`ONNX Runtime is missing required architecture: ${architecture}`);
    }
  }

  for (const target of targets) {
    if (compareVersions(target.minimumVersion, PARAKEET_MINIMUM_MACOS_VERSION) !== 0) {
      throw new Error(
        `${target.architecture} requires macOS ${target.minimumVersion}, but the Parakeet capability gate is ${PARAKEET_MINIMUM_MACOS_VERSION}`
      );
    }
  }

  return {
    architectures: [...architectures],
    minimumVersion: PARAKEET_MINIMUM_MACOS_VERSION,
  };
}

function verifyPackagedMacosParakeet(
  appPath,
  {
    readDirectory = fs.readdirSync,
    runVtool = (libraryPath) =>
      execFileSync("xcrun", ["vtool", "-show-build", libraryPath], { encoding: "utf8" }),
  } = {}
) {
  const binDirectory = path.join(appPath, "Contents", "Resources", "bin");
  if (!readDirectory(binDirectory).includes(MACOS_ONNX_RUNTIME_LIBRARY)) {
    throw new Error(`Expected ${MACOS_ONNX_RUNTIME_LIBRARY} in ${binDirectory}`);
  }

  const libraryPath = path.join(binDirectory, MACOS_ONNX_RUNTIME_LIBRARY);
  const targets = parseMacosDeploymentTargets(runVtool(libraryPath));
  return { ...validateMacosDeploymentTargets(targets), libraryPath };
}

function extractTarBz2(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Use relative paths from archive dir as cwd, so neither -f nor -C args
  // contain Windows drive letter colons (GNU tar treats C: as remote host)
  const cwd = path.dirname(archivePath);
  execFileSync("tar", ["-xjf", path.basename(archivePath), "-C", path.relative(cwd, destDir)], {
    stdio: "inherit",
    cwd,
  });
}

function copyBinary(extractDir, binaryName, outputPath, platformArch) {
  const foundPath = findBinaryInDir(extractDir, binaryName);

  if (!foundPath || !fs.existsSync(foundPath)) {
    console.error(`  ${platformArch}: Binary '${binaryName}' not found in archive`);
    return false;
  }

  fs.rmSync(outputPath, { force: true });
  fs.copyFileSync(foundPath, outputPath);
  setExecutable(outputPath);
  console.log(`  ${platformArch}: Extracted to ${path.basename(outputPath)}`);
  return true;
}

function readInstallMarker(markerPath) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function isCompleteInstall(marker, binaryPaths) {
  if (binaryPaths.some((binaryPath) => !fs.existsSync(binaryPath))) return false;

  return (
    marker?.version === SHERPA_ONNX_VERSION &&
    Array.isArray(marker.libraries) &&
    marker.libraries.every(
      (library) => typeof library === "string" && fs.existsSync(path.join(BIN_DIR, library))
    )
  );
}

function findObsoleteLibraries(previousLibraries, installedLibraries, directoryEntries) {
  const previous = new Set(previousLibraries);
  const installed = new Set(installedLibraries);
  return directoryEntries.filter((file) => previous.has(file) && !installed.has(file));
}

async function downloadBinary(platformArch, config, isForce = false) {
  if (!config) {
    console.log(`  ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);
  const onlineOutputPath = path.join(BIN_DIR, config.onlineOutputName);
  const diarizeOutputPath = path.join(BIN_DIR, config.diarizeOutputName);
  const installMarkerPath = path.join(BIN_DIR, `.sherpa-onnx-${platformArch}.json`);
  const installMarker = readInstallMarker(installMarkerPath);

  if (
    !isForce &&
    isCompleteInstall(installMarker, [outputPath, onlineOutputPath, diarizeOutputPath])
  ) {
    console.log(`  ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }
  if (isForce && fs.existsSync(installMarkerPath)) fs.unlinkSync(installMarkerPath);

  const url = getDownloadUrl(config.archiveName);
  console.log(`  ${platformArch}: Downloading from ${url}`);

  const archivePath = path.join(BIN_DIR, config.archiveName);
  const extractDir = path.join(BIN_DIR, `temp-sherpa-${platformArch}`);

  try {
    await downloadFile(url, archivePath);

    fs.mkdirSync(extractDir, { recursive: true });
    extractTarBz2(archivePath, extractDir);

    for (const [binaryName, destPath] of [
      [config.binaryPath, outputPath],
      [config.onlineBinaryPath, onlineOutputPath],
      [config.diarizeBinaryPath, diarizeOutputPath],
    ]) {
      if (!copyBinary(extractDir, binaryName, destPath, platformArch)) return false;
    }

    // Copy shared libraries
    const copiedLibraries = [];
    if (config.libPattern) {
      const libraries = findLibrariesInDir(extractDir, config.libPattern, {
        ignoreReadErrors: true,
      });

      for (const libPath of libraries) {
        const libName = path.basename(libPath);
        const destPath = path.join(BIN_DIR, libName);

        // rm first: copying onto an existing symlink would write through it
        fs.rmSync(destPath, { force: true });
        fs.copyFileSync(libPath, destPath);
        setExecutable(destPath);
        copiedLibraries.push(libName);
        console.log(`  ${platformArch}: Copied library ${libName}`);
      }

      const previousLibraries = Array.isArray(installMarker?.libraries)
        ? installMarker.libraries
        : [];
      const obsoleteLibraries = findObsoleteLibraries(
        previousLibraries,
        copiedLibraries,
        fs.readdirSync(BIN_DIR)
      );
      for (const file of obsoleteLibraries) {
        fs.rmSync(path.join(BIN_DIR, file), { force: true });
        console.log(`  ${platformArch}: Removed stale ${file}`);
      }
    }

    fs.writeFileSync(
      installMarkerPath,
      JSON.stringify({ version: SHERPA_ONNX_VERSION, libraries: copiedLibraries })
    );
    return true;
  } catch (error) {
    console.error(`  ${platformArch}: Failed - ${error.message}`);
    return false;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  }
}

async function main() {
  console.log(`\nDownloading sherpa-onnx binaries (v${SHERPA_ONNX_VERSION})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    const config = BINARIES[args.platformArch];
    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(args.platformArch, config, args.isForce);
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    // Remove old CLI-style binaries replaced by WS server binaries
    const oldBinaryName = args.platformArch.startsWith("win32")
      ? `sherpa-onnx-${args.platformArch}.exe`
      : `sherpa-onnx-${args.platformArch}`;
    const oldBinaryPath = path.join(BIN_DIR, oldBinaryName);
    if (fs.existsSync(oldBinaryPath)) {
      console.log(`  Removing old CLI binary: ${oldBinaryName}`);
      fs.unlinkSync(oldBinaryPath);
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "sherpa-onnx", [
        `sherpa-onnx-ws-${args.platformArch}`,
        `sherpa-onnx-online-ws-${args.platformArch}`,
        `sherpa-onnx-diarize-${args.platformArch}`,
      ]);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      await downloadBinary(platformArch, BINARIES[platformArch], args.isForce);
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("sherpa-onnx"));
  if (files.length > 0) {
    console.log("Available sherpa-onnx binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(
      `\nCheck: https://github.com/k2-fsa/sherpa-onnx/releases/tag/v${SHERPA_ONNX_VERSION}`
    );
  }
}

// Export config for potential imports
module.exports = {
  SHERPA_ONNX_VERSION,
  BINARIES,
  BIN_DIR,
  findObsoleteLibraries,
  getDownloadUrl,
  parseMacosDeploymentTargets,
  validateMacosDeploymentTargets,
  verifyPackagedMacosParakeet,
};

// Only run main() when executed directly
if (require.main === module) {
  main().catch(console.error);
}
