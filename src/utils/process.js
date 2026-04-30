const { spawn } = require("child_process");

/**
 * Cross-platform process termination
 * Windows doesn't support SIGTERM/SIGKILL signals the same way Unix does
 * @param {ChildProcess} proc - The process to kill
 * @param {string} signal - Signal name ('SIGTERM' or 'SIGKILL')
 */
function killProcess(proc, signal = "SIGTERM") {
  if (!proc || proc.exitCode !== null) return;

  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL") {
        const taskkill = spawn("taskkill", ["/pid", proc.pid.toString(), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        });
        taskkill.on("error", () => {});
      } else {
        proc.kill();
      }
    } else {
      proc.kill(signal);
    }
  } catch (e) {
    // Process may already be dead
  }
}

// On Unix, signals the entire process group of a detached child so any
// grandchildren (e.g. ffmpeg spawned by a sidecar) get reaped too.
// On Windows, taskkill /T already includes the descendant tree.
function killProcessGroup(proc, signal = "SIGTERM") {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    killProcess(proc, signal);
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    killProcess(proc, signal);
  }
}

// Timeout constants
const TIMEOUTS = {
  QUICK_CHECK: 5000, // 5 seconds for quick checks
  COMMAND: 30000, // 30 seconds for general commands
  INSTALL: 300000, // 5 minutes for installations
  DOWNLOAD: 600000, // 10 minutes for downloads
  PIP_UPGRADE: 60000, // 1 minute for pip upgrade
  TRANSCRIPTION: 1200000, // 20 minutes for whisper transcription (long audio files)
};

// Command whitelist for shell operations
const SAFE_SHELL_COMMANDS = new Set(["brew", "apt", "yum", "pacman"]);

/**
 * Validate command arguments for safety
 * @param {string} cmd - Command to validate
 * @param {string[]} args - Arguments to validate
 * @param {boolean} shell - Whether shell is being used
 * @throws {Error} If validation fails
 */
function validateCommand(cmd, args, shell) {
  // Reject shell usage for non-whitelisted commands
  if (shell && !SAFE_SHELL_COMMANDS.has(cmd)) {
    throw new Error(`Shell execution not allowed for command: ${cmd}`);
  }

  // Check for dangerous characters in arguments
  const dangerousChars = /[;&|`$<>]/;
  if (args.some((arg) => dangerousChars.test(arg))) {
    throw new Error("Command arguments contain potentially dangerous characters");
  }
}

/**
 * Run a command with proper error handling and timeout
 * @param {string} cmd - Command to run
 * @param {string[]} args - Command arguments
 * @param {Object} options - Options object
 * @param {number} options.timeout - Timeout in milliseconds
 * @param {boolean} options.shell - Whether to use shell (avoid unless necessary)
 * @returns {Promise<{success: boolean, output: string}>}
 */
async function runCommand(cmd, args = [], options = {}) {
  const { timeout = TIMEOUTS.COMMAND, shell = false } = options;

  // Validate command for security
  validateCommand(cmd, args, shell);

  return new Promise((resolve, reject) => {
    let childProc;
    let stdout = "";
    let stderr = "";
    let completed = false;
    let timer;

    try {
      childProc = spawn(cmd, args, { shell });
    } catch (error) {
      reject(error);
      return;
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (childProc && !completed) {
        completed = true;
        killProcess(childProc, "SIGTERM");
        // Force kill after 5 seconds if still running
        setTimeout(() => {
          killProcess(childProc, "SIGKILL");
        }, 5000);
      }
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    childProc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    childProc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    childProc.on("close", (code) => {
      if (completed) return; // Already handled
      completed = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        reject(new Error(stderr || `Command failed with code ${code}`));
      }
    });

    childProc.on("error", (error) => {
      if (completed) return; // Already handled
      completed = true;
      cleanup();
      reject(error);
    });
  });
}

module.exports = {
  runCommand,
  killProcess,
  killProcessGroup,
  TIMEOUTS,
};
