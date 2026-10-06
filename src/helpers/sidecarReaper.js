const { execFileSync } = require("child_process");
const debugLogger = require("./debugLogger");
const sidecarPidFile = require("./sidecarPidFile");

const EXPECTED_BINARY_FRAGMENTS = {
  parakeet: ["sherpa-onnx-ws-", "sherpa-onnx-online-ws-"],
  whisper: ["whisper-server"],
  llama: ["llama-server"],
  qdrant: ["qdrant"],
  diarization: ["sherpa-onnx-diarize"],
};

// A wedged sidecar can ignore SIGTERM entirely (observed with qdrant spinning
// at full CPU), so reaping must verify death and escalate rather than
// fire-and-forget.
const SIGTERM_GRACE_MS = 5000;
const SIGKILL_GRACE_MS = 1000;
const EXIT_POLL_INTERVAL_MS = 200;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function processCommand(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).toString();
      const match = out.match(/^"([^"]+)"/);
      return match ? match[1] : "";
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // Already dead.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(EXIT_POLL_INTERVAL_MS);
  }
  return true;
}

async function killStaleSidecar(name, pid, { sigtermGraceMs, sigkillGraceMs }) {
  debugLogger.warn("Reaping stale sidecar", { name, pid });
  signalProcess(pid, "SIGTERM");
  if (await waitForExit(pid, sigtermGraceMs)) return true;

  debugLogger.warn("Stale sidecar ignored SIGTERM, escalating to SIGKILL", { name, pid });
  signalProcess(pid, "SIGKILL");
  if (await waitForExit(pid, sigkillGraceMs)) return true;

  debugLogger.error("Stale sidecar survived SIGKILL, keeping PID entry for next launch", {
    name,
    pid,
  });
  return false;
}

async function reapStaleSidecars({
  sigtermGraceMs = SIGTERM_GRACE_MS,
  sigkillGraceMs = SIGKILL_GRACE_MS,
} = {}) {
  const entries = sidecarPidFile.readAll();
  await Promise.all(
    entries.map(async ({ name, pid }) => {
      const fragments = EXPECTED_BINARY_FRAGMENTS[name];
      if (fragments && isProcessAlive(pid)) {
        const command = processCommand(pid);
        if (fragments.some((fragment) => command.includes(fragment))) {
          const dead = await killStaleSidecar(name, pid, { sigtermGraceMs, sigkillGraceMs });
          if (!dead) return;
        }
      }
      sidecarPidFile.clear(name);
    })
  );
}

module.exports = { reapStaleSidecars, waitForExit };
