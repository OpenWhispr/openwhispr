const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");

// Every "expected speaker count" in the app counts the people in the meeting,
// including the local user. Diarization only ever sees the system-audio track, so
// the number of voices it can find is one fewer.
function otherVoicesFromTotal(total) {
  return Math.max(1, Math.min(total, MAX_SPEAKER_COUNT) - 1);
}

/**
 * Decides how many clusters the diarizer should look for.
 *
 * `numSpeakers` is only forced when the user stated the count themselves; a wrong
 * forced count is what makes two people share a single speaker label. Everything
 * else is a hint that merely caps the result afterwards.
 */
function resolveSpeakerExpectation({
  storedTotal,
  sessionTotal,
  attendeeTotal,
  observedOtherSpeakers,
} = {}) {
  const stored = Number(storedTotal);
  if (Number.isFinite(stored) && stored > 0) {
    const expected = otherVoicesFromTotal(stored);
    return { numSpeakers: expected, cap: expected };
  }

  const session = Number(sessionTotal);
  if (Number.isFinite(session) && session > 0) {
    return { numSpeakers: -1, cap: otherVoicesFromTotal(session) };
  }

  const attendees = Number(attendeeTotal);
  if (Number.isFinite(attendees) && attendees >= 2) {
    return { numSpeakers: -1, cap: otherVoicesFromTotal(attendees) };
  }

  const observed = Number(observedOtherSpeakers);
  if (Number.isFinite(observed) && observed >= 2) {
    return { numSpeakers: -1, cap: Math.min(observed, MAX_SPEAKER_COUNT) };
  }

  // Nothing to go on: let the clustering threshold decide rather than guessing.
  return { numSpeakers: -1, cap: null };
}

module.exports = { resolveSpeakerExpectation, otherVoicesFromTotal };
