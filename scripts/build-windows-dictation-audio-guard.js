#!/usr/bin/env node
/**
 * Compiles resources/windows-dictation-audio-guard.c on a Windows host (MSVC,
 * then MinGW-w64, then Clang), skipping a binary newer than its source.
 *
 * There is no prebuilt fallback yet: without a compiler the app runs without
 * the dictation audio guard (Settings hides its options), so a failed build
 * warns and never fails the chain.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") process.exit(0);

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "windows-dictation-audio-guard.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "windows-dictation-audio-guard.exe");

function log(message) {
  console.log(`[windows-dictation-audio-guard] ${message}`);
}

function isBinaryUpToDate() {
  if (!fs.existsSync(outputBinary)) return false;
  if (!fs.existsSync(cSource)) return true;
  return fs.statSync(outputBinary).mtimeMs >= fs.statSync(cSource).mtimeMs;
}

function quotePath(p) {
  return `"${p.replace(/"/g, '\\"')}"`;
}

const COMPILERS = [
  {
    name: "MSVC",
    check: "cl",
    // /Fe: needs a command string; spawn args mangle it.
    shellCommand: `cl /O2 /nologo ${quotePath(cSource)} /Fe:${quotePath(outputBinary)} /Fo:${quotePath(
      path.join(outputDir, "windows-dictation-audio-guard.obj")
    )} ole32.lib`,
  },
  {
    name: "MinGW-w64",
    check: "gcc --version",
    command: "gcc",
    args: ["-O2", cSource, "-o", outputBinary, "-lole32"],
  },
  {
    name: "Clang",
    check: "clang --version",
    command: "clang",
    args: ["-O2", cSource, "-o", outputBinary, "-lole32"],
  },
];

function tryCompile() {
  for (const compiler of COMPILERS) {
    const probe = spawnSync(compiler.check, [], { stdio: "pipe", shell: true });
    if (probe.error || (probe.status !== 0 && compiler.name !== "MSVC")) {
      log(`${compiler.name} not found, trying next...`);
      continue;
    }
    const result = compiler.shellCommand
      ? spawnSync(compiler.shellCommand, [], { stdio: "inherit", cwd: projectRoot, shell: true })
      : spawnSync(compiler.command, compiler.args, { stdio: "inherit", cwd: projectRoot });
    if (result.status === 0 && fs.existsSync(outputBinary)) {
      log(`Built with ${compiler.name}`);
      return true;
    }
    log(`${compiler.name} compilation failed, trying next...`);
  }
  return false;
}

fs.mkdirSync(outputDir, { recursive: true });
if (isBinaryUpToDate()) {
  log("Binary is up to date, skipping build");
} else if (!tryCompile()) {
  console.warn(
    "[windows-dictation-audio-guard] No C compiler found; the dictation audio guard will be unavailable."
  );
  console.warn(
    "[windows-dictation-audio-guard] Install Visual Studio Build Tools or MinGW-w64 to build it."
  );
}
