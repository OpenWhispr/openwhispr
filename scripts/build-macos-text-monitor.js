#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isMac = process.platform === "darwin";
if (!isMac) {
  process.exit(0);
}

// Support cross-compilation via --arch flag or TARGET_ARCH env var
const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

const ARCH_TO_TARGET = {
  arm64: "arm64-apple-macosx11.0",
  x64: "x86_64-apple-macosx10.15",
};
const swiftTarget = ARCH_TO_TARGET[targetArch];
if (!swiftTarget) {
  console.error(`[text-monitor] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const swiftSource = path.join(projectRoot, "resources", "macos-text-monitor.swift");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "macos-text-monitor");
const hashFile = path.join(outputDir, `.macos-text-monitor.${targetArch}.hash`);
const moduleCacheDir = path.join(outputDir, ".swift-module-cache");

// Mach-O CPU type constants for architecture verification
const ARCH_CPU_TYPE = {
  arm64: 0x0100000c, // CPU_TYPE_ARM64
  x64: 0x01000007, // CPU_TYPE_X86_64
};

function log(message) {
  console.log(`[text-monitor] ${message}`);
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

    const magic = header.readUInt32LE(0);
    if (magic !== 0xfeedfacf) {
      // Not a 64-bit Mach-O
      return false;
    }
    const cpuType = header.readInt32LE(4);
    const expectedCpu = ARCH_CPU_TYPE[expectedArch];
    return cpuType === expectedCpu;
  } catch {
    return false;
  }
}

if (!fs.existsSync(swiftSource)) {
  console.error(`[text-monitor] Swift source not found at ${swiftSource}`);
  process.exit(1);
}

ensureDir(outputDir);
ensureDir(moduleCacheDir);

let needsBuild = true;
if (fs.existsSync(outputBinary)) {
  // Verify existing binary matches the target architecture
  if (!verifyBinaryArch(outputBinary, targetArch)) {
    log(`Existing binary is wrong architecture (expected ${targetArch}), rebuild needed`);
    needsBuild = true;
  } else {
    try {
      const binaryStat = fs.statSync(outputBinary);
      const sourceStat = fs.statSync(swiftSource);
      if (binaryStat.mtimeMs >= sourceStat.mtimeMs) {
        needsBuild = false;
      }
    } catch {
      needsBuild = true;
    }
  }
}

// Secondary check: compare source hash
if (!needsBuild && fs.existsSync(outputBinary)) {
  try {
    const sourceContent = fs.readFileSync(swiftSource, "utf8");
    const currentHash = crypto.createHash("sha256").update(sourceContent).digest("hex");

    if (fs.existsSync(hashFile)) {
      const savedHash = fs.readFileSync(hashFile, "utf8").trim();
      if (savedHash !== currentHash) {
        log("Source hash changed, rebuild needed");
        needsBuild = true;
      }
    } else {
      // No hash file for this architecture — force rebuild to ensure correct arch
      log(`No hash file for ${targetArch}, rebuild needed`);
      needsBuild = true;
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
];

let result = attemptCompile("xcrun", ["swiftc", ...compileArgs]);

if (result.status !== 0) {
  result = attemptCompile("swiftc", compileArgs);
}

if (result.status !== 0) {
  console.error("[text-monitor] Failed to compile macOS text monitor binary.");
  process.exit(result.status ?? 1);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[text-monitor] Unable to set executable permissions: ${error.message}`);
}

// Verify the compiled binary matches the target architecture
if (!verifyBinaryArch(outputBinary, targetArch)) {
  console.error(
    `[text-monitor] FATAL: Compiled binary architecture does not match target (${targetArch}). ` +
      `This can happen when cross-compiling without setting TARGET_ARCH env var.`
  );
  process.exit(1);
}

// Save source hash after successful build
try {
  const sourceContent = fs.readFileSync(swiftSource, "utf8");
  const hash = crypto.createHash("sha256").update(sourceContent).digest("hex");
  fs.writeFileSync(hashFile, hash);
} catch (err) {
  // Non-critical, just log
  log(`Warning: Could not save source hash: ${err.message}`);
}

log(`Successfully built macOS text monitor binary (${targetArch}).`);
