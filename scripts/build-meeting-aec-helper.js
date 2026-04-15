#!/usr/bin/env node

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildManifest,
  computeManifestHash,
  ensureThirdPartySources,
  writeCmakeManifest,
} = require("./lib/meeting-aec-build");

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHES = new Set(["arm64", "x64"]);

if (!SUPPORTED_PLATFORMS.has(process.platform)) {
  process.exit(0);
}

const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

if (!SUPPORTED_ARCHES.has(targetArch)) {
  console.warn(`[meeting-aec-helper] Unsupported architecture: ${targetArch}`);
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const helperRoot = path.join(projectRoot, "native", "meeting-aec-helper");
const sourceDir = path.join(helperRoot, "src");
const outputDir = path.join(projectRoot, "resources", "bin");
const buildDir = path.join(helperRoot, "build", `${process.platform}-${targetArch}`);
const generatedDir = path.join(buildDir, "generated");
const objectDir = path.join(buildDir, "obj");
const binaryName = `meeting-aec-helper-${process.platform}-${targetArch}${
  process.platform === "win32" ? ".exe" : ""
}`;
const outputBinary = path.join(outputDir, binaryName);
const builtBinary = path.join(
  buildDir,
  process.platform === "win32" ? "Release" : "",
  `meeting-aec-helper${process.platform === "win32" ? ".exe" : ""}`
);
const hashFile = path.join(outputDir, `.meeting-aec-helper.${process.platform}-${targetArch}.hash`);

function log(message) {
  console.log(`[meeting-aec-helper] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function hasCommand(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function run(command, args, options = {}) {
  const { logCommand = true, ...spawnOptions } = options;
  if (logCommand) {
    log(`Running ${[command, ...args].join(" ")}`);
  }
  return spawnSync(command, args, {
    stdio: "inherit",
    cwd: projectRoot,
    env: process.env,
    ...spawnOptions,
  });
}

function getLocalFiles() {
  return [
    path.join(helperRoot, "CMakeLists.txt"),
    path.join(sourceDir, "main.cc"),
    path.join(sourceDir, "aec_processor.cc"),
    path.join(sourceDir, "aec_processor.h"),
    path.join(sourceDir, "null_aec_dump_factory.cc"),
    __filename,
    path.join(__dirname, "lib", "meeting-aec-build.js"),
  ];
}

function isUpToDate(currentHash) {
  if (!fs.existsSync(outputBinary) || !fs.existsSync(hashFile)) {
    return false;
  }

  return fs.readFileSync(hashFile, "utf8").trim() === currentHash;
}

function getDarwinArch() {
  return targetArch === "x64" ? "x86_64" : "arm64";
}

function getCompilerToolchain() {
  if (process.platform === "darwin") {
    return {
      cc: hasCommand("clang") ? "clang" : null,
      cxx: hasCommand("clang++") ? "clang++" : null,
    };
  }

  if (process.platform === "linux") {
    if (hasCommand("clang") && hasCommand("clang++")) {
      return { cc: "clang", cxx: "clang++" };
    }
    if (hasCommand("gcc") && hasCommand("g++")) {
      return { cc: "gcc", cxx: "g++" };
    }
  }

  return { cc: null, cxx: null };
}

function getSourceObjectName(sourcePath) {
  const hash = crypto.createHash("sha1").update(sourcePath).digest("hex").slice(0, 12);
  return `${hash}.o`;
}

function buildDirect(manifest) {
  if (process.platform === "win32") {
    return false;
  }

  const toolchain = getCompilerToolchain();
  if (!toolchain.cc || !toolchain.cxx) {
    return false;
  }

  fs.rmSync(objectDir, { recursive: true, force: true });
  ensureDir(objectDir);

  const includeArgs = manifest.includeDirs.flatMap((dir) => ["-I", dir]);
  const defineArgs = manifest.defines.map((define) => `-D${define}`);
  const commonArgs = [...manifest.compileOptions, ...includeArgs, ...defineArgs];
  const avx2Set = new Set(manifest.avx2Sources);
  const objectFiles = [];
  const localSources = [
    path.join(sourceDir, "main.cc"),
    path.join(sourceDir, "aec_processor.cc"),
    path.join(sourceDir, "null_aec_dump_factory.cc"),
  ];
  log(`Compiling ${manifest.cSources.length + manifest.cxxSources.length + localSources.length} sources`);

  for (const source of [...manifest.cSources, ...manifest.cxxSources, ...localSources]) {
    const outputObject = path.join(objectDir, getSourceObjectName(source));
    const compiler = source.endsWith(".c") ? toolchain.cc : toolchain.cxx;
    const languageArgs = source.endsWith(".c") ? ["-std=c11"] : ["-std=c++20"];
    const perSourceArgs = avx2Set.has(source) ? manifest.avx2CompileOptions : [];
    const result = run(compiler, [
      ...languageArgs,
      ...commonArgs,
      ...perSourceArgs,
      "-c",
      source,
      "-o",
      outputObject,
    ], { logCommand: false });

    if (result.status !== 0) {
      return false;
    }

    objectFiles.push(outputObject);
  }

  const linkArgs = [
    "-std=c++20",
    ...manifest.compileOptions,
    ...manifest.linkOptions,
    ...objectFiles,
    "-o",
    outputBinary,
  ];
  const linkResult = run(toolchain.cxx, linkArgs, { logCommand: false });
  return linkResult.status === 0 && fs.existsSync(outputBinary);
}

function configureCMake(cmakeManifestPath) {
  const args = [
    "-S",
    helperRoot,
    "-B",
    buildDir,
    "-DMEETING_AEC_GENERATED_CMAKE=" + cmakeManifestPath,
    "-DCMAKE_BUILD_TYPE=Release",
  ];

  if (process.platform === "darwin") {
    args.push(`-DCMAKE_OSX_ARCHITECTURES=${getDarwinArch()}`);
  }

  if (process.platform === "win32" && targetArch === "x64") {
    args.push("-A", "x64", "-T", "ClangCL");
  }

  return run("cmake", args);
}

function buildCMake() {
  const result = run("cmake", ["--build", buildDir, "--config", "Release"]);
  if (result.status !== 0 || !fs.existsSync(builtBinary)) {
    return false;
  }

  fs.copyFileSync(builtBinary, outputBinary);
  return true;
}

async function main() {
  ensureDir(outputDir);

  const currentHash = computeManifestHash(getLocalFiles(), process.platform, targetArch);
  if (isUpToDate(currentHash)) {
    log("Binary is up to date, skipping build");
    return;
  }

  ensureDir(buildDir);
  ensureDir(generatedDir);

  const { webrtcApmRoot, abslRoot } = await ensureThirdPartySources(helperRoot);
  const manifest = buildManifest({
    helperRoot,
    webrtcApmRoot,
    abslRoot,
    targetPlatform: process.platform,
    targetArch,
  });

  let built = false;
  const cmakeManifestPath = path.join(generatedDir, "meeting-aec-sources.cmake");
  writeCmakeManifest(manifest, cmakeManifestPath);

  if (hasCommand("cmake")) {
    const configured = configureCMake(cmakeManifestPath);
    if (configured.status === 0) {
      built = buildCMake();
    }
  }

  if (!built) {
    built = buildDirect(manifest);
  }

  if (!built) {
    console.warn("[meeting-aec-helper] Failed to build helper");
    process.exitCode = 1;
    return;
  }

  if (process.platform !== "win32") {
    fs.chmodSync(outputBinary, 0o755);
  }

  fs.writeFileSync(hashFile, currentHash);
  log(`Built ${binaryName} (${os.platform()} ${targetArch})`);
}

main().catch((error) => {
  console.error(`[meeting-aec-helper] ${error.message}`);
  process.exitCode = 1;
});
