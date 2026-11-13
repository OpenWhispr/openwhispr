const {
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
  computeChunkStats,
} = require("./meetingMicGate");

const BYTES_PER_SAMPLE = 2;
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_FRAME_MS = 100;

function bufferDurationMs(buffer, sampleRate = DEFAULT_SAMPLE_RATE) {
  return ((buffer.length / BYTES_PER_SAMPLE) * 1000) / sampleRate;
}

// A capture time is the true start of the audio; the receipt time only says when it
// arrived, so the start is worked back from it by the buffer's length.
function localBufferEntry(buffer, { capturedAt = null, receivedAt = null, now = Date.now } = {}) {
  const startAt = capturedAt ?? (receivedAt ?? now()) - bufferDurationMs(buffer);
  return { buffer, startAt };
}

function isAudible({ rms, peak }) {
  return rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK;
}

function describeLocalChunk(
  entries,
  { sampleRate = DEFAULT_SAMPLE_RATE, frameMs = DEFAULT_FRAME_MS } = {}
) {
  if (!entries.length) return null;

  const frameBytes = Math.round((frameMs / 1000) * sampleRate) * BYTES_PER_SAMPLE;
  let speechStartAt = null;
  let speechEndAt = null;

  for (const { buffer, startAt } of entries) {
    const entryEndAt = startAt + bufferDurationMs(buffer, sampleRate);
    // Frames never cross entries, so a gap between entries can't shift later frames' times.
    for (let offset = 0, index = 0; offset < buffer.length; offset += frameBytes, index += 1) {
      const frame = buffer.subarray(offset, Math.min(buffer.length, offset + frameBytes));
      if (!isAudible(computeChunkStats(frame))) continue;
      const frameStartAt = startAt + index * frameMs;
      speechStartAt ??= frameStartAt;
      speechEndAt = Math.min(frameStartAt + frameMs, entryEndAt);
    }
  }

  const last = entries[entries.length - 1];
  const startAt = entries[0].startAt;
  const endAt = last.startAt + bufferDurationMs(last.buffer, sampleRate);

  return {
    pcm: Buffer.concat(entries.map(({ buffer }) => buffer)),
    startAt,
    endAt,
    speechStartAt: speechStartAt ?? startAt,
    speechEndAt: speechEndAt ?? endAt,
  };
}

module.exports = { bufferDurationMs, localBufferEntry, describeLocalChunk };
