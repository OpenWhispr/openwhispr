const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

// WHISPER_GPU_FAILED persists until a manual Retry, so a GPU knocked out once
// (a driver hiccup, or 1.8.3's pack deletion) stays on CPU whisper forever.
// This sentinel remembers the last app version that ran: on the first launch
// of a new version the remembered failure is cleared, giving the GPU exactly
// one fresh attempt per upgrade — a real failure re-records the flag on the
// next server start. Must run before the whisper server pre-warm resolves its
// GPU options.
const SENTINEL_FILENAME = ".whisper-gpu-retry-version";

function getSentinelPath() {
  return path.join(app.getPath("userData"), SENTINEL_FILENAME);
}

function resetWhisperGpuFailureOnUpgrade(environmentManager) {
  const version = app.getVersion();
  let lastRun = null;
  try {
    lastRun = fs.readFileSync(getSentinelPath(), "utf8").trim();
  } catch {}
  if (lastRun === version) return false;
  try {
    fs.writeFileSync(getSentinelPath(), version);
  } catch {
    // Best-effort: without the sentinel the flag is cleared again next launch.
  }
  if (!process.env.WHISPER_GPU_FAILED) return false;
  delete process.env.WHISPER_GPU_FAILED;
  debugLogger.info("Cleared remembered whisper GPU failure for a fresh attempt after upgrade", {
    from: lastRun,
    to: version,
  });
  // Targeted removal: a full saveAllKeysToEnvFile() rewrite would drop
  // hand-added .env lines (e.g. OPENWHISPR_LOG_LEVEL=debug).
  environmentManager.removeKeyFromEnvFile("WHISPER_GPU_FAILED").catch((err) => {
    debugLogger.error("Failed to persist WHISPER_GPU_FAILED clear to .env", {
      error: err.message,
    });
  });
  return true;
}

module.exports = { resetWhisperGpuFailureOnUpgrade };
