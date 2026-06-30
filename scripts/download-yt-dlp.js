#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { downloadFile, parseArgs, setExecutable } = require("./lib/download-utils");

const YT_DLP_VERSION = "2026.06.09";
const GITHUB_RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}`;

// yt-dlp ships single self-contained PyInstaller binaries (no archive to extract).
// macOS asset is universal2 and serves both arm64 and x64.
const BINARIES = {
  "darwin-arm64": {
    assetName: "yt-dlp_macos",
    outputName: "yt-dlp-darwin-arm64",
  },
  "darwin-x64": {
    assetName: "yt-dlp_macos",
    outputName: "yt-dlp-darwin-x64",
  },
  "win32-x64": {
    assetName: "yt-dlp.exe",
    outputName: "yt-dlp-win32-x64.exe",
  },
  "linux-x64": {
    assetName: "yt-dlp_linux",
    outputName: "yt-dlp-linux-x64",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

function getDownloadUrl(assetName) {
  return `${GITHUB_RELEASE_URL}/${assetName}`;
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

  const url = getDownloadUrl(config.assetName);
  console.log(`  ${platformArch}: Downloading from ${url}`);

  try {
    await downloadFile(url, outputPath);
    setExecutable(outputPath);
    console.log(`  ${platformArch}: Saved to ${config.outputName}`);
    return true;
  } catch (error) {
    console.error(`  ${platformArch}: Failed - ${error.message}`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return false;
  }
}

async function main() {
  console.log(`\nDownloading yt-dlp binaries (${YT_DLP_VERSION})...\n`);

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
      console.error(`Failed to download binary for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      await downloadBinary(platformArch, BINARIES[platformArch], args.isForce);
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("yt-dlp-"));
  if (files.length > 0) {
    console.log("Available yt-dlp binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nCheck: https://github.com/yt-dlp/yt-dlp/releases/tag/${YT_DLP_VERSION}`);
  }
}

// Export config for potential imports
module.exports = {
  YT_DLP_VERSION,
  BINARIES,
  BIN_DIR,
  getDownloadUrl,
};

// Only run main() when executed directly
if (require.main === module) {
  main().catch(console.error);
}
