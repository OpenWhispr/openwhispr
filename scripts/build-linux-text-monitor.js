#!/usr/bin/env node
/**
 * Ensures the Linux text monitor binary is available.
 *
 * Strategy:
 * 1. If binary exists and is up-to-date, do nothing
 * 2. Try to download prebuilt binary from GitHub releases
 * 3. Fall back to local compilation if download fails
 *
 * This allows developers without AT-SPI2 dev headers to still build the app.
 */

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isLinux = process.platform === "linux";
if (!isLinux) {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "linux-text-monitor.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "linux-text-monitor");
const hashFile = path.join(outputDir, ".linux-text-monitor.hash");

function log(message) {
  console.log(`[linux-text-monitor] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isBinaryUpToDate() {
  if (!fs.existsSync(outputBinary)) {
    return false;
  }

  if (!fs.existsSync(cSource)) {
    return true;
  }

  try {
    const binaryStat = fs.statSync(outputBinary);
    const sourceStat = fs.statSync(cSource);
    if (binaryStat.mtimeMs < sourceStat.mtimeMs) {
      return false;
    }
  } catch {
    return false;
  }

  // Check source + build flags hash
  try {
    const pkgFlags = getPkgConfigFlags();
    const flagStr = pkgFlags ? pkgFlags.join(" ") : "";
    const sourceContent = fs.readFileSync(cSource, "utf8");
    const currentHash = crypto
      .createHash("sha256")
      .update(sourceContent + flagStr)
      .digest("hex");

    if (fs.existsSync(hashFile)) {
      const savedHash = fs.readFileSync(hashFile, "utf8").trim();
      if (savedHash !== currentHash) {
        log("Source or build flags changed, rebuild needed");
        return false;
      }
    } else {
      fs.writeFileSync(hashFile, currentHash);
    }
  } catch (err) {
    log(`Hash check failed: ${err.message}, forcing rebuild`);
    return false;
  }

  return true;
}

async function tryDownload() {
  log("Attempting to download prebuilt binary...");

  const downloadScript = path.join(__dirname, "download-text-monitor.js");
  if (!fs.existsSync(downloadScript)) {
    log("Download script not found, skipping download");
    return false;
  }

  const result = spawnSync(process.execPath, [downloadScript, "--force"], {
    stdio: "inherit",
    cwd: projectRoot,
  });

  if (result.status === 0 && fs.existsSync(outputBinary)) {
    log("Successfully downloaded prebuilt binary");
    return true;
  }

  log("Download failed or binary not found after download");
  return false;
}

function getPkgConfigFlags() {
  try {
    const check = spawnSync("pkg-config", ["--exists", "atspi-2"], {
      stdio: "pipe",
      env: process.env,
    });
    if (check.status !== 0) return null;

    const result = spawnSync("pkg-config", ["--cflags", "--libs", "atspi-2"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (result.status !== 0) return null;

    return result.stdout.toString().trim().split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

function attemptCompile(command, args) {
  log(`Compiling with ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

function tryCompile() {
  if (!fs.existsSync(cSource)) {
    log("C source not found, cannot compile locally");
    return false;
  }

  const pkgFlags = getPkgConfigFlags();
  if (!pkgFlags) {
    log("AT-SPI2 development headers not found, cannot compile locally");
    return false;
  }

  log("Attempting local compilation...");

  const compileArgs = ["-O2", cSource, "-o", outputBinary, ...pkgFlags];

  let result = attemptCompile("gcc", compileArgs);
  if (result.status !== 0) {
    result = attemptCompile("cc", compileArgs);
  }

  if (result.status !== 0) {
    return false;
  }

  try {
    fs.chmodSync(outputBinary, 0o755);
  } catch (error) {
    console.warn(`[linux-text-monitor] Unable to set executable permissions: ${error.message}`);
  }

  try {
    const sourceContent = fs.readFileSync(cSource, "utf8");
    const flagStr = pkgFlags.join(" ");
    const hash = crypto
      .createHash("sha256")
      .update(sourceContent + flagStr)
      .digest("hex");
    fs.writeFileSync(hashFile, hash);
  } catch (err) {
    log(`Warning: Could not save source hash: ${err.message}`);
  }

  log("Successfully built Linux text monitor binary");
  return true;
}

async function main() {
  ensureDir(outputDir);

  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  const downloaded = await tryDownload();
  if (downloaded) {
    return;
  }

  const compiled = tryCompile();
  if (compiled) {
    return;
  }

  console.warn("[linux-text-monitor] Could not obtain Linux text monitor binary.");
  console.warn("[linux-text-monitor] Auto-learn correction monitoring will be disabled on Linux.");
  console.warn(
    "[linux-text-monitor] To compile locally, install libatspi2.0-dev and libglib2.0-dev. Falling back to Python script."
  );
}

main().catch((error) => {
  console.error("[linux-text-monitor] Unexpected error:", error);
});
