#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

if (process.platform !== "linux") {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "linux-system-audio-helper.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "linux-system-audio-helper");
const hashFile = path.join(outputDir, ".linux-system-audio-helper.hash");

function log(message) {
  console.log(`[linux-system-audio-helper] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getGioFlags() {
  try {
    const result = spawnSync("pkg-config", ["--cflags", "--libs", "gio-2.0"], {
      stdio: "pipe",
      env: process.env,
    });
    if (result.status !== 0) {
      return null;
    }

    return result.stdout.toString().trim().split(/\s+/).filter(Boolean);
  } catch {
    return null;
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

  try {
    const flags = getGioFlags();
    const sourceContent = fs.readFileSync(cSource, "utf8");
    const currentHash = crypto
      .createHash("sha256")
      .update(sourceContent + (flags ? flags.join(" ") : "no-gio"))
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
  } catch (error) {
    log(`Hash check failed: ${error.message}, forcing rebuild`);
    return false;
  }

  return true;
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
    console.error(`[linux-system-audio-helper] C source not found at ${cSource}`);
    return false;
  }

  const gioFlags = getGioFlags();
  if (!gioFlags) {
    log("gio-2.0 not found, skipping native helper build");
    return false;
  }

  log("gio-2.0 found, building native portal helper");

  const compileArgs = ["-O2", cSource, "-o", outputBinary, ...gioFlags];

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
    console.warn(`[linux-system-audio-helper] Unable to set executable permissions: ${error.message}`);
  }

  try {
    const sourceContent = fs.readFileSync(cSource, "utf8");
    const hash = crypto
      .createHash("sha256")
      .update(sourceContent + gioFlags.join(" "))
      .digest("hex");
    fs.writeFileSync(hashFile, hash);
  } catch (error) {
    log(`Warning: Could not save source hash: ${error.message}`);
  }

  log("Successfully built Linux system audio helper binary");
  return true;
}

function main() {
  ensureDir(outputDir);

  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  if (!tryCompile()) {
    console.warn(
      "[linux-system-audio-helper] Native Linux portal helper is unavailable. Linux system audio will stay on the current fallback path."
    );
  }
}

main();
