#!/usr/bin/env node

// Compiles native/macos-window-spaces into resources/bin/macos-window-spaces.node,
// the in-process N-API addon WindowManager uses to re-join its overlay panels to
// every Space. Same targets as the Swift helpers (--arch flag or TARGET_ARCH),
// and the build is skipped when the addon is current for that arch.
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ARCH_TO_TARGET, verifyBinaryArch } = require("./lib/build-macos-swift-binary");

if (process.platform !== "darwin") {
  process.exit(0);
}

const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;
const target = ARCH_TO_TARGET[targetArch];
if (!target) {
  console.error(`[window-spaces] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "native", "macos-window-spaces", "macos-window-spaces.m");
const outputDir = path.join(projectRoot, "resources", "bin");
const output = path.join(outputDir, "macos-window-spaces.node");
const hashFile = path.join(outputDir, `.macos-window-spaces.node.${targetArch}.hash`);

const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
if (
  verifyBinaryArch(output, targetArch) &&
  fs.existsSync(hashFile) &&
  fs.readFileSync(hashFile, "utf8").trim() === sourceHash
) {
  process.exit(0);
}

const { include_dir: nodeApiIncludeDir } = require("node-api-headers");

fs.mkdirSync(outputDir, { recursive: true });
const args = [
  "-target",
  target,
  "-O2",
  "-Wall",
  "-I",
  nodeApiIncludeDir,
  // A Node addon bundle: the N-API symbols resolve against the host process.
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-framework",
  "AppKit",
  "-o",
  output,
  source,
];

console.log(`[window-spaces] Compiling with clang ${args.join(" ")}`);
let result = spawnSync("xcrun", ["clang", ...args], { stdio: "inherit" });
if (result.status !== 0) {
  result = spawnSync("clang", args, { stdio: "inherit" });
}
if (result.status !== 0) {
  console.error("[window-spaces] Failed to compile macos-window-spaces.node.");
  process.exit(result.status ?? 1);
}

if (!verifyBinaryArch(output, targetArch)) {
  console.error(
    `[window-spaces] FATAL: Compiled addon architecture does not match target (${targetArch}).`
  );
  process.exit(1);
}

fs.writeFileSync(hashFile, sourceHash);
console.log(`[window-spaces] Built macos-window-spaces.node (${targetArch}).`);
