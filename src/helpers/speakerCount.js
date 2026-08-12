const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");

// expected_speaker_count is a total that already includes you, so anything below
// 1 is meaningless. Cloud sync persists whatever the server sends, so invalid
// values arrive as data rather than as programmer error and must degrade to null.
function normalizeStoredSpeakerCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) return null;
  return Math.min(count, MAX_SPEAKER_COUNT);
}

module.exports = { normalizeStoredSpeakerCount };
