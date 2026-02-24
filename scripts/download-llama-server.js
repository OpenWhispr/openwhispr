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

const LLAMA_CPP_REPO = "ggerganov/llama.cpp";

// Version can be pinned via environment variable for reproducible builds
const VERSION_OVERRIDE = process.env.LLAMA_CPP_VERSION || null;

const BINARIES = {
  "darwin-arm64": {
    platformArch: "darwin-arm64",
    assetPattern: /^llama-.*-bin-macos-arm64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-darwin-arm64",
    libPattern: "*.dylib",
  },
  "darwin-x64": {
    platformArch: "darwin-x64",
    assetPattern: /^llama-.*-bin-macos-x64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-darwin-x64",
    libPattern: "*.dylib",
  },
  "win32-x64-cpu": {
    platformArch: "win32-x64",
    assetPattern: /^llama-.*-bin-win-cpu-x64\.zip$/,
    binaryPath: "build/bin/llama-server.exe",
    outputName: "llama-server-win32-x64-cpu.exe",
    libPattern: "*.dll",
  },
  "linux-x64-cpu": {
    platformArch: "linux-x64",
    assetPattern: /^llama-.*-bin-ubuntu-x64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-linux-x64-cpu",
    libPattern: "*.so*",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

let cachedRelease = null;

async function getRelease() {
  if (cachedRelease) return cachedRelease;

  if (VERSION_OVERRIDE) {
    cachedRelease = await fetchLatestRelease(LLAMA_CPP_REPO, { tagPrefix: VERSION_OVERRIDE });
  } else {
    cachedRelease = await fetchLatestRelease(LLAMA_CPP_REPO);
  }
  return cachedRelease;
}

function findAsset(release, pattern) {
  return release?.assets?.find((a) => pattern.test(a.name));
}

function findLibrariesInDir(dir, pattern, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...findLibrariesInDir(fullPath, pattern, maxDepth, currentDepth + 1));
    } else if (matchesPattern(entry.name, pattern)) {
      results.push(fullPath);
    }
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

async function downloadBinary(key, config, release, isForce = false) {
  if (!config) {
    console.log(`  ${key}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);

  if (fs.existsSync(outputPath) && !isForce) {
    console.log(`  ${key}: Already exists (use --force to re-download)`);
    return true;
  }

  const asset = findAsset(release, config.assetPattern);
  if (!asset) {
    console.error(`  ${key}: No matching asset found for pattern ${config.assetPattern}`);
    return false;
  }

  console.log(`  ${key}: Downloading from ${asset.url}`);

  const zipPath = path.join(BIN_DIR, asset.name);

  try {
    await downloadFile(asset.url, zipPath);

    const extractDir = path.join(BIN_DIR, `temp-llama-${key}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(zipPath, extractDir);

    const binaryName = path.basename(config.binaryPath);
    let binaryPath = path.join(extractDir, config.binaryPath);

    if (!fs.existsSync(binaryPath)) {
      binaryPath = findBinaryInDir(extractDir, binaryName);
    }

    if (binaryPath && fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  ${key}: Extracted to ${config.outputName}`);

      if (config.libPattern) {
        const libraries = findLibrariesInDir(extractDir, config.libPattern);

        for (const libPath of libraries) {
          const libName = path.basename(libPath);
          const destPath = path.join(BIN_DIR, libName);

          fs.copyFileSync(libPath, destPath);
          setExecutable(destPath);
          console.log(`  ${key}: Copied library ${libName}`);
        }
      }
    } else {
      console.error(`  ${key}: Binary '${binaryName}' not found in archive`);
      return false;
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return true;
  } catch (error) {
    console.error(`  ${key}: Failed - ${error.message}`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return false;
  }
}

function getEntriesForPlatformArch(platformArch) {
  return Object.entries(BINARIES).filter(([, config]) => config.platformArch === platformArch);
}

async function main() {
  if (VERSION_OVERRIDE) {
    console.log(`\n[llama-server] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[llama-server] Fetching latest release...");
  }
  const release = await getRelease();

  if (!release) {
    console.error(`[llama-server] Could not fetch release from ${LLAMA_CPP_REPO}`);
    console.log(`\nMake sure release exists: https://github.com/${LLAMA_CPP_REPO}/releases`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nDownloading llama-server binaries (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (args.isCurrent) {
    const entries = getEntriesForPlatformArch(args.platformArch);

    if (entries.length === 0) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Downloading for target platform (${args.platformArch}):`);

    for (const [key, config] of entries) {
      const ok = await downloadBinary(key, config, release, args.isForce);
      if (!ok && config.optional) {
        console.warn(`  ${key}: Skipping optional variant`);
      } else if (!ok) {
        console.error(`Failed to download binaries for ${key}`);
        process.exitCode = 1;
        return;
      }
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "llama-server", `llama-server-${args.platformArch}`);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const [key, config] of Object.entries(BINARIES)) {
      const ok = await downloadBinary(key, config, release, args.isForce);
      if (!ok && config.optional) {
        console.warn(`  ${key}: Skipping optional variant`);
      }
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("llama-server"));
  if (files.length > 0) {
    console.log("Available llama-server binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${LLAMA_CPP_REPO}/releases`);
  }
}

main().catch(console.error);
