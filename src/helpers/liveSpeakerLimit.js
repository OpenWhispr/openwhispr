const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");

// The count includes the user, who is never a remote speaker.
const MAX_REMOTE_SPEAKERS = MAX_SPEAKER_COUNT - 1;

/**
 * Decides how many remote speakers live identification may name, and whether
 * it must pass the confidence gate.
 *
 * - explicit (stepper): the user's number is exact, even below speakers found.
 * - attendees: an estimate, so it never drops below speakers already found.
 * - auto (no count): the most the app supports, behind the gate.
 *
 * @param {{ expectedCount: number, explicit?: boolean, auto?: boolean }} config
 * @param {number} [confirmedCount] remote speakers already confirmed
 * @returns {{ maxSpeakers: number, gated: boolean }}
 */
function resolveLiveSpeakerLimit(config, confirmedCount = 0) {
  if (config.auto) return { maxSpeakers: MAX_REMOTE_SPEAKERS, gated: true };

  const remoteFromCount = Math.max(1, config.expectedCount - 1);
  const maxSpeakers = config.explicit ? remoteFromCount : Math.max(remoteFromCount, confirmedCount);
  return { maxSpeakers: Math.min(maxSpeakers, MAX_REMOTE_SPEAKERS), gated: false };
}

/**
 * Speaker count to show while running automatically: the user plus the remote
 * speakers found so far, never below 2 or above the supported maximum.
 *
 * @param {number} confirmedCount
 * @returns {number}
 */
function autoDisplayCount(confirmedCount) {
  return Math.min(MAX_SPEAKER_COUNT, Math.max(2, confirmedCount + 1));
}

module.exports = { resolveLiveSpeakerLimit, autoDisplayCount };
