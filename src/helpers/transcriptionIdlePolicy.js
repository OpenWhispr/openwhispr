/**
 * Pure decision logic for inactivity-based pause/resume of local transcription servers.
 * Isolated from timers, process management, and Electron for unit testing.
 *
 * This module parallels the idle-stop pattern from llamaServer.js but adds guards for
 * in-progress transcriptions and in-flight re-warms (wake-from-sleep for GPU servers).
 */

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Determines whether a running local transcription server should be paused due to inactivity.
 *
 * @param {Object} state - Current server state
 * @param {boolean} state.serverRunning - Whether the server is currently running
 * @param {boolean} state.transcribing - Whether a transcription is actively in progress
 * @param {boolean} state.rewarmInFlight - Whether a wake-from-sleep re-warm is in progress
 * @param {number} state.lastActivityMs - Timestamp of last transcription activity
 * @param {number} state.nowMs - Current timestamp
 * @param {number} [state.idleTimeoutMs=300000] - Inactivity threshold (default 5 minutes)
 * @returns {boolean} True if server should be paused
 */
function shouldPauseServer(state) {
  const {
    serverRunning,
    transcribing,
    rewarmInFlight,
    lastActivityMs,
    nowMs,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  } = state;

  // Only pause a running server
  if (!serverRunning) return false;

  // Never pause during active transcription
  if (transcribing) return false;

  // Never pause during wake-from-sleep re-warm (GPU servers)
  if (rewarmInFlight) return false;

  // Check if idle threshold exceeded
  const idleMs = nowMs - lastActivityMs;
  return idleMs >= idleTimeoutMs;
}

/**
 * Determines whether an auto-resume should be triggered before transcription.
 *
 * @param {Object} state - Current server state
 * @param {boolean} state.serverRunning - Whether the server is currently running
 * @param {boolean} state.transcribing - Whether a transcription is in progress
 * @returns {boolean} True if server needs to be resumed before proceeding
 */
function shouldResumeServer(state) {
  const { serverRunning, transcribing } = state;

  // Resume needed if server not running and not already transcribing
  // (transcribing check prevents double-resume during concurrent requests)
  return !serverRunning && !transcribing;
}

/**
 * Records a transcription activity and returns the new activity timestamp.
 *
 * @param {number} nowMs - Current timestamp
 * @returns {number} The activity timestamp
 */
function recordActivity(nowMs) {
  return nowMs;
}

/**
 * Checks if an activity should reset the idle timer (i.e., delay the pause).
 *
 * @param {Object} state - Current server state
 * @param {boolean} state.serverRunning - Whether the server is currently running
 * @param {boolean} state.transcribing - Whether a transcription just completed
 * @returns {boolean} True if timer should be reset/restarted
 */
function shouldResetIdleTimer(state) {
  const { serverRunning, transcribing } = state;

  // Reset timer when server is running and we just completed an activity
  // (transcribing=false means we just finished one)
  return serverRunning && !transcribing;
}

module.exports = {
  IDLE_TIMEOUT_MS,
  shouldPauseServer,
  shouldResumeServer,
  recordActivity,
  shouldResetIdleTimer,
};
