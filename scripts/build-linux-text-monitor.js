#!/usr/bin/env node
/**
 * Ensures the Linux text monitor binary is available.
 *
 * Strategy:
 * 1. If binary exists and is up-to-date, do nothing
 * 2. Compile locally when the AT-SPI2 dev headers are installed
 * 3. Otherwise download the prebuilt binary from GitHub releases
 *
 * Compiling comes first because a release carries no source hash: it can
 * predate resources/linux-text-monitor.c, as linux-text-monitor-v1.0.0 did
 * once --probe-editable was added. The download lets developers without
 * AT-SPI2 dev headers still build the app.
 */

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

function sourceHash(pkgFlags) {
  const sourceContent = fs.readFileSync(cSource, "utf8");
  const flagStr = pkgFlags ? pkgFlags.join(" ") : "";
  return crypto
    .createHash("sha256")
    .update(sourceContent + flagStr)
    .digest("hex");
}

// A download is recorded against the source it was fetched for, so a source
// change fetches again and picks up a newer release.
function downloadedHash(hash) {
  return `downloaded:${hash}`;
}

/**
 * A downloaded binary stands only while there is no way to compile. A binary
 * with no recorded hash is of unknown origin and is rebuilt.
 */
function isBinaryUpToDate({ binaryExists, sourceExists, savedHash, currentHash, canCompile }) {
  if (!binaryExists) return false;
  if (!sourceExists) return true;
  if (!currentHash) return false;
  if (savedHash === downloadedHash(currentHash)) return !canCompile;
  return savedHash === currentHash;
}

/**
 * With headers installed, a failed compile is a broken source, which CI must
 * not paper over with a release.
 */
function obtainSteps({ canCompile, inCI }) {
  if (!canCompile) return ["download"];
  return inCI ? ["compile"] : ["compile", "download"];
}

function readBuildState(pkgFlags) {
  const sourceExists = fs.existsSync(cSource);
  let savedHash = null;
  let currentHash = null;
  try {
    if (fs.existsSync(hashFile)) savedHash = fs.readFileSync(hashFile, "utf8").trim();
    if (sourceExists) currentHash = sourceHash(pkgFlags);
  } catch (err) {
    log(`Hash check failed: ${err.message}, forcing rebuild`);
  }
  return {
    binaryExists: fs.existsSync(outputBinary),
    sourceExists,
    savedHash,
    currentHash,
    canCompile: Boolean(pkgFlags),
  };
}

async function tryDownload(pkgFlags) {
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
    try {
      fs.writeFileSync(hashFile, downloadedHash(sourceHash(pkgFlags)));
    } catch (err) {
      log(`Warning: Could not record download: ${err.message}`);
    }
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

    // atspi-2.pc lists gobject-2.0 under Requires.private, so plain --libs
    // omits -lgobject-2.0; add it explicitly for --as-needed linkers.
    return [...result.stdout.toString().trim().split(/\s+/).filter(Boolean), "-lgobject-2.0"];
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

function tryCompile(pkgFlags) {
  if (!fs.existsSync(cSource)) {
    log("C source not found, cannot compile locally");
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
    fs.writeFileSync(hashFile, sourceHash(pkgFlags));
  } catch (err) {
    log(`Warning: Could not save source hash: ${err.message}`);
  }

  log("Successfully built Linux text monitor binary");
  return true;
}

async function main() {
  ensureDir(outputDir);

  const pkgFlags = getPkgConfigFlags();
  if (isBinaryUpToDate(readBuildState(pkgFlags))) {
    log("Binary is up to date, skipping build");
    return;
  }

  if (!pkgFlags) {
    log("AT-SPI2 development headers not found, cannot compile locally");
  }

  const steps = obtainSteps({ canCompile: Boolean(pkgFlags), inCI: Boolean(process.env.CI) });
  for (const step of steps) {
    if (step === "compile" && tryCompile(pkgFlags)) return;
    if (step === "download") {
      if (pkgFlags) {
        console.warn(
          "[linux-text-monitor] Compilation failed; the prebuilt release may predate resources/linux-text-monitor.c."
        );
      }
      if (await tryDownload(pkgFlags)) return;
    }
  }

  if (!steps.includes("download")) {
    console.error("[linux-text-monitor] Compilation failed; refusing a prebuilt fallback in CI.");
    process.exitCode = 1;
    return;
  }

  console.warn("[linux-text-monitor] Could not obtain Linux text monitor binary.");
  console.warn("[linux-text-monitor] Auto-learn correction monitoring will be disabled on Linux.");
  console.warn(
    "[linux-text-monitor] To compile locally, install libatspi2.0-dev and libglib2.0-dev. Falling back to Python script."
  );
}

if (require.main === module && process.platform === "linux") {
  main().catch((error) => {
    console.error("[linux-text-monitor] Unexpected error:", error);
  });
}

module.exports = { downloadedHash, isBinaryUpToDate, obtainSteps };
