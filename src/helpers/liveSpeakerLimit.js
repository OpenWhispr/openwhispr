const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");

// The count includes the user, who is never a remote speaker.
const MAX_REMOTE_SPEAKERS = MAX_SPEAKER_COUNT - 1;

/**
 * Decides how many remote speakers live identification may name, and whether
 * a new voice must pass the confidence gate.
 *
 * - explicit (stepper): the user's number is exact, even below speakers found.
 * - attendees: an estimate, so it never drops below speakers already found.
 * - auto (no count): the most the app supports.
 *
 * The gate keeps one voice from splitting into several speakers, which uses up
 * a known count as surely as an unknown one, so it is on whenever there can be
 * more than one remote speaker.
 *
 * @param {{ expectedCount: number, explicit?: boolean, auto?: boolean }} config
 * @param {number} [confirmedCount] remote speakers already confirmed
 * @returns {{ maxSpeakers: number, gated: boolean }}
 */
function resolveLiveSpeakerLimit(config, confirmedCount = 0) {
  const maxSpeakers = Math.min(remoteSpeakerLimit(config, confirmedCount), MAX_REMOTE_SPEAKERS);
  return { maxSpeakers, gated: maxSpeakers > 1 };
}

function remoteSpeakerLimit(config, confirmedCount) {
  if (config.auto) return MAX_REMOTE_SPEAKERS;

  const remoteFromCount = Math.max(1, config.expectedCount - 1);
  return config.explicit ? remoteFromCount : Math.max(remoteFromCount, confirmedCount);
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
