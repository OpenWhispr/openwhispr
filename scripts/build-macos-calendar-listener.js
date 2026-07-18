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
  console.error(`[calendar-listener] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const swiftSource = path.join(projectRoot, "resources", "macos-calendar-listener.swift");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "macos-calendar-listener");
const hashFile = path.join(outputDir, `.macos-calendar-listener.${targetArch}.hash`);
const moduleCacheDir = path.join(outputDir, ".swift-module-cache");

// Mach-O CPU type constants for architecture verification
const ARCH_CPU_TYPE = {
  arm64: 0x0100000c, // CPU_TYPE_ARM64
  x64: 0x01000007, // CPU_TYPE_X86_64
};

function log(message) {
  console.log(`[calendar-listener] ${message}`);
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

// Dev Electron ships without calendar usage strings; without them the TCC
// request from the spawned helper aborts. Patch the dev app bundle once and
// re-ad-hoc-sign it. Packaged builds get the strings via electron-builder's
// mac.extendInfo instead.
function patchDevElectronPlist() {
  const electronApp = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");
  const plistPath = path.join(electronApp, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) return;

  const usage =
    "OpenWhispr reads your calendar to detect upcoming meetings and link meeting notes to events.";
  const keys = ["NSCalendarsUsageDescription", "NSCalendarsFullAccessUsageDescription"];
  const missing = keys.filter(
    (key) => spawnSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath]).status !== 0
  );
  if (missing.length === 0) return;

  for (const key of missing) {
    const result = spawnSync("plutil", ["-insert", key, "-string", usage, plistPath]);
    if (result.status !== 0) {
      log(`Warning: failed to insert ${key} into dev Electron Info.plist`);
      return;
    }
  }

  const signResult = spawnSync("codesign", ["--force", "--sign", "-", electronApp]);
  if (signResult.status !== 0) {
    log("Warning: failed to re-sign dev Electron after Info.plist patch");
    return;
  }
  log("Patched dev Electron Info.plist with calendar usage strings and re-signed the bundle.");
  log(
    "NOTE: re-signing changes dev Electron's code hash, so macOS drops its previously granted " +
      "permissions (Accessibility, Microphone, Screen & System Audio Recording). Re-grant them " +
      "in System Settings > Privacy & Security when prompted."
  );
}

if (!fs.existsSync(swiftSource)) {
  console.error(`[calendar-listener] Swift source not found at ${swiftSource}`);
  process.exit(1);
}

ensureDir(outputDir);
ensureDir(moduleCacheDir);
patchDevElectronPlist();

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
  "-framework",
  "EventKit",
  "-framework",
  "Foundation",
];

let result = attemptCompile("xcrun", ["swiftc", ...compileArgs]);

if (result.status !== 0) {
  result = attemptCompile("swiftc", compileArgs);
}

if (result.status !== 0) {
  console.error("[calendar-listener] Failed to compile macOS calendar listener binary.");
  process.exit(result.status ?? 1);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[calendar-listener] Unable to set executable permissions: ${error.message}`);
}

// Verify the compiled binary matches the target architecture
if (!verifyBinaryArch(outputBinary, targetArch)) {
  console.error(
    `[calendar-listener] FATAL: Compiled binary architecture does not match target (${targetArch}). ` +
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

log(`Successfully built macOS calendar listener binary (${targetArch}).`);
