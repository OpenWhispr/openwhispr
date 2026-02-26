#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isLinux = process.platform === "linux";
if (!isLinux) {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "linux-fast-paste.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "linux-fast-paste");
const hashFile = path.join(outputDir, ".linux-fast-paste.hash");

function log(message) {
  console.log(`[linux-fast-paste] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

if (!fs.existsSync(cSource)) {
  console.error(`[linux-fast-paste] C source not found at ${cSource}`);
  process.exit(1);
}

ensureDir(outputDir);

let needsBuild = true;
if (fs.existsSync(outputBinary)) {
  try {
    const binaryStat = fs.statSync(outputBinary);
    const sourceStat = fs.statSync(cSource);
    if (binaryStat.mtimeMs >= sourceStat.mtimeMs) {
      needsBuild = false;
    }
  } catch {
    needsBuild = true;
  }
}

function hasUinputHeaders() {
  for (const compiler of ["gcc", "cc"]) {
    try {
      const result = spawnSync(compiler, ["-E", "-x", "c", "-"], {
        input: "#include <linux/uinput.h>\n",
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      if (result.status === 0) return true;
    } catch {}
  }
  return false;
}

const uinputAvailable = hasUinputHeaders();

function computeBuildHash() {
  const sourceContent = fs.readFileSync(cSource, "utf8");
  const flags = uinputAvailable ? "uinput" : "nouinput";
  return crypto
    .createHash("sha256")
    .update(sourceContent + flags)
    .digest("hex");
}

if (!needsBuild && fs.existsSync(outputBinary)) {
  try {
    const currentHash = computeBuildHash();

    if (fs.existsSync(hashFile)) {
      const savedHash = fs.readFileSync(hashFile, "utf8").trim();
      if (savedHash !== currentHash) {
        log("Source or build flags changed, rebuild needed");
        needsBuild = true;
      }
    } else {
      fs.writeFileSync(hashFile, currentHash);
    }
  } catch (err) {
    log(`Hash check failed: ${err.message}, forcing rebuild`);
    needsBuild = true;
  }
}

if (!needsBuild) {
  process.exit(0);
}

function attemptCompile(command, args) {
  log(`Compiling with ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

const compileArgs = ["-O2", cSource, "-o", outputBinary, "-lX11", "-lXtst"];

if (uinputAvailable) {
  log("uinput headers found, enabling uinput support");
  compileArgs.push("-DHAVE_UINPUT");
} else {
  log("uinput headers not found, building without uinput support");
}

let result = attemptCompile("gcc", compileArgs);

if (result.status !== 0) {
  result = attemptCompile("cc", compileArgs);
}

if (result.status !== 0) {
  console.warn(
    "[linux-fast-paste] Failed to compile Linux fast-paste binary. Install libx11-dev and libxtst-dev to enable native paste. Falling back to system tools."
  );
  process.exit(0);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[linux-fast-paste] Unable to set executable permissions: ${error.message}`);
}

try {
  fs.writeFileSync(hashFile, computeBuildHash());
} catch (err) {
  log(`Warning: Could not save source hash: ${err.message}`);
}

log("Successfully built Linux fast-paste binary.");
