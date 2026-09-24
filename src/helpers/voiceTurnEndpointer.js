// End-of-turn policy for voice conversation, clocked in samples so it is pure and
// replayable offline. Silence-only mode commits each Silero segment. Smart Turn
// mode treats a (short) Silero segment end as a candidate pause: the classifier
// decides whether the turn is complete, and max silence commits it regardless.

const DEFAULT_SAMPLE_RATE = 16000;
const SMART_TURN_CONTEXT_MS = 8000;

function concatSegments(segments) {
  const total = segments.reduce((sum, entry) => sum + entry.samples.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const entry of segments) {
    joined.set(entry.samples, offset);
    offset += entry.samples.length;
  }
  return joined;
}

function createTurnEndpointer({
  smartTurn,
  sampleRate = DEFAULT_SAMPLE_RATE,
  maxSilenceMs = 1200,
  threshold = 0.5,
  // Tiered mode: only a confident "complete" commits at the short pause; one
  // above `threshold` waits for `holdSilenceMs`. Off when fastThreshold is unset.
  fastThreshold = threshold,
  holdSilenceMs = maxSilenceMs,
  preRollMs = 500,
}) {
  const toSamples = (valueMs) => Math.round((valueMs * sampleRate) / 1000);
  const maxSilenceSamples = toSamples(maxSilenceMs);
  const holdSilenceSamples = toSamples(holdSilenceMs);
  const contextSamples = toSamples(SMART_TURN_CONTEXT_MS);
  const preRollSamples = toSamples(preRollMs);

  let segments = [];
  let speaking = false;
  let lastSpeechEndSample = 0;
  let nextRequestId = 1;
  let awaitingRequestId = null;
  let lastProbability = null;
  let holding = false;

  const reset = () => {
    segments = [];
    speaking = false;
    awaitingRequestId = null;
    lastProbability = null;
    holding = false;
  };

  const commit = (reason, commitSample, probability) => {
    const action = {
      type: "commit",
      reason,
      samples: concatSegments(segments),
      segments: segments.length,
      turnStartSample: segments[0].startSample,
      speechEndSample: lastSpeechEndSample,
      commitSample,
      probability,
    };
    reset();
    return [action];
  };

  return {
    onSpeechStart() {
      speaking = true;
      // Whatever the classifier says about the shorter turn no longer applies.
      awaitingRequestId = null;
      holding = false;
      return [];
    },

    onSegment({ samples, startSample, nowSample }) {
      segments.push({ samples, startSample });
      speaking = false;
      lastSpeechEndSample = startSample + samples.length;
      if (!smartTurn) return commit("silence", nowSample, null);
      awaitingRequestId = nextRequestId++;
      const turnStart = Math.max(0, segments[0].startSample - preRollSamples);
      return [
        {
          type: "classify",
          requestId: awaitingRequestId,
          fromSample: Math.max(turnStart, nowSample - contextSamples),
          toSample: nowSample,
        },
      ];
    },

    onPrediction({ requestId, probability, nowSample }) {
      if (requestId !== awaitingRequestId || speaking || segments.length === 0) return [];
      awaitingRequestId = null;
      if (probability === null || probability === undefined) return [];
      lastProbability = probability;
      if (probability > fastThreshold) return commit("smart-turn", nowSample, probability);
      holding = probability > threshold;
      return [];
    },

    advance(nowSample) {
      if (segments.length === 0 || speaking) return [];
      const silence = nowSample - lastSpeechEndSample;
      if (holding && silence >= holdSilenceSamples)
        return commit("smart-turn-hold", nowSample, lastProbability);
      if (silence < maxSilenceSamples) return [];
      return commit("max-silence", nowSample, lastProbability);
    },

    reset,
  };
}

/** Rolling mic history addressed by absolute sample index, for classifier windows. */
function createSampleRing(capacity) {
  const buffer = new Float32Array(capacity);
  let totalSamples = 0;

  return {
    get totalSamples() {
      return totalSamples;
    },

    push(samples) {
      const source =
        samples.length > capacity ? samples.subarray(samples.length - capacity) : samples;
      const skipped = samples.length - source.length;
      const writeAt = (totalSamples + skipped) % capacity;
      const firstPart = Math.min(source.length, capacity - writeAt);
      buffer.set(source.subarray(0, firstPart), writeAt);
      buffer.set(source.subarray(firstPart), 0);
      totalSamples += samples.length;
    },

    slice(fromSample, toSample) {
      const from = Math.max(fromSample, totalSamples - capacity, 0);
      const to = Math.min(toSample, totalSamples);
      if (to <= from) return new Float32Array(0);
      const out = new Float32Array(to - from);
      for (let index = 0; index < out.length; index += 1)
        out[index] = buffer[(from + index) % capacity];
      return out;
    },
  };
}

/**
 * Silero's segment starts at (or just after) the speech onset, and Parakeet
 * mangles a first word with no lead-in, so the committed turn gets the mic
 * audio from just before it. Offline: 300 ms cut WER 2.3% -> 1.4%.
 */
function withPreRoll({ ring, turnStartSample, samples, preRollSamples }) {
  const preRoll = ring.slice(turnStartSample - preRollSamples, turnStartSample);
  if (preRoll.length === 0) return samples;
  const audio = new Float32Array(preRoll.length + samples.length);
  audio.set(preRoll);
  audio.set(samples, preRoll.length);
  return audio;
}

module.exports = { createTurnEndpointer, createSampleRing, withPreRoll };
