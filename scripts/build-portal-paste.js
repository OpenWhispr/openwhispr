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
const cSource = path.join(projectRoot, "resources", "portal-paste.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "portal-paste");
const hashFile = path.join(outputDir, ".portal-paste.hash");

function log(message) {
  console.log(`[portal-paste] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

if (!fs.existsSync(cSource)) {
  console.error(`[portal-paste] C source not found at ${cSource}`);
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

function hasGio() {
  try {
    const result = spawnSync("pkg-config", ["--exists", "gio-2.0"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

if (!hasGio()) {
  log("gio-2.0 not found (install libglib2.0-dev or glib2-devel). Skipping portal-paste build.");
  process.exit(0);
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

function getPkgConfigFlags() {
  const result = spawnSync("pkg-config", ["--cflags", "--libs", "gio-2.0"], {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split(/\s+/);
}

const pkgFlags = getPkgConfigFlags();
if (!pkgFlags) {
  log("Failed to get gio-2.0 compile flags. Skipping portal-paste build.");
  process.exit(0);
}

function attemptCompile(command, args) {
  log(`Compiling with ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

const compileArgs = ["-O2", cSource, "-o", outputBinary, ...pkgFlags];

let result = attemptCompile("gcc", compileArgs);

if (result.status !== 0) {
  result = attemptCompile("cc", compileArgs);
}

if (result.status !== 0) {
  console.warn(
    "[portal-paste] Failed to compile portal-paste binary. Install libglib2.0-dev (Debian/Ubuntu) or glib2-devel (Fedora) to enable portal-based paste on GNOME/KDE Wayland."
  );
  process.exit(0);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[portal-paste] Unable to set executable permissions: ${error.message}`);
}

try {
  fs.writeFileSync(hashFile, computeBuildHash());
} catch (err) {
  log(`Warning: Could not save source hash: ${err.message}`);
}

log("Successfully built portal-paste binary.");
