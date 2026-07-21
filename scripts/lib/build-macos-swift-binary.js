const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ARCH_TO_TARGET = {
  arm64: "arm64-apple-macosx11.0",
  x64: "x86_64-apple-macosx10.15",
};

// Mach-O CPU type constants for architecture verification
const ARCH_CPU_TYPE = {
  arm64: 0x0100000c, // CPU_TYPE_ARM64
  x64: 0x01000007, // CPU_TYPE_X86_64
};

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

// Shared build flow for the macOS Swift helper binaries (mic listener, globe
// listener, text monitor, calendar listener). Compiles resources/<sourceName>
// to resources/bin/<binaryName> for the target arch, skipping the build when
// the binary is up to date (mtime + source hash + arch check). Exits the
// process on failure, matching the original standalone scripts.
// linkerInfoPlist embeds the given plist as a __TEXT,__info_plist section so
// unbundled binaries can carry a bundle id and privacy usage strings.
function buildMacosSwiftBinary({ label, sourceName, binaryName, frameworks = [], linkerInfoPlist }) {
  if (process.platform !== "darwin") {
    process.exit(0);
  }

  // Support cross-compilation via --arch flag or TARGET_ARCH env var
  const archIndex = process.argv.indexOf("--arch");
  const targetArch =
    (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

  const swiftTarget = ARCH_TO_TARGET[targetArch];
  if (!swiftTarget) {
    console.error(`[${label}] Unsupported architecture: ${targetArch}`);
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, "..", "..");
  const swiftSource = path.join(projectRoot, "resources", sourceName);
  const outputDir = path.join(projectRoot, "resources", "bin");
  const outputBinary = path.join(outputDir, binaryName);
  const hashFile = path.join(outputDir, `.${binaryName}.${targetArch}.hash`);
  const moduleCacheDir = path.join(outputDir, ".swift-module-cache");

  function log(message) {
    console.log(`[${label}] ${message}`);
  }

  if (!fs.existsSync(swiftSource)) {
    console.error(`[${label}] Swift source not found at ${swiftSource}`);
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

  // Hash the Swift source plus any embedded plist, so edits to either rebuild
  function computeSourceHash() {
    let content = fs.readFileSync(swiftSource, "utf8");
    if (linkerInfoPlist) content += fs.readFileSync(linkerInfoPlist, "utf8");
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  // Secondary check: compare source hash
  if (!needsBuild && fs.existsSync(outputBinary)) {
    try {
      const currentHash = computeSourceHash();

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

  const infoPlistArgs = linkerInfoPlist
    ? ["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", linkerInfoPlist]
    : [];
  const compileArgs = [
    swiftSource,
    "-O",
    "-target",
    swiftTarget,
    "-module-cache-path",
    moduleCacheDir,
    "-o",
    outputBinary,
    ...infoPlistArgs,
    ...frameworks.flatMap((framework) => ["-framework", framework]),
  ];

  let result = attemptCompile("xcrun", ["swiftc", ...compileArgs]);

  if (result.status !== 0) {
    result = attemptCompile("swiftc", compileArgs);
  }

  if (result.status !== 0) {
    console.error(`[${label}] Failed to compile ${binaryName} binary.`);
    process.exit(result.status ?? 1);
  }

  try {
    fs.chmodSync(outputBinary, 0o755);
  } catch (error) {
    console.warn(`[${label}] Unable to set executable permissions: ${error.message}`);
  }

  // Verify the compiled binary matches the target architecture
  if (!verifyBinaryArch(outputBinary, targetArch)) {
    console.error(
      `[${label}] FATAL: Compiled binary architecture does not match target (${targetArch}). ` +
        `This can happen when cross-compiling without setting TARGET_ARCH env var.`
    );
    process.exit(1);
  }

  // Save source hash after successful build
  try {
    fs.writeFileSync(hashFile, computeSourceHash());
  } catch (err) {
    // Non-critical, just log
    log(`Warning: Could not save source hash: ${err.message}`);
  }

  log(`Successfully built ${binaryName} (${targetArch}).`);
}

module.exports = { buildMacosSwiftBinary };
