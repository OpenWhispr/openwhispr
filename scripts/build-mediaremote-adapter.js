#!/usr/bin/env node

// Builds resources/bin/MediaRemoteAdapter.framework from the vendored
// ungive/mediaremote-adapter sources under resources/mediaremote-adapter/.
//
// The framework is loaded at runtime by /usr/bin/perl, which is the only path
// that can talk to MediaRemote on macOS 15.4+. See src/helpers/mediaPlayer.js
// for the consumer side.

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isMac = process.platform === "darwin";
if (!isMac) {
  process.exit(0);
}

const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

const ARCH_TO_TARGET = {
  arm64: "arm64-apple-macos11.0",
  x64: "x86_64-apple-macos10.15",
};
const clangTarget = ARCH_TO_TARGET[targetArch];
if (!clangTarget) {
  console.error(`[mra] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(projectRoot, "resources", "mediaremote-adapter");
const outputDir = path.join(projectRoot, "resources", "bin");
const frameworkRoot = path.join(outputDir, "MediaRemoteAdapter.framework");
const hashFile = path.join(outputDir, `.MediaRemoteAdapter.${targetArch}.hash`);

const FRAMEWORK_NAME = "MediaRemoteAdapter";
const FRAMEWORK_VERSION = "A";
const BUNDLE_IDENTIFIER = "com.openwhispr.MediaRemoteAdapter";
const SHORT_VERSION = "0.7.6";

const SOURCES = [
  "src/adapter/env.m",
  "src/adapter/get.m",
  "src/adapter/globals.m",
  "src/adapter/keys.m",
  "src/adapter/now_playing.m",
  "src/adapter/repeat.m",
  "src/adapter/seek.m",
  "src/adapter/send.m",
  "src/adapter/shuffle.m",
  "src/adapter/speed.m",
  "src/adapter/stream.m",
  "src/private/MediaRemote.m",
  "src/utility/Debounce.m",
  "src/utility/helpers.m",
];

const PUBLIC_HEADER = "include/MediaRemoteAdapter.h";

// Mach-O CPU type constants for architecture verification
const ARCH_CPU_TYPE = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

function log(message) {
  console.log(`[mra] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function symlinkForce(target, linkPath) {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    // ignored
  }
  fs.symlinkSync(target, linkPath);
}

function verifyDylibArch(dylibPath, expectedArch) {
  try {
    const fd = fs.openSync(dylibPath, "r");
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);

    const magic = header.readUInt32LE(0);
    if (magic !== 0xfeedfacf) return false;
    return header.readInt32LE(4) === ARCH_CPU_TYPE[expectedArch];
  } catch {
    return false;
  }
}

function hashSources() {
  const hash = crypto.createHash("sha256");
  hash.update(targetArch);
  for (const rel of [...SOURCES, PUBLIC_HEADER].sort()) {
    const full = path.join(sourceRoot, rel);
    hash.update(rel);
    hash.update(fs.readFileSync(full));
  }
  // Also include any headers referenced via #import (cheap: include all .h)
  const headerExtra = walkHeaders(path.join(sourceRoot, "src")).sort();
  for (const h of headerExtra) {
    hash.update(path.relative(sourceRoot, h));
    hash.update(fs.readFileSync(h));
  }
  return hash.digest("hex");
}

function walkHeaders(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkHeaders(p));
    } else if (entry.isFile() && entry.name.endsWith(".h")) {
      out.push(p);
    }
  }
  return out;
}

// Source hash gate — skip rebuild when nothing changed.
const dylibPath = path.join(frameworkRoot, "Versions", FRAMEWORK_VERSION, FRAMEWORK_NAME);

const currentHash = hashSources();
if (
  fs.existsSync(dylibPath) &&
  verifyDylibArch(dylibPath, targetArch) &&
  fs.existsSync(hashFile) &&
  fs.readFileSync(hashFile, "utf8").trim() === currentHash
) {
  process.exit(0);
}

ensureDir(outputDir);

