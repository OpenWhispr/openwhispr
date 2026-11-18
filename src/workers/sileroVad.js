// Silero VAD (MIT, Copyright 2020-present Silero Team) on ONNX Runtime, with the segmenting
// rules of sherpa-onnx's voice activity detector (Apache-2.0, Copyright 2023 Xiaomi Corporation).

const SAMPLE_RATE = 16000;
// A turn that runs past maxSpeechDuration ends at the next short, confident pause.
const LONG_TURN_MIN_SILENCE_SECONDS = 0.1;
const LONG_TURN_THRESHOLD = 0.9;
const NEGATIVE_THRESHOLD_MARGIN = 0.15;
const INITIAL_BUFFER_SAMPLES = SAMPLE_RATE * 60;

/** Samples addressed by their position in the stream, dropped from the front once used. */
function createSampleBuffer(capacity = INITIAL_BUFFER_SAMPLES) {
  let data = new Float32Array(capacity);
  let head = 0;
  let tail = 0;

  function read(start, length, target = new Float32Array(length)) {
    const offset = start % data.length;
    const firstPart = Math.min(length, data.length - offset);
    target.set(data.subarray(offset, offset + firstPart));
    target.set(data.subarray(0, length - firstPart), firstPart);
    return target;
  }

  return {
    get head() {
      return head;
    },
    get tail() {
      return tail;
    },
    get size() {
      return tail - head;
    },
    push(samples) {
      if (tail - head + samples.length > data.length) {
        const grown = new Float32Array(Math.max(data.length * 2, tail - head + samples.length));
        const kept = read(head, tail - head);
        // Positions keep counting, so the kept samples go where the new size addresses them.
        for (let index = 0; index < kept.length; index += 1) {
          grown[(head + index) % grown.length] = kept[index];
        }
        data = grown;
      }
      for (let index = 0; index < samples.length; index += 1) {
        data[(tail + index) % data.length] = samples[index];
      }
      tail += samples.length;
    },
    get: (start, length) => read(start, length),
    pop(count) {
      head += count;
    },
    reset() {
      head = 0;
      tail = 0;
    },
  };
}

/**
 * Turns per-window speech probabilities into speech segments. `readProbability` runs the
 * model on one window, and windows are read one at a time, so the caller must await each
 * acceptWaveform before the next.
 */
function createVoiceActivityDetector({ config, readProbability, resetModel = () => {} }) {
  const { windowSize } = config;
  const toSamples = (seconds) => Math.round(SAMPLE_RATE * seconds);
  const minSpeechSamples = toSamples(config.minSpeechDuration);
  const maxUtteranceSamples = toSamples(config.maxSpeechDuration);
  const buffer = createSampleBuffer();
  const segments = [];

  let minSilenceSamples = toSamples(config.minSilenceDuration);
  let threshold = Math.fround(config.threshold);
  let pending = new Float32Array(0);
  let start = -1;
  let triggered = false;
  let currentSample = 0;
  let tempStart = 0;
  let tempEnd = 0;
  // A reset while a window is being read drops whatever that read finds.
  let generation = 0;

  function isSpeechWindow(probability) {
    currentSample += windowSize;
    const aboveThreshold = probability > threshold;
    if (aboveThreshold && tempEnd !== 0) tempEnd = 0;
    if (aboveThreshold && tempStart === 0) {
      tempStart = currentSample;
      return false;
    }
    if (aboveThreshold && !triggered) {
      if (currentSample - tempStart < minSpeechSamples) return false;
      triggered = true;
      return true;
    }
    if (probability < threshold && !triggered) {
      tempStart = 0;
      tempEnd = 0;
      return false;
    }
    if (triggered && probability > Math.max(threshold - NEGATIVE_THRESHOLD_MARGIN, 0.01)) {
      return true;
    }
    if (probability < threshold && triggered) {
      if (tempEnd === 0) tempEnd = currentSample;
      if (currentSample - tempEnd < minSilenceSamples) return true;
      tempStart = 0;
      tempEnd = 0;
      triggered = false;
    }
    return false;
  }

  async function acceptWaveform(samples) {
    const longTurn = buffer.size > maxUtteranceSamples;
    minSilenceSamples = toSamples(
      longTurn ? LONG_TURN_MIN_SILENCE_SECONDS : config.minSilenceDuration
    );
    threshold = Math.fround(longTurn ? LONG_TURN_THRESHOLD : config.threshold);

    const joined = new Float32Array(pending.length + samples.length);
    joined.set(pending);
    joined.set(samples, pending.length);
    const windows = Math.floor(joined.length / windowSize);
    pending = joined.slice(windows * windowSize);
    if (windows === 0) return;

    const startedIn = generation;
    let speech = false;
    for (let index = 0; index < windows; index += 1) {
      const window = joined.slice(index * windowSize, (index + 1) * windowSize);
      buffer.push(window);
      const probability = await readProbability(window);
      if (startedIn !== generation) return;
      speech = isSpeechWindow(probability) || speech;
    }

    const lookBack = 2 * windowSize + minSpeechSamples;
    if (speech) {
      if (start === -1) start = Math.max(buffer.tail - lookBack, buffer.head);
      return;
    }
    if (start !== -1 && buffer.size > 0) {
      const end = Math.max(buffer.tail - minSilenceSamples, start);
      segments.push({ start, samples: buffer.get(start, end - start) });
      buffer.pop(end - buffer.head);
    }
    if (start === -1) buffer.pop(Math.max(0, buffer.tail - lookBack - buffer.head));
    start = -1;
  }

  return {
    acceptWaveform,
    isDetected: () => start !== -1,
    isEmpty: () => segments.length === 0,
    front: () => segments[0],
    pop: () => void segments.shift(),
    reset() {
      generation += 1;
      segments.length = 0;
      buffer.reset();
      resetModel();
      pending = new Float32Array(0);
      start = -1;
      triggered = false;
      currentSample = 0;
      tempStart = 0;
      tempEnd = 0;
    },
  };
}

async function createSileroVad({ ort, sessionOptions, config }) {
  const session = await ort.InferenceSession.create(config.model, sessionOptions(1));
  const emptyState = () => new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
  let hidden = emptyState();
  let cell = emptyState();
  let modelGeneration = 0;

  return createVoiceActivityDetector({
    config,
    readProbability: async (window) => {
      const startedIn = modelGeneration;
      const output = await session.run({
        x: new ort.Tensor("float32", window, [1, window.length]),
        h: hidden,
        c: cell,
      });
      if (startedIn === modelGeneration) {
        hidden = output.new_h;
        cell = output.new_c;
      }
      return output.prob.data[0];
    },
    resetModel: () => {
      modelGeneration += 1;
      hidden = emptyState();
      cell = emptyState();
    },
  });
}

module.exports = { createSampleBuffer, createSileroVad, createVoiceActivityDetector };
