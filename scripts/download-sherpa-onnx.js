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
const { renameImportedModule } = require("./lib/pe-imports");

const SHERPA_ONNX_VERSION = "1.13.4";
const GITHUB_RELEASE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`;

// Windows 11 ships an older onnxruntime.dll in System32, and on some machines
// the loader resolves the bare import name to that copy instead of the one
// beside the exe (#2054: "requested API version [27] is not available").
// So the bundled runtime ships under a private name and every sherpa image
// gets its import table rewritten to match. The replacement must not be
// longer than the upstream name because the string is patched in place.
// Drop this once ORT ships version-suffixed DLLs (microsoft/onnxruntime#27893)
// and sherpa-onnx picks them up.
const WINDOWS_ONNXRUNTIME_UPSTREAM_NAME = "onnxruntime.dll";
const WINDOWS_ONNXRUNTIME_PRIVATE_NAME = "ow-onnxrt.dll";

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

const VERSIONED_LIB_PATTERN = /^(lib.+?)\.(\d+\.\d+\.\d+)\.(dylib|so|dll)$/;
const REQUIRED_MACOS_ARCHITECTURES = ["x86_64", "arm64"];

// Upstream 1.13.4 ships an invalid arm64 signature on libonnxruntime; dyld SIGKILLs unsigned loads.
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
    runVtool = (libraryPath) =>
      execFileSync("xcrun", ["vtool", "-show-build", libraryPath], { encoding: "utf8" }),
  } = {}
) {
  const binDirectory = path.join(appPath, "Contents", "Resources", "bin");
  const libraries = readDirectory(binDirectory).filter((fileName) =>
    /^libonnxruntime\.\d+(?:\.\d+)*\.dylib$/.test(fileName)
  );

  if (libraries.length !== 1) {
    throw new Error(
      `Expected one versioned ONNX Runtime library in ${binDirectory}, found ${libraries.length}`
    );
  }

  const libraryPath = path.join(binDirectory, libraries[0]);
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
  adhocSign(outputPath, platformArch);
  console.log(`  ${platformArch}: Extracted to ${path.basename(outputPath)}`);
  return true;
}

function privatizeWindowsOnnxRuntime({ binDir, binaryPaths, libraryNames }) {
  const isUpstreamRuntime = (name) => name.toLowerCase() === WINDOWS_ONNXRUNTIME_UPSTREAM_NAME;
  const upstreamName = libraryNames.find(isUpstreamRuntime);
  if (!upstreamName) {
    throw new Error(
      `${WINDOWS_ONNXRUNTIME_UPSTREAM_NAME} not found among extracted libraries (${libraryNames.join(", ")}); the upstream archive layout changed`
    );
  }

  // Upstream's Windows CI copies every DLL into both bin/ and lib/ of the
  // archive, so the extracted list carries each name twice for one file.
  const shippedLibraries = [
    ...new Set(
      libraryNames.map((name) =>
        isUpstreamRuntime(name) ? WINDOWS_ONNXRUNTIME_PRIVATE_NAME : name
      )
    ),
  ];
  const privatePath = path.join(binDir, WINDOWS_ONNXRUNTIME_PRIVATE_NAME);
  fs.rmSync(privatePath, { force: true });
  fs.renameSync(path.join(binDir, upstreamName), privatePath);

  const imagePaths = [...binaryPaths, ...shippedLibraries.map((name) => path.join(binDir, name))];
  for (const imagePath of imagePaths) {
    const image = fs.readFileSync(imagePath);
    const patched = renameImportedModule(
      image,
      WINDOWS_ONNXRUNTIME_UPSTREAM_NAME,
      WINDOWS_ONNXRUNTIME_PRIVATE_NAME
    );
    if (patched === 0) continue;
    fs.writeFileSync(imagePath, image);
    console.log(
      `  win32: ${path.basename(imagePath)} now imports ${WINDOWS_ONNXRUNTIME_PRIVATE_NAME}`
    );
  }

  return shippedLibraries;
}

function isCompleteInstall(markerPath, binaryPaths, { platformArch, binDir = BIN_DIR }) {
  if (binaryPaths.some((binaryPath) => !fs.existsSync(binaryPath))) return false;

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.version !== SHERPA_ONNX_VERSION || !Array.isArray(marker.libraries)) return false;
    if (marker.libraries.some((lib) => !fs.existsSync(path.join(binDir, lib)))) return false;
    // A win32 marker without this field predates the rename: the exes on disk
    // still import onnxruntime.dll and must be re-extracted.
    return (
      !platformArch.startsWith("win32") || marker.onnxRuntime === WINDOWS_ONNXRUNTIME_PRIVATE_NAME
    );
  } catch {
    return false;
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

  if (
    !isForce &&
    isCompleteInstall(installMarkerPath, [outputPath, onlineOutputPath, diarizeOutputPath], {
      platformArch,
    })
  ) {
    console.log(`  ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }
  // A failed repair must not leave a previous marker certifying partially patched binaries.
  if (fs.existsSync(installMarkerPath)) fs.unlinkSync(installMarkerPath);

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

          for (const file of fs.readdirSync(BIN_DIR)) {
            const match = file.match(VERSIONED_LIB_PATTERN);
            if (match && `${match[1]}.${match[3]}` === baseName && file !== versionedName) {
              fs.unlinkSync(path.join(BIN_DIR, file));
              console.log(`  ${platformArch}: Removed stale ${file}`);
            }
          }
        }
      }
    }

    const isWindowsTarget = platformArch.startsWith("win32");
    const shippedLibraries = isWindowsTarget
      ? privatizeWindowsOnnxRuntime({
          binDir: BIN_DIR,
          binaryPaths: [outputPath, onlineOutputPath, diarizeOutputPath],
          libraryNames: copiedLibraries,
        })
      : copiedLibraries;

    fs.writeFileSync(
      installMarkerPath,
      JSON.stringify({
        version: SHERPA_ONNX_VERSION,
        libraries: shippedLibraries,
        ...(isWindowsTarget ? { onnxRuntime: WINDOWS_ONNXRUNTIME_PRIVATE_NAME } : {}),
      })
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
  WINDOWS_ONNXRUNTIME_PRIVATE_NAME,
  WINDOWS_ONNXRUNTIME_UPSTREAM_NAME,
  getDownloadUrl,
  isCompleteInstall,
  parseMacosDeploymentTargets,
  privatizeWindowsOnnxRuntime,
  validateMacosDeploymentTargets,
  verifyPackagedMacosParakeet,
};

// Only run main() when executed directly
if (require.main === module) {
  main().catch(console.error);
}
