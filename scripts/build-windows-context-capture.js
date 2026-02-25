#!/usr/bin/env node
/**
 * Ensures the Windows context-capture binary is available.
 *
 * Strategy:
 * 1. If binary exists and is up-to-date, do nothing
 * 2. Try local compilation (MSVC → MinGW → Clang)
 *
 * Only runs on Windows.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "windows-context-capture.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "windows-context-capture.exe");

function log(message) {
  console.log(`[windows-context-capture] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isBinaryUpToDate() {
  if (!fs.existsSync(outputBinary)) return false;
  if (!fs.existsSync(cSource)) return true;
  try {
    return fs.statSync(outputBinary).mtimeMs >= fs.statSync(cSource).mtimeMs;
  } catch {
    return false;
  }
}

function quotePath(p) {
  return `"${p.replace(/"/g, '\\"')}"`;
}

function tryCompile() {
  if (!fs.existsSync(cSource)) {
    log("C source not found, cannot compile");
    return false;
  }

  log("Attempting local compilation...");

  const compilers = [
    {
      name: "MSVC",
      check: { command: "cl", args: [] },
      useShell: true,
      getCommand: () =>
        `cl /O2 /nologo ${quotePath(cSource)} /Fe:${quotePath(outputBinary)} user32.lib`,
    },
    {
      name: "MinGW-w64",
      check: { command: "gcc", args: ["--version"] },
      useShell: false,
      command: "gcc",
      args: ["-O2", cSource, "-o", outputBinary, "-luser32"],
    },
    {
      name: "Clang",
      check: { command: "clang", args: ["--version"] },
      useShell: false,
      command: "clang",
      args: ["-O2", cSource, "-o", outputBinary, "-luser32"],
    },
  ];

  for (const compiler of compilers) {
    log(`Trying ${compiler.name}...`);

    const checkResult = spawnSync(compiler.check.command, compiler.check.args, {
      stdio: "pipe",
      shell: true,
    });

    if (checkResult.status !== 0 && checkResult.error) {
      log(`${compiler.name} not found, trying next...`);
      continue;
    }

    let result;
    if (compiler.useShell) {
      const cmd = compiler.getCommand();
      log(`Compiling with: ${cmd}`);
      result = spawnSync(cmd, [], { stdio: "inherit", cwd: projectRoot, shell: true });
    } else {
      log(`Compiling with: ${compiler.command} ${compiler.args.join(" ")}`);
      result = spawnSync(compiler.command, compiler.args, {
        stdio: "inherit",
        cwd: projectRoot,
        shell: false,
      });
    }

    if (result.status === 0 && fs.existsSync(outputBinary)) {
      log(`Successfully built with ${compiler.name}`);
      return true;
    }

    log(`${compiler.name} compilation failed, trying next...`);
  }

  return false;
}

function main() {
  ensureDir(outputDir);

  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  const compiled = tryCompile();
  if (compiled) return;

  console.warn("[windows-context-capture] Could not build context-capture binary.");
  console.warn("[windows-context-capture] IDE context awareness will be unavailable on Windows.");
}

main();
