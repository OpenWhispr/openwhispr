#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isLinux = process.platform === "linux";
if (!isLinux) {
  console.log("[linux-key-listener] Skipping: not on Linux");
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "linux-key-listener.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const targetArch = process.arch;
const outputBinary = path.join(outputDir, `linux-key-listener-${targetArch}`);
const hashFile = path.join(outputDir, `.linux-key-listener.${targetArch}.hash`);

function log(message) {
  console.log(`[linux-key-listener] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

if (!fs.existsSync(cSource)) {
  console.error(`[linux-key-listener] C source not found at ${cSource}`);
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

function computeBuildHash() {
  const sourceContent = fs.readFileSync(cSource, "utf8");
  return crypto.createHash("sha256").update(sourceContent).digest("hex");
}

if (!needsBuild && fs.existsSync(outputBinary)) {
  try {
    const currentHash = computeBuildHash();

    if (fs.existsSync(hashFile)) {
      const savedHash = fs.readFileSync(hashFile, "utf8").trim();
      if (savedHash !== currentHash) {
        log("Source changed, rebuild needed");
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

const compileArgs = ["-O2", "-Wall", "-Wextra", cSource, "-o", outputBinary];

let result = attemptCompile("gcc", compileArgs);

if (result.status !== 0) {
  result = attemptCompile("cc", compileArgs);
}

if (result.status !== 0) {
  console.error(
    "[linux-key-listener] Failed to compile Linux key listener binary.\n" +
      "  Install gcc with: sudo apt install build-essential\n" +
      "                 or: sudo dnf install gcc"
  );
  process.exit(1);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[linux-key-listener] Unable to set executable permissions: ${error.message}`);
}

try {
  fs.writeFileSync(hashFile, computeBuildHash());
} catch (err) {
  log(`Warning: Could not save source hash: ${err.message}`);
}

log(`Successfully built Linux key listener binary (${targetArch}).`);
