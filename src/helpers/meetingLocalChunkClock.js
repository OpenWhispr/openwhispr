// Local Note Recording batches each source's audio into fixed-interval chunks
// and transcribes them afterwards. A chunk's text belongs to when that audio
// was captured, not to when its decode finished: diarization maps each segment
// to the speaker who talks most between its timestamp and the next one, and
// live speaker identification matches it against capture-time windows. So each
// source remembers when the first buffer of its pending chunk was captured.
const PCM16_BYTES_PER_SAMPLE = 2;

const createLocalChunkClock = ({ now = Date.now, sampleRate = 24000 } = {}) => {
  let startedAt = { mic: null, system: null };

  return {
    // Call for every buffer added to a source's pending chunk. Only the first
    // one after a take() sets the start; buffers without a capture time fall
    // back to their arrival, like the echo detector's own timeline.
    mark(source, capturedAt = null) {
      if (startedAt[source] != null) return;
      startedAt[source] = Number.isFinite(capturedAt) ? capturedAt : now();
    },
    // Ends the pending chunk and returns its capture start in epoch ms. A chunk
    // that was never marked is assumed to have just ended.
    take(source, pcmBytes = 0) {
      const marked = startedAt[source];
      startedAt[source] = null;
      if (marked != null) return marked;
      return now() - (pcmBytes / PCM16_BYTES_PER_SAMPLE / sampleRate) * 1000;
    },
    reset() {
      startedAt = { mic: null, system: null };
    },
  };
};

module.exports = { createLocalChunkClock };