// Build the framework directory layout:
//   MediaRemoteAdapter.framework/
//     MediaRemoteAdapter           -> Versions/Current/MediaRemoteAdapter
//     Headers                      -> Versions/Current/Headers
//     Resources                    -> Versions/Current/Resources
//     Versions/Current             -> A
//     Versions/A/MediaRemoteAdapter   (the dylib)
//     Versions/A/Headers/MediaRemoteAdapter.h
//     Versions/A/Resources/Info.plist
fs.rmSync(frameworkRoot, { recursive: true, force: true });
const versionRoot = path.join(frameworkRoot, "Versions", FRAMEWORK_VERSION);
ensureDir(path.join(versionRoot, "Headers"));
ensureDir(path.join(versionRoot, "Resources"));

symlinkForce(FRAMEWORK_VERSION, path.join(frameworkRoot, "Versions", "Current"));
symlinkForce(
  path.join("Versions", "Current", FRAMEWORK_NAME),
  path.join(frameworkRoot, FRAMEWORK_NAME)
);
symlinkForce(path.join("Versions", "Current", "Headers"), path.join(frameworkRoot, "Headers"));
symlinkForce(path.join("Versions", "Current", "Resources"), path.join(frameworkRoot, "Resources"));

fs.copyFileSync(
  path.join(sourceRoot, PUBLIC_HEADER),
  path.join(versionRoot, "Headers", `${FRAMEWORK_NAME}.h`)
);

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleExecutable</key>
\t<string>${FRAMEWORK_NAME}</string>
\t<key>CFBundleIdentifier</key>
\t<string>${BUNDLE_IDENTIFIER}</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>${FRAMEWORK_NAME}</string>
\t<key>CFBundlePackageType</key>
\t<string>FMWK</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${SHORT_VERSION}</string>
\t<key>CFBundleVersion</key>
\t<string>${SHORT_VERSION}</string>
\t<key>NSPrincipalClass</key>
\t<string></string>
</dict>
</plist>
`;
fs.writeFileSync(path.join(versionRoot, "Resources", "Info.plist"), infoPlist);

const includeFlags = ["-I", path.join(sourceRoot, "include"), "-I", path.join(sourceRoot, "src")];

const commonFlags = [
  "-fobjc-arc",
  "-fvisibility=default",
  "-O2",
  "-target",
  clangTarget,
  ...includeFlags,
];

const dylibOut = path.join(versionRoot, FRAMEWORK_NAME);

const linkFlags = [
  "-dynamiclib",
  "-Wl,-install_name,@rpath/MediaRemoteAdapter.framework/Versions/A/MediaRemoteAdapter",
  "-compatibility_version",
  "1.0.0",
  "-current_version",
  SHORT_VERSION,
  "-framework",
  "Foundation",
  "-framework",
  "AppKit",
  "-framework",
  "ImageIO",
  "-framework",
  "CoreServices",
  "-framework",
  "UniformTypeIdentifiers",
];

const sourceArgs = SOURCES.map((rel) => path.join(sourceRoot, rel));

log(`Building ${FRAMEWORK_NAME}.framework for ${targetArch}`);

const clangArgs = [...commonFlags, ...sourceArgs, ...linkFlags, "-o", dylibOut];

const compile = spawnSync("xcrun", ["clang", ...clangArgs], {
  stdio: "inherit",
});

if (compile.status !== 0) {
  const fallback = spawnSync("clang", clangArgs, { stdio: "inherit" });
  if (fallback.status !== 0) {
    console.error("[mra] Failed to compile MediaRemoteAdapter framework.");
    process.exit(fallback.status ?? 1);
  }
}

if (!verifyDylibArch(dylibOut, targetArch)) {
  console.error(`[mra] FATAL: Compiled dylib architecture does not match target (${targetArch}).`);
  process.exit(1);
}

// Ad-hoc codesign so /usr/bin/perl can dlopen the framework. electron-builder
// will resign this with the developer identity during packaging on signed
// builds; the ad-hoc signature is only relied on for dev runs and CSC_IDENTITY
// _AUTO_DISCOVERY=false packs.
const sign = spawnSync("codesign", ["--force", "--sign", "-", "--timestamp=none", frameworkRoot], {
  stdio: "inherit",
});
if (sign.status !== 0) {
  console.error("[mra] codesign --force --sign - failed");
  process.exit(sign.status ?? 1);
}

fs.writeFileSync(hashFile, currentHash);

log(`Built MediaRemoteAdapter.framework (${targetArch})`);
