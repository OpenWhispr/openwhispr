// Local Note Recording cuts each source's audio into chunks for the local
// model. A cut at a fixed interval lands mid-word, and the chunk is also the
// unit diarization assigns a speaker to. So a chunk ends at a pause once it is
// long enough, and only a stretch without one is cut at the limit, at its
// quietest point. Every model gets the same cuts; whisper.cpp additionally
// reports segments inside a chunk, which become rows of their own.
const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // PCM16 mono
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * BYTES_PER_SAMPLE;
// Long enough that a stop-consonant closure inside a word doesn't pass for a pause.
const PAUSE_MS = 400;
const PAUSE_FRAMES = PAUSE_MS / FRAME_MS;
// Without a pause, the cut moves to the quietest stretch this far before the limit.
const FALLBACK_SEARCH_MS = 3000;
// Quiet is relative to the chunk's own audio, so a noisy room or music under
// the speech still has pauses. The floor keeps digital silence from setting a
// threshold of zero; the cap keeps a chunk of continuous speech, whose quietest
// frames are still speech, from passing for silence.
const MIN_QUIET_RMS = 0.003;
const NOISE_FLOOR_FACTOR = 3;
const SPEECH_LEVEL_FACTOR = 0.3;

const LOCAL_CHUNK_LIMITS = {
  // The mic echo check sees the mic history of the last 12 s only.
  mic: { minMs: 5000, maxMs: 12000 },
  system: { minMs: 5000, maxMs: 20000 },
};
const LOCAL_CHUNK_MAX_MS = Math.max(...Object.values(LOCAL_CHUNK_LIMITS).map((l) => l.maxMs));

const msToBytes = (ms) => Math.round((ms / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE;
const bytesToMs = (bytes) => (bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;

function frameRms(pcm, frameCount) {
  const rms = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * FRAME_BYTES;
    for (let i = start; i < start + FRAME_BYTES; i += BYTES_PER_SAMPLE) {
      const value = pcm.readInt16LE(i) / 32768;
      sum += value * value;
    }
    rms[f] = Math.sqrt(sum / (FRAME_BYTES / BYTES_PER_SAMPLE));
  }
  return rms;
}

function percentile(values, p) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// Returns how many bytes of `pcm` (24 kHz PCM16) form the next chunk, or null
// to keep collecting. `final` flushes what is left, still within the limit.
function findLocalChunkCut(pcm, { source = "system", final = false } = {}) {
  const limits = LOCAL_CHUNK_LIMITS[source] || LOCAL_CHUNK_LIMITS.system;
  const length = pcm.length - (pcm.length % BYTES_PER_SAMPLE);
  const maxBytes = msToBytes(limits.maxMs);
  if (length === 0) return null;
  if (final && length <= maxBytes) return length;
  if (length < msToBytes(limits.minMs)) return null;

  const frameCount = Math.floor(Math.min(length, maxBytes) / FRAME_BYTES);
  const rms = frameRms(pcm, frameCount);
  const quiet = Math.max(
    MIN_QUIET_RMS,
    Math.min(percentile(rms, 0.1) * NOISE_FLOOR_FACTOR, percentile(rms, 0.9) * SPEECH_LEVEL_FACTOR)
  );

  // The first pause that ends past the minimum, cut in its middle. A pause
  // still running at the end of what has arrived counts as ended there.
  const minFrame = Math.floor(msToBytes(limits.minMs) / FRAME_BYTES);
  let runStart = -1;
  for (let f = 0; f < frameCount; f++) {
    if (rms[f] >= quiet) {
      runStart = -1;
      continue;
    }
    if (runStart < 0) runStart = f;
    const runLength = f - runStart + 1;
    const nextIsQuiet = f + 1 < frameCount && rms[f + 1] < quiet;
    if (runLength >= PAUSE_FRAMES && f + 1 >= minFrame && !nextIsQuiet) {
      return Math.max(minFrame, runStart + Math.floor(runLength / 2)) * FRAME_BYTES;
    }
  }

  if (length < maxBytes) return null;

  // No pause before the limit: the quietest window in its last stretch.
  const searchFrom = Math.max(
    0,
    frameCount - Math.floor(msToBytes(FALLBACK_SEARCH_MS) / FRAME_BYTES)
  );
  let bestEnd = frameCount;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let end = searchFrom + PAUSE_FRAMES; end <= frameCount; end++) {
    let energy = 0;
    for (let f = end - PAUSE_FRAMES; f < end; f++) energy += rms[f];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestEnd = end;
    }
  }
  return (bestEnd - Math.floor(PAUSE_FRAMES / 2)) * FRAME_BYTES;
}

// Rows for one decoded chunk. whisper.cpp's segments (seconds from the chunk
// start) each start at their own capture time; a result without them, as from
// sherpa models or an older LAN server, stays one row at the chunk start.
function toLocalMeetingSegments(result, chunkStartedAt, chunkDurationMs) {
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  const segments = Array.isArray(result?.segments)
    ? result.segments.filter((segment) => segment?.text?.trim())
    : [];
  if (segments.length === 0) {
    return text ? [{ text, timestamp: chunkStartedAt }] : [];
  }
  const clamp = (offsetMs) => Math.min(Math.max(0, offsetMs), Math.max(0, chunkDurationMs));
  return segments.map((segment) => {
    const startMs = clamp(Number.isFinite(segment.start) ? segment.start * 1000 : 0);
    const timed = {
      text: segment.text.trim(),
      timestamp: Math.round(chunkStartedAt + startMs),
    };
    // The end lets per-line speaker assignment hear only this line's voice.
    if (Number.isFinite(segment.end) && segment.end * 1000 > startMs) {
      timed.endTimestamp = Math.round(chunkStartedAt + clamp(segment.end * 1000));
    }
    return timed;
  });
}

module.exports = {
  LOCAL_CHUNK_LIMITS,
  LOCAL_CHUNK_MAX_MS,
  bytesToMs,
  findLocalChunkCut,
  toLocalMeetingSegments,
};
