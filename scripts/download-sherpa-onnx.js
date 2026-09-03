#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  cleanupFiles,
  downloadFile,
  findBinaryInDir,
  parseArgs,
  setExecutable,
} = require("./lib/download-utils");
const {
  PARAKEET_MINIMUM_MACOS_VERSION,
  compareVersions,
} = require("../src/helpers/parakeetCapability");

const SHERPA_ONNX_VERSION = "1.13.6";
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

// Both patterns accept the same version shapes, so every leftover the packaging check can spot
// is one the prune can remove.
const VERSIONED_LIB_PATTERN = /^(lib.+?)\.(\d+(?:\.\d+)*)\.(dylib|so|dll)$/;
const VERSIONED_ONNX_RUNTIME_DYLIB_PATTERN = /^libonnxruntime\.\d+(?:\.\d+)*\.dylib$/;
const UNVERSIONED_ONNX_RUNTIME_DYLIB = "libonnxruntime.dylib";
const REQUIRED_MACOS_ARCHITECTURES = ["x86_64", "arm64"];

// A versioned library is stale once this run copied one with the same base name but not that
// file. 1.13.5 dropped the versioned macOS ONNX Runtime in favour of libonnxruntime.dylib alone,
// so the 1.13.4 file no longer collides with a copy: without this it lingers in resources/bin and
// is packaged next to the library the app actually loads.
function findStaleVersionedLibraries(entries, copiedLibraries) {
  const copied = new Set(copiedLibraries);
  const copiedBaseNames = new Set();
  for (const name of copied) {
    const match = name.match(VERSIONED_LIB_PATTERN);
    copiedBaseNames.add(match ? `${match[1]}.${match[3]}` : name);
  }

  return entries.filter((name) => {
    if (copied.has(name)) return false;
    const match = name.match(VERSIONED_LIB_PATTERN);
    return Boolean(match) && copiedBaseNames.has(`${match[1]}.${match[3]}`);
  });
}

// Upstream ad-hoc signatures were invalid on both slices through 1.13.4 and dyld SIGKILLs
// unsigned loads; re-signing keeps that from returning in a future release.
function adhocSign(filePath, platformArch) {
  if (process.platform !== "darwin" || !platformArch.startsWith("darwin")) return;
  execFileSync("codesign", ["--force", "--sign", "-", filePath], { stdio: "ignore" });
}

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
    resolveLibrary = fs.realpathSync,
    runVtool = (libraryPath) =>
      execFileSync("xcrun", ["vtool", "-show-build", libraryPath], { encoding: "utf8" }),
  } = {}
) {
  const binDirectory = path.join(appPath, "Contents", "Resources", "bin");
  const entries = readDirectory(binDirectory);

  // The sherpa binaries link @rpath/libonnxruntime.dylib, so that name is what dyld resolves and
  // what has to be validated. Releases before 1.13.5 shipped it as a symlink to a versioned file,
  // which the download script still reproduces for any archive that ships versioned libraries --
  // so resolve the name and treat only the versioned files that are not its target as leftovers
  // from an older release, dead weight that dyld never loads.
  if (!entries.includes(UNVERSIONED_ONNX_RUNTIME_DYLIB)) {
    const versioned = entries.filter((fileName) =>
      VERSIONED_ONNX_RUNTIME_DYLIB_PATTERN.test(fileName)
    );
    throw new Error(
      `Expected ${UNVERSIONED_ONNX_RUNTIME_DYLIB} in ${binDirectory}, found ${
        versioned.length ? versioned.join(", ") : "no ONNX Runtime library"
      }`
    );
  }

  const libraryPath = path.join(binDirectory, UNVERSIONED_ONNX_RUNTIME_DYLIB);
  let resolvedName;
  try {
    resolvedName = path.basename(resolveLibrary(libraryPath));
  } catch {
    throw new Error(`${UNVERSIONED_ONNX_RUNTIME_DYLIB} in ${binDirectory} does not resolve`);
  }

  const leftovers = entries.filter(
    (fileName) => fileName !== resolvedName && VERSIONED_ONNX_RUNTIME_DYLIB_PATTERN.test(fileName)
  );
  if (leftovers.length > 0) {
    throw new Error(
      `Found ONNX Runtime libraries from an older release in ${binDirectory}: ${leftovers.join(", ")}`
    );
  }
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

function findLibrariesInDir(dir, pattern, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...findLibrariesInDir(fullPath, pattern, maxDepth, currentDepth + 1));
      } else if (matchesPattern(entry.name, pattern)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors
  }

  return results;
}

