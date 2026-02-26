#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  downloadFile,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
} = require("./lib/download-utils");

const SHERPA_ONNX_VERSION = "1.12.23";
const GITHUB_RELEASE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`;

// Binary configurations for each platform
// Note: macOS uses universal2 builds that work on both arm64 and x64
const BINARIES = {
  "darwin-arm64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-universal2-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-darwin-arm64",
    libPattern: "*.dylib",
  },
  "darwin-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-universal2-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-darwin-x64",
    libPattern: "*.dylib",
  },
  "win32-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-win-x64-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server.exe",
    outputName: "sherpa-onnx-ws-win32-x64.exe",
    libPattern: "*.dll",
  },
  "linux-x64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-linux-x64-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-linux-x64",
    libPattern: "*.so*",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

function getDownloadUrl(archiveName) {
  return `${GITHUB_RELEASE_URL}/${archiveName}`;
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

async function downloadBinary(platformArch, config, isForce = false) {
  if (!config) {
    console.log(`  ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);

  if (fs.existsSync(outputPath) && !isForce) {
    console.log(`  ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }

  const url = getDownloadUrl(config.archiveName);
  console.log(`  ${platformArch}: Downloading from ${url}`);

  const archivePath = path.join(BIN_DIR, config.archiveName);

  try {
    await downloadFile(url, archivePath);

    const extractDir = path.join(BIN_DIR, `temp-sherpa-${platformArch}`);
    fs.mkdirSync(extractDir, { recursive: true });
    extractTarBz2(archivePath, extractDir);

    // Find the binary (may be in a subdirectory)
    const binaryName = path.basename(config.binaryPath);
    let binaryPath = findBinaryInDir(extractDir, binaryName);

    if (binaryPath && fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  ${platformArch}: Extracted to ${config.outputName}`);

      // Copy shared libraries
      if (config.libPattern) {
        const libraries = findLibrariesInDir(extractDir, config.libPattern);

        // Separate versioned and unversioned libraries to create symlinks where possible
        // e.g. libonnxruntime.dylib -> libonnxruntime.1.23.2.dylib (saves ~71MB)
        const versionedLibs = new Map(); // base name -> versioned file name

        for (const libPath of libraries) {
          const libName = path.basename(libPath);
          const destPath = path.join(BIN_DIR, libName);

          // Detect versioned dylib pattern: libFoo.X.Y.Z.dylib
          const versionMatch = libName.match(/^(lib.+?)\.(\d+\.\d+\.\d+)\.(dylib|so|dll)$/);
          if (versionMatch) {
            const baseName = `${versionMatch[1]}.${versionMatch[3]}`; // e.g. libonnxruntime.dylib
            versionedLibs.set(baseName, libName);
          }

          fs.copyFileSync(libPath, destPath);
          setExecutable(destPath);
          console.log(`  ${platformArch}: Copied library ${libName}`);
        }

        // Replace unversioned copies with symlinks to versioned ones (macOS/Linux only)
        if (process.platform !== "win32") {
          for (const [baseName, versionedName] of versionedLibs) {
            const basePath = path.join(BIN_DIR, baseName);
            const versionedPath = path.join(BIN_DIR, versionedName);
            if (
              fs.existsSync(basePath) &&
              fs.existsSync(versionedPath) &&
              !fs.lstatSync(basePath).isSymbolicLink()
            ) {
              fs.unlinkSync(basePath);
              fs.symlinkSync(versionedName, basePath);
              console.log(`  ${platformArch}: Symlinked ${baseName} -> ${versionedName}`);
            }
          }
        }
      }
    } else {
      console.error(`  ${platformArch}: Binary '${binaryName}' not found in archive`);
      return false;
    }

    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    return true;
  } catch (error) {
    console.error(`  ${platformArch}: Failed - ${error.message}`);
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    return false;
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

    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(args.platformArch, BINARIES[args.platformArch], args.isForce);
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
      cleanupFiles(BIN_DIR, "sherpa-onnx", `sherpa-onnx-ws-${args.platformArch}`);
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
  getDownloadUrl,
};

// Only run main() when executed directly
if (require.main === module) {
  main().catch(console.error);
}
