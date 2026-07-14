const path = require("path");
const { spawn } = require("child_process");
const { TIMEOUTS, killProcess } = require("../utils/process");

const TAR_KILL_GRACE_MS = 1000;

function tarExtractionFlags(archivePath) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "-xjf";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "-xzf";
  // bsdtar and modern GNU tar auto-detect the format on extraction (zip included).
  return "-xf";
}

function resolveSystemTarExecutable({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  if (platform !== "win32") return "tar";

  const windowsDir = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || env.windir || "C:\\Windows";
  // A 32-bit process is redirected from System32 to SysWOW64, where tar.exe
  // is not normally present. Sysnative is Windows' alias for the native
  // system directory in that situation.
  const systemDir = arch === "ia32" && env.PROCESSOR_ARCHITEW6432 ? "Sysnative" : "System32";
  return path.win32.join(windowsDir, systemDir, "tar.exe");
}

function runSystemTar(
  archivePath,
  destDir,
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    timeoutMs = TIMEOUTS.INSTALL,
    killGraceMs = TAR_KILL_GRACE_MS,
    spawnImpl = spawn,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const executable = resolveSystemTarExecutable({ platform, arch, env });
    // Relative arguments avoid GNU tar interpreting a Windows drive-letter
    // colon as a remote archive separator on non-standard PATH tar builds.
    const pathApi = platform === "win32" ? path.win32 : path;
    const cwd = pathApi.dirname(archivePath);
    const archiveArg = pathApi.basename(archivePath);
    const destArg = pathApi.relative(cwd, destDir) || ".";
    let tarProcess;

    try {
      tarProcess = spawnImpl(
        executable,
        [tarExtractionFlags(archivePath), archiveArg, "-C", destArg],
        {
          cwd,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        }
      );
    } catch (err) {
      reject(new Error(`Failed to start tar process: ${err.message}`));
      return;
    }

    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killGraceTimer = null;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      callback(value);
    };

    const timeoutError = () => new Error(`tar extraction timed out after ${timeoutMs}ms`);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcess(tarProcess, "SIGKILL");

      // Normally close follows kill immediately. Do not let a broken process
      // implementation turn the safety timeout into another indefinite wait.
      killGraceTimer = setTimeout(() => finish(reject, timeoutError()), killGraceMs);
    }, timeoutMs);

    tarProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    tarProcess.on("close", (code) => {
      if (timedOut) {
        finish(reject, timeoutError());
      } else if (code === 0) {
        finish(resolve);
      } else {
        finish(reject, new Error(`tar extraction failed with code ${code}: ${stderr}`));
      }
    });

    tarProcess.on("error", (err) => {
      finish(reject, new Error(`Failed to start tar process: ${err.message}`));
    });
  });
}

module.exports = {
  resolveSystemTarExecutable,
  runSystemTar,
};
