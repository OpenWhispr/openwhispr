#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") {
  process.exit(0);
}

const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

const ARCH_TO_TARGET = {
  arm64: "arm64-apple-macosx14.2",
  x64: "x86_64-apple-macosx14.2",
};

const ARCH_CPU_TYPE = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

const swiftTarget = ARCH_TO_TARGET[targetArch];
if (!swiftTarget) {
  console.error(`[audio-tap] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const swiftSource = path.join(projectRoot, "resources", "macos-audio-tap.swift");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "macos-audio-tap");
const hashFile = path.join(outputDir, `.macos-audio-tap.${targetArch}.hash`);
const moduleCacheDir = path.join(outputDir, ".swift-module-cache");

function log(message) {
  console.log(`[audio-tap] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function verifyBinaryArch(binaryPath, expectedArch) {
  try {
    const fd = fs.openSync(binaryPath, "r");
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);

    if (header.readUInt32LE(0) !== 0xfeedfacf) {
      return false;
    }

    return header.readInt32LE(4) === ARCH_CPU_TYPE[expectedArch];
  } catch {
    return false;
  }
}

if (!fs.existsSync(swiftSource)) {
  console.error(`[audio-tap] Swift source not found at ${swiftSource}`);
  process.exit(1);
}

ensureDir(outputDir);
ensureDir(moduleCacheDir);

let needsBuild = true;
if (fs.existsSync(outputBinary)) {
  if (!verifyBinaryArch(outputBinary, targetArch)) {
    log(`Existing binary is wrong architecture (expected ${targetArch}), rebuild needed`);
  } else {
    try {
      const binaryStat = fs.statSync(outputBinary);
      const sourceStat = fs.statSync(swiftSource);
      needsBuild = binaryStat.mtimeMs < sourceStat.mtimeMs;
    } catch {
      needsBuild = true;
    }
  }
}

if (!needsBuild && fs.existsSync(outputBinary)) {
  try {
    const sourceContent = fs.readFileSync(swiftSource, "utf8");
    const currentHash = crypto.createHash("sha256").update(sourceContent).digest("hex");
    const savedHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8").trim() : "";
    if (savedHash !== currentHash) {
      log("Source hash changed, rebuild needed");
      needsBuild = true;
    }
  } catch (error) {
    log(`Hash check failed: ${error.message}, forcing rebuild`);
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
    env: {
      ...process.env,
      SWIFT_MODULE_CACHE_PATH: moduleCacheDir,
    },
  });
}

const compileArgs = [
  swiftSource,
  "-O",
  "-target",
  swiftTarget,
  "-module-cache-path",
  moduleCacheDir,
  "-o",
  outputBinary,
  "-framework",
  "CoreAudio",
  "-framework",
  "AudioToolbox",
  "-framework",
  "AVFoundation",
  "-framework",
  "Foundation",
];

let result = attemptCompile("xcrun", ["swiftc", ...compileArgs]);
if (result.status !== 0) {
  result = attemptCompile("swiftc", compileArgs);
}

if (result.status !== 0) {
  console.error("[audio-tap] Failed to compile macOS audio tap binary.");
  process.exit(result.status ?? 1);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[audio-tap] Unable to set executable permissions: ${error.message}`);
}

if (!verifyBinaryArch(outputBinary, targetArch)) {
  console.error(
    `[audio-tap] FATAL: Compiled binary architecture does not match target (${targetArch}).`
  );
  process.exit(1);
}

try {
  const sourceContent = fs.readFileSync(swiftSource, "utf8");
  const hash = crypto.createHash("sha256").update(sourceContent).digest("hex");
  fs.writeFileSync(hashFile, hash);
} catch (error) {
  log(`Warning: Could not save source hash: ${error.message}`);
}

log(`Successfully built macOS audio tap binary (${targetArch}).`);
