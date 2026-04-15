#!/usr/bin/env node
/**
 * Downloads prebuilt meeting AEC helper binary from GitHub releases.
 *
 * Usage:
 *   node scripts/download-meeting-aec-helper.js [--current|--all] [--platform p --arch a] [--force]
 */

const fs = require("fs");
const path = require("path");
const {
  cleanupFiles,
  downloadFile,
  extractArchive,
  fetchLatestRelease,
  parseArgs,
  setExecutable,
} = require("./lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const TAG_PREFIX = "meeting-aec-helper-v";
const VERSION_OVERRIDE = process.env.MEETING_AEC_HELPER_VERSION || null;
const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

const TARGETS = [
  { platform: "darwin", arch: "arm64", ext: "tar.gz" },
  { platform: "darwin", arch: "x64", ext: "tar.gz" },
  { platform: "linux", arch: "x64", ext: "tar.gz" },
  { platform: "win32", arch: "x64", ext: "zip" },
];

const binaryName = ({ platform, arch }) =>
  `meeting-aec-helper-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;

const archiveName = ({ platform, arch, ext }) =>
  `meeting-aec-helper-${platform}-${arch}.${ext}`;

async function downloadTarget(target, release, force) {
  const binary = binaryName(target);
  const outputPath = path.join(BIN_DIR, binary);

  if (fs.existsSync(outputPath) && !force) {
    console.log(`[meeting-aec-helper] ${binary} already exists`);
    return;
  }

  const archive = archiveName(target);
  const asset = release.assets.find((a) => a.name === archive);
  if (!asset) {
    console.warn(`[meeting-aec-helper] Release ${release.tag} missing ${archive}`);
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const archivePath = path.join(BIN_DIR, archive);
  const extractDir = path.join(BIN_DIR, `temp-meeting-aec-helper-${target.platform}-${target.arch}`);

  try {
    console.log(`  Downloading ${archive}...`);
    await downloadFile(asset.url, archivePath);

    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir);

    const extractedBinary = path.join(extractDir, binary);
    if (!fs.existsSync(extractedBinary)) {
      throw new Error(`Binary not found in archive: ${binary}`);
    }

    fs.copyFileSync(extractedBinary, outputPath);
    setExecutable(outputPath);

    const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
    console.log(`[meeting-aec-helper] Downloaded ${binary} (${sizeKb}KB)`);
  } catch (error) {
    console.error(`[meeting-aec-helper] ${binary} failed: ${error.message}`);
    console.log("[meeting-aec-helper] Meeting AEC will fall back to JS echo leak detector");
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }
  }
}

async function main() {
  const args = parseArgs();

  const selected = args.isAll
    ? TARGETS
    : TARGETS.filter((t) => t.platform === args.targetPlatform && t.arch === args.targetArch);

  if (selected.length === 0) {
    console.log(
      `[meeting-aec-helper] No target for ${args.targetPlatform}-${args.targetArch}, skipping`
    );
    return;
  }

  if (VERSION_OVERRIDE) {
    console.log(`\n[meeting-aec-helper] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[meeting-aec-helper] Fetching latest release...");
  }
  const release = await fetchLatestRelease(REPO, {
    tagPrefix: VERSION_OVERRIDE || TAG_PREFIX,
  });

  if (!release) {
    console.warn("[meeting-aec-helper] No release found, skipping download");
    console.log("[meeting-aec-helper] Meeting AEC will fall back to JS echo leak detector");
    return;
  }

  for (const target of selected) {
    await downloadTarget(target, release, args.isForce);
  }

  if (args.shouldCleanup && !args.isAll) {
    cleanupFiles(BIN_DIR, "meeting-aec-helper-", `meeting-aec-helper-${args.platformArch}`);
  }
}

main().catch((error) => {
  console.error("[meeting-aec-helper] Unexpected error:", error.message);
});