function matchesPattern(filename, pattern) {
  if (pattern === "*.dylib") {
    return filename.endsWith(".dylib");
  } else if (pattern === "*.dll") {
    return filename.endsWith(".dll");
  } else if (pattern === "*.so*") {
    return /\.so(\.\d+)*$/.test(filename) || filename.endsWith(".so");
  }
  return false;
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
  adhocSign(outputPath, platformArch);
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
  if (!marker || binaryPaths.some((binaryPath) => !fs.existsSync(binaryPath))) return false;

  return (
    marker.version === SHERPA_ONNX_VERSION &&
    Array.isArray(marker.libraries) &&
    marker.libraries.every((lib) => fs.existsSync(path.join(BIN_DIR, lib)))
  );
}

// Drop the versioned libraries an earlier sherpa-onnx release left behind. Scoped to the base
// names of the libraries installed, so the whisper.cpp/llama.cpp/qdrant libraries sharing
// resources/bin are never candidates.
function pruneStaleLibraries(platformArch, installedLibraries) {
  for (const file of findStaleVersionedLibraries(fs.readdirSync(BIN_DIR), installedLibraries)) {
    fs.rmSync(path.join(BIN_DIR, file), { force: true });
    console.log(`  ${platformArch}: Removed stale ${file}`);
  }
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
    // An install written before the prune existed still carries the older release's libraries.
    pruneStaleLibraries(platformArch, installMarker.libraries);
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
      const libraries = findLibrariesInDir(extractDir, config.libPattern);

      // Separate versioned and unversioned libraries to create symlinks where possible
      // e.g. libonnxruntime.dylib -> libonnxruntime.1.23.2.dylib (saves ~71MB)
      const versionedLibs = new Map(); // base name -> versioned file name

      for (const libPath of libraries) {
        const libName = path.basename(libPath);
        const destPath = path.join(BIN_DIR, libName);

        const versionMatch = libName.match(VERSIONED_LIB_PATTERN);
        if (versionMatch) {
          versionedLibs.set(`${versionMatch[1]}.${versionMatch[3]}`, libName);
        }

        // rm first: copying onto an existing symlink would write through it
        fs.rmSync(destPath, { force: true });
        fs.copyFileSync(libPath, destPath);
        setExecutable(destPath);
        adhocSign(destPath, platformArch);
        copiedLibraries.push(libName);
        console.log(`  ${platformArch}: Copied library ${libName}`);
      }

      // Replace unversioned copies with symlinks to versioned ones (macOS/Linux only)
      if (process.platform !== "win32") {
        for (const [baseName, versionedName] of versionedLibs) {
          const basePath = path.join(BIN_DIR, baseName);
          fs.rmSync(basePath, { force: true });
          fs.symlinkSync(versionedName, basePath);
          console.log(`  ${platformArch}: Symlinked ${baseName} -> ${versionedName}`);
        }
      }

      pruneStaleLibraries(platformArch, copiedLibraries);
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
  findStaleVersionedLibraries,
  getDownloadUrl,
  parseMacosDeploymentTargets,
  validateMacosDeploymentTargets,
  verifyPackagedMacosParakeet,
};

// Only run main() when executed directly
if (require.main === module) {
  main().catch(console.error);
}
