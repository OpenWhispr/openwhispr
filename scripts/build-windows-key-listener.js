#!/usr/bin/env node
/**
 * Ensures the Windows key listener binary is available.
 *
 * Strategy:
 * 1. If binary exists and is up-to-date, do nothing
 * 2. Try to download prebuilt binary from GitHub releases
 * 3. Fall back to local compilation if download fails
 *
 * This allows developers without a C compiler to still build the app.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const isWindows = process.platform === "win32";
if (!isWindows) {
  // Only needed on Windows
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "windows-key-listener.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "windows-key-listener.exe");

function log(message) {
  console.log(`[windows-key-listener] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Check if binary exists and is up-to-date
function isBinaryUpToDate() {
  if (!fs.existsSync(outputBinary)) {
    return false;
  }

  // If source doesn't exist, can't check if rebuild needed - assume binary is good
  if (!fs.existsSync(cSource)) {
    return true;
  }

  try {
    const binaryStat = fs.statSync(outputBinary);
    const sourceStat = fs.statSync(cSource);
    return binaryStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

// Try to download prebuilt binary
async function tryDownload() {
  log("Attempting to download prebuilt binary...");

  const downloadScript = path.join(__dirname, "download-windows-key-listener.js");
  if (!fs.existsSync(downloadScript)) {
    log("Download script not found, skipping download");
    return false;
  }

  const result = spawnSync(process.execPath, [downloadScript, "--force"], {
    stdio: "inherit",
    cwd: projectRoot,
  });

  if (result.status === 0 && fs.existsSync(outputBinary)) {
    log("Successfully downloaded prebuilt binary");
    return true;
  }

  log("Download failed or binary not found after download");
  return false;
}

/**
 * Quote a path for use in shell commands on Windows.
 * @param {string} p - Path to quote
 * @returns {string} - Quoted path safe for shell use
 */
function quotePath(p) {
  // Use double quotes and escape any existing quotes
  return `"${p.replace(/"/g, '\\"')}"`;
}

// Try to compile locally
function tryCompile() {
  if (!fs.existsSync(cSource)) {
    log("C source not found, cannot compile locally");
    return false;
  }

  log("Attempting local compilation...");

  // For MSVC, we need to use a command string because /Fe: doesn't work well with spawn args
  // For GCC/Clang, we can use shell: false with proper args array
  const compilers = [
    // MSVC (Visual Studio) - uses command string due to /Fe: syntax
    {
      name: "MSVC",
      check: { command: "cl", args: [] },
      useShell: true,
      getCommand: () =>
        `cl /O2 /nologo ${quotePath(cSource)} /Fe:${quotePath(outputBinary)} user32.lib`,
    },
    // MinGW-w64 - can use shell: false
    {
      name: "MinGW-w64",
      check: { command: "gcc", args: ["--version"] },
      useShell: false,
      command: "gcc",
      args: ["-O2", "-mwindows", cSource, "-o", outputBinary, "-luser32"],
    },
    // Clang (LLVM) - can use shell: false
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

    // Check if compiler is available
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
      result = spawnSync(cmd, [], {
        stdio: "inherit",
        cwd: projectRoot,
        shell: true,
      });
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

async function main() {
  ensureDir(outputDir);

  // Check if rebuild is needed
  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  // Try download first, then compile
  const downloaded = await tryDownload();
  if (downloaded) {
    return;
  }

  const compiled = tryCompile();
  if (compiled) {
    return;
  }

  // Neither worked - warn but don't fail
  console.warn("[windows-key-listener] Could not obtain Windows key listener binary.");
  console.warn("[windows-key-listener] Push-to-Talk on Windows will use fallback mode.");
  console.warn(
    "[windows-key-listener] To compile locally, install Visual Studio Build Tools or MinGW-w64."
  );
}

main().catch((error) => {
  console.error("[windows-key-listener] Unexpected error:", error);
  // Don't fail the build
});
