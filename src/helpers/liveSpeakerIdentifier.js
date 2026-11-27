const fs = require("fs");
const debugLogger = require("./debugLogger");
const speakerEmbeddings = require("./speakerEmbeddings");
const { MAX_EMBEDDING_SECONDS } = speakerEmbeddings;
const { downsample24kTo16k, pcm16ToFloat32 } = require("../utils/audioUtils");
const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");
const { normalizeSpeakerIndexBase } = require("./speakerIndexBase");

function clampMaxSpeakers(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_SPEAKER_COUNT;
  return Math.max(1, Math.min(MAX_SPEAKER_COUNT, Math.floor(n)));
}

// onnxruntime-node ships no darwin/x64 prebuilt binding since 1.24, so the
// require throws on Intel Macs (#1500). A missing binding must degrade live
// speaker identification, never fail the meeting start that triggers it.
let ortLoadFailed = false;

function loadOnnxRuntime() {
  if (ortLoadFailed) return null;
  try {
    return require("onnxruntime-node");
  } catch (error) {
    ortLoadFailed = true;
    debugLogger.warn(
      "onnxruntime-node binding failed to load — live speaker identification disabled",
      { error: error.message, platform: process.platform, arch: process.arch }
    );
    return null;
  }
}

const SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * MIN_SEGMENT_SECONDS);
const LIVE_IDENTIFICATION_MIN_SECONDS = 1.6;
const LIVE_IDENTIFICATION_MIN_SAMPLES = Math.round(SAMPLE_RATE * LIVE_IDENTIFICATION_MIN_SECONDS);
const LIVE_IDENTIFICATION_INTERVAL_SECONDS = 1.0;
const LIVE_IDENTIFICATION_INTERVAL_SAMPLES = Math.round(
  SAMPLE_RATE * LIVE_IDENTIFICATION_INTERVAL_SECONDS
);
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const SPEECH_CHUNKS_MAX_SAMPLES = MAX_EMBEDDING_SAMPLES * 4;
const SPEECH_THRESHOLD = 0.15;
const SILENCE_THRESHOLD = 0.08;
const SILENCE_WINDOWS_TO_END = 24;
// Minimum cosine to treat a live segment as an existing speaker (a voice already
// heard in this meeting, or a stored profile). Calibrated for the zh-en "advanced"
// CAM++ with Kaldi fbank: on real meetings, 0.60 kept wrong profile matches near
// 2% while matching ~99% of segments to the right in-meeting voice. The old 0.65
// was tuned to the previous model, whose embeddings sat in such a narrow cone that
// most different speakers still cleared it.
const MATCH_THRESHOLD = 0.6;
// Merging two in-meeting voices has no runner-up margin to lean on, so it needs a
// stricter bar: at 0.70 fewer than 1% of voices had a different speaker that close.
const RECLUSTER_THRESHOLD = 0.7;
const MATCH_MARGIN = 0.03;
// A meeting that can have more than one remote speaker gates new voices: one
// that matches no confirmed speaker is held as a candidate until it has 3
// segments totalling 8 s, or one segment of 12 s. On real meetings a voice drifts below 0.60
// against its own earlier segments in 20% of segments, which splits one person
// into several; matching at 0.45 while gated drops that to 2%. Stored profiles
// keep MATCH_THRESHOLD.
const CANDIDATE_MIN_SEGMENTS = 3;
const CANDIDATE_MIN_SECONDS = 8;
const CANDIDATE_SOLO_SECONDS = 12;
const MAX_CANDIDATES = 8;
const AUTO_MATCH_THRESHOLD = 0.45;
const DEFAULT_CANDIDATE_RULE = Object.freeze({
  minSegments: CANDIDATE_MIN_SEGMENTS,
  minSeconds: CANDIDATE_MIN_SECONDS,
  soloSeconds: CANDIDATE_SOLO_SECONDS,
  matchThreshold: AUTO_MATCH_THRESHOLD,
});
const LIVE_WINDOW_PADDING_SECONDS = 0.75;
// The 24 kHz -> 16 kHz resampler restarts on every buffer and only divides
// evenly on whole groups of 3 input samples (6 bytes). Capture buffers come in
// arbitrary sizes (PipeWire quantum, coalesced pipe reads, renderer loopback
// frames, recovery silence), so a partial group is carried into the next
// buffer; dropping it pulls the identifier clock behind real time.
const RESAMPLE_GROUP_BYTES = 6;
const DEFAULT_VAD_STATE_SHAPE = [2, 1, 64];
// The VAD graph is tiny (~64 ops per 512-sample window at ~31 Hz); ORT's
// default thread pool spins one worker per core for no throughput gain.
const VAD_SESSION_OPTIONS = {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: "sequential",
};

function appendFloat32(existing, next) {
  if (!existing.length) return next;
  if (!next.length) return existing;

  const merged = new Float32Array(existing.length + next.length);
  merged.set(existing, 0);
  merged.set(next, existing.length);
  return merged;
}

function totalSampleCount(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

function concatFloat32Arrays(chunks) {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  const merged = new Float32Array(totalSampleCount(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function trimChunksToMaxSamples(chunks, maxSamples) {
  let total = totalSampleCount(chunks);
  while (total > maxSamples && chunks.length > 0) {
    total -= chunks[0].length;
    chunks.shift();
  }
}

function selectBestEmbeddingWindow(samples) {
  if (samples.length <= MAX_EMBEDDING_SAMPLES) return samples;

  const stride = SAMPLE_RATE;
  let bestStart = 0;
  let bestEnergy = -Infinity;

  for (let start = 0; start + MAX_EMBEDDING_SAMPLES <= samples.length; start += stride) {
    let energy = 0;
    for (let i = start; i < start + MAX_EMBEDDING_SAMPLES; i++) {
      energy += Math.abs(samples[i]);
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }

  return samples.subarray(bestStart, bestStart + MAX_EMBEDDING_SAMPLES);
}

function cloneFloat32Array(value) {
  return new Float32Array(value);
}

function addToRunningMean(mean, count, embedding) {
  const next = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    next[i] = (mean[i] * count + embedding[i]) / (count + 1);
  }
  return next;
}

function normalizeVadShape(shape) {
  if (!Array.isArray(shape) || shape.length === 0) {
    return DEFAULT_VAD_STATE_SHAPE;
  }

  return shape.map((dim) => (typeof dim === "number" && dim > 0 ? dim : 1));
}

function normalizeVadStateName(name) {
  return String(name || "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function getBufferFloat32View(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

class LiveSpeakerIdentifier {
  constructor() {
    this.session = null;
    this.running = false;
    this.queue = Promise.resolve();
    this.onSpeakerIdentified = null;
    this.getSpeakerProfiles = null;
    this.pcmRemainder = Buffer.alloc(0);
    this.audioRemainder = new Float32Array(0);
    this.vadStateInputs = [];
    this.vadStateOutputs = [];
    this.vadStates = new Map();
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentForced = false;
    this.lastLiveIdentificationSample = 0;
    this._diarizationManager = null;
    this.maxSpeakers = MAX_SPEAKER_COUNT;
    this.gated = false;
    this.candidateRule = DEFAULT_CANDIDATE_RULE;
    this._candidates = [];
    this.enabled = true;
    this.stopping = false;

    this.enabledFromSample = 0;
  }

  setDiarizationManager(manager) {
    this._diarizationManager = manager;
  }

  isAvailable() {
    return (
      this._diarizationManager?.isVadModelDownloaded() &&
      speakerEmbeddings.isAvailable() &&
      loadOnnxRuntime() !== null
    );
  }

  getTransientState() {
    const state = {};

    for (const [speakerId, embedding] of this.transientEmbeddings.entries()) {
      state[speakerId] = {
        embedding: Array.from(embedding),
        displayName: this.transientDisplayNames.get(speakerId) || null,
        profileId: this.transientProfileIds.get(speakerId) ?? null,
        noteId: this.transientNoteIds.get(speakerId) ?? null,
      };
    }

    return state;
  }

  getSpeakerEmbedding(speakerId) {
    const embedding = this.transientEmbeddings.get(speakerId);
    return embedding ? cloneFloat32Array(embedding) : null;
  }

  async start(options = {}, extraOptions = {}) {
    const resolvedOptions =
      typeof options === "function" ? { onSpeakerIdentified: options, ...extraOptions } : options;
    const {
      onSpeakerIdentified = null,
      getSpeakerProfiles = null,
      maxSpeakers = MAX_SPEAKER_COUNT,
      enabled = true,
      speakerIndexBase = 0,
      gated = false,
      candidateRule = null,
    } = resolvedOptions;

    this.onSpeakerIdentified =
      typeof onSpeakerIdentified === "function" ? onSpeakerIdentified : null;
    this.getSpeakerProfiles = typeof getSpeakerProfiles === "function" ? getSpeakerProfiles : null;
    this.maxSpeakers = clampMaxSpeakers(maxSpeakers);
    this.gated = gated === true;
    this.candidateRule = { ...DEFAULT_CANDIDATE_RULE, ...candidateRule };
    this.enabled = enabled !== false;
    this._resetMeetingState();
    // A resumed note already holds earlier sessions' ids; see speakerIndexBase.js.
    this.nextLiveIndex = normalizeSpeakerIndexBase(speakerIndexBase);

    if (!this.isAvailable()) {
      debugLogger.warn("Live speaker identifier unavailable", {
        vadModelPath: this._diarizationManager?.getVadModelPath(),
        embeddingModelAvailable: speakerEmbeddings.isAvailable(),
      });
      return false;
    }

    await this._ensureLoaded();
    this.running = !!this.session;
    return this.running;
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    try {
      await this.queue;

      if (this.speechActive && this.audioRemainder.length > 0) {
        this.speechChunks.push(this.audioRemainder);
        this.audioRemainder = new Float32Array(0);
      }

      if (this.speechActive) {
        await this._finalizeSpeechSegment();
      }

      const transientState = this.getTransientState();
      this._resetMeetingState();
      this.onSpeakerIdentified = null;
      this.getSpeakerProfiles = null;
      return transientState;
    } finally {
      this.stopping = false;
    }
  }

  recluster() {
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(() => resolve(this._performRecluster()))
        .catch(() => resolve([]));
    });
  }

  _performRecluster() {
    const speakers = this._eligibleSpeakers();
    if (speakers.length < 2) return [];

    const merges = [];
    const removed = new Set();

    for (let i = 0; i < speakers.length; i += 1) {
      if (removed.has(speakers[i][0])) continue;
      for (let j = i + 1; j < speakers.length; j += 1) {
        if (removed.has(speakers[j][0])) continue;

        const similarity = speakerEmbeddings.cosineSimilarity(speakers[i][1], speakers[j][1]);
        if (similarity < RECLUSTER_THRESHOLD) continue;

        // Confirmed-distinct identities (different profiles, or different
        // user-set names) must never merge on embedding similarity alone.
        const profileI = this.transientProfileIds.get(speakers[i][0]);
        const profileJ = this.transientProfileIds.get(speakers[j][0]);
        if (profileI != null && profileJ != null && profileI !== profileJ) continue;
        const nameI = this.transientDisplayNames.get(speakers[i][0]);
        const nameJ = this.transientDisplayNames.get(speakers[j][0]);
        if (nameI && nameJ && nameI !== nameJ) continue;

        const countI = this.transientCounts.get(speakers[i][0]) || 1;
        const countJ = this.transientCounts.get(speakers[j][0]) || 1;
        const hasNameI = !!this.transientDisplayNames.get(speakers[i][0]);
        const hasNameJ = !!this.transientDisplayNames.get(speakers[j][0]);
        const keepFirst =
          hasNameI && !hasNameJ ? true : hasNameJ && !hasNameI ? false : countI >= countJ;
        const [keepId, removeId] = keepFirst
          ? [speakers[i][0], speakers[j][0]]
          : [speakers[j][0], speakers[i][0]];
        const keepCount = this.transientCounts.get(keepId) || 1;
        const removeCount = this.transientCounts.get(removeId) || 1;
        const keepEmb = this.transientEmbeddings.get(keepId);
        const removeEmb = this.transientEmbeddings.get(removeId);
        const totalCount = keepCount + removeCount;

        const merged = new Float32Array(keepEmb.length);
        for (let k = 0; k < keepEmb.length; k += 1) {
          merged[k] = (keepEmb[k] * keepCount + removeEmb[k] * removeCount) / totalCount;
        }

        this.transientEmbeddings.set(keepId, merged);
        this.transientCounts.set(keepId, totalCount);
        this.transientEmbeddings.delete(removeId);
        this.transientCounts.delete(removeId);

        if (!this.transientDisplayNames.get(keepId) && this.transientDisplayNames.get(removeId)) {
          this.transientDisplayNames.set(keepId, this.transientDisplayNames.get(removeId));
        }
        this.transientDisplayNames.delete(removeId);

        if (!this.transientProfileIds.get(keepId) && this.transientProfileIds.get(removeId)) {
          this.transientProfileIds.set(keepId, this.transientProfileIds.get(removeId));
        }
        this.transientProfileIds.delete(removeId);

        if (!this.transientNoteIds.get(keepId) && this.transientNoteIds.get(removeId)) {
          this.transientNoteIds.set(keepId, this.transientNoteIds.get(removeId));
        }
        this.transientNoteIds.delete(removeId);

        if (this.currentSegmentSpeakerId === removeId) {
          this.currentSegmentSpeakerId = keepId;
        }

        removed.add(removeId);
        merges.push({
          keep: keepId,
          remove: removeId,
          displayName: this.transientDisplayNames.get(keepId) || null,
          similarity,
        });

        debugLogger.info("Speaker recluster merge", {
          keep: keepId,
          remove: removeId,
          similarity: similarity.toFixed(3),
          keepCount,
          removeCount,
        });
      }
    }

    return merges;
  }

  feedAudio(pcmBuffer) {
    if (!this.running || !pcmBuffer?.length) {
      return Promise.resolve();
    }

    this.queue = this.queue
      .then(() => this._processAudio(pcmBuffer))
      .catch((error) => {
        debugLogger.warn("Live speaker identification failed", { error: error.message });
      });

    return this.queue;
  }

  setMaxSpeakers(n) {
    this.maxSpeakers = clampMaxSpeakers(n);
    if (
      this.currentSegmentSpeakerId &&
      !this._eligibleSpeakers().some(([id]) => id === this.currentSegmentSpeakerId)
    ) {
      this.currentSegmentSpeakerId = null;
      this.currentSegmentForced = false;
    }
  }

  // Retain older rows' identities for naming, post-call reconciliation and a
  // later increase. Only the first N surviving voices may own new speech.
  _eligibleSpeakers() {
    return Array.from(this.transientEmbeddings.entries()).slice(0, this.maxSpeakers);
  }

  setSpeakerLimit({ maxSpeakers, gated }) {
    if (this.stopping) return;
    this.setMaxSpeakers(maxSpeakers);
    this.gated = gated === true;
    if (!this.gated) this._candidates = [];
  }

  getConfirmedSpeakerCount() {
    return this.transientEmbeddings.size;
  }

  setEnabled(enabled) {
    // A debounced UI toggle can arrive after stop has begun draining the queue.
    if (this.stopping) return;
    const apply = () => {
      const next = enabled !== false;
      if (next === this.enabled) return;
      this.enabled = next;
      this.sampleCursor += this.audioRemainder.length;
      this.audioRemainder = new Float32Array(0);
      this.enabledFromSample = this.sampleCursor;
      this.speechActive = false;
      this.speechChunks = [];
      this.currentSegmentSpeakerId = null;
      this.currentSegmentForced = false;
      this._resetVadRuntimeState();
      if (!next) {
        // Padding on the last enabled turn must not take the first disabled line.
        for (const candidate of this._candidates) {
          for (const window of candidate.windows) {
            window.endTime = Math.min(window.endTime, this.sampleCursor / SAMPLE_RATE);
          }
        }
      }
    };
    // Capture and toggles share a queue. An embedding that finishes late still
    // belongs to the setting in effect when its audio arrived.
    if (this.running) this.queue = this.queue.then(apply);
    else apply();
  }

  mapSpeaker(liveId, profileId, displayName, noteId) {
    if (!liveId || !this.transientEmbeddings.has(liveId)) {
      // Labeling a speaker in a past note routes here with no live session, so
      // only an active session losing a mapping is worth flagging.
      if (this.running) {
        debugLogger.warn("Live speaker mapping dropped: unknown speaker id", {
          liveId,
          hasDisplayName: !!displayName,
          knownSpeakers: [...this.transientEmbeddings.keys()],
        });
      }
      return false;
    }

    if (profileId != null) {
      this.transientProfileIds.set(liveId, profileId);
    }

    if (displayName) {
      this.transientDisplayNames.set(liveId, displayName);
    }

    if (noteId != null) {
      this.transientNoteIds.set(liveId, noteId);
    }

    return true;
  }

  async _ensureLoaded() {
    if (this.session) return;

    const vadModelPath = this._diarizationManager?.getVadModelPath();
    if (!fs.existsSync(vadModelPath)) {
      return;
    }

    const ort = loadOnnxRuntime();
    if (!ort) return;

    this.session = await ort.InferenceSession.create(vadModelPath, VAD_SESSION_OPTIONS);
    this.vadStateInputs = (this.session.inputNames || []).filter((name) => /state|h|c/i.test(name));
    this.vadStateOutputs = (this.session.outputNames || []).filter((name) =>
      /state|h|c/i.test(name)
    );
    this._resetVadRuntimeState();
  }

  _resetMeetingState() {
    this.enabledFromSample = 0;
    this.queue = Promise.resolve();
    this.pcmRemainder = Buffer.alloc(0);
    this.audioRemainder = new Float32Array(0);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this._candidates = [];
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentForced = false;
    this.lastLiveIdentificationSample = 0;
    this._resetVadRuntimeState();
  }

  _resetVadRuntimeState() {
    this.vadStates = new Map();

    if (!this.session) {
      return;
    }

    for (const name of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[name];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const size = shape.reduce((total, dim) => total * dim, 1);
      this.vadStates.set(name, new Float32Array(size));
    }
  }

  async _processAudio(pcmBuffer) {
    await this._ensureLoaded();
    if (!this.session) return;

    // Carry the bytes past the last whole resample group into the next buffer.
    // The concat copies into a new buffer, so the Int16 view never inherits the
    // caller's byteOffset.
    const incoming = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    const pending = Buffer.concat([this.pcmRemainder, incoming]);
    const usableBytes = pending.length - (pending.length % RESAMPLE_GROUP_BYTES);
    this.pcmRemainder = Buffer.from(pending.subarray(usableBytes));
    if (!usableBytes) return;

    const downsampled = downsample24kTo16k(pending.subarray(0, usableBytes));
    if (!downsampled.length) return;

    this.audioRemainder = appendFloat32(this.audioRemainder, pcm16ToFloat32(downsampled));

    while (this.audioRemainder.length >= VAD_WINDOW_SIZE) {
      const window = this.audioRemainder.subarray(0, VAD_WINDOW_SIZE);
      this.audioRemainder = this.audioRemainder.slice(VAD_WINDOW_SIZE);

      const windowStartSample = this.sampleCursor;
      this.sampleCursor += window.length;

      await this._processWindow(window, windowStartSample, this.sampleCursor);
    }
  }

  async _processWindow(window, windowStartSample, windowEndSample) {
    if (!this.enabled) return;
    const probability = await this._getVadProbability(window);

    if (this.speechActive) {
      this.speechChunks.push(cloneFloat32Array(window));
      trimChunksToMaxSamples(this.speechChunks, SPEECH_CHUNKS_MAX_SAMPLES);
      this.segmentEndSample = windowEndSample;

      if (probability >= SILENCE_THRESHOLD) {
        this.silenceWindows = 0;
        await this._identifyActiveSpeechSegment();
        return;
      }

      this.silenceWindows += 1;
      if (this.silenceWindows >= SILENCE_WINDOWS_TO_END) {
        await this._finalizeSpeechSegment();
      }
      return;
    }

    if (probability < SPEECH_THRESHOLD) {
      return;
    }

    this.speechActive = true;
    this.segmentStartSample = windowStartSample;
    this.segmentEndSample = windowEndSample;
    this.speechChunks = [cloneFloat32Array(window)];
    this.silenceWindows = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentForced = false;
    this.lastLiveIdentificationSample = 0;
  }

  async _getVadProbability(window) {
    if (!this.session) return 0;

    const ort = loadOnnxRuntime();
    if (!ort) return 0;
    const feeds = {};
    const audioInputName = (this.session.inputNames || []).find(
      (name) => !this.vadStateInputs.includes(name) && !/sr|sample.?rate/i.test(name)
    );

    if (!audioInputName) {
      return 0;
    }

    feeds[audioInputName] = new ort.Tensor("float32", window, [1, window.length]);

    const sampleRateInputName = (this.session.inputNames || []).find((name) =>
      /sr|sample.?rate/i.test(name)
    );
    if (sampleRateInputName) {
      feeds[sampleRateInputName] = new ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(SAMPLE_RATE)]),
        [1]
      );
    }

    for (const stateName of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[stateName];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const state =
        this.vadStates.get(stateName) || new Float32Array(shape.reduce((a, b) => a * b, 1));

      this.vadStates.set(stateName, state);
      feeds[stateName] = new ort.Tensor("float32", state, shape);
    }

    const results = await this.session.run(feeds);
    this._updateVadState(results);

    const outputName = (this.session.outputNames || []).find(
      (name) => !this.vadStateOutputs.includes(name)
    );
    const output = (outputName && results[outputName]) || Object.values(results)[0];
    const value = output?.data?.[0];
    return typeof value === "number" ? value : 0;
  }

  _updateVadState(results) {
    if (!results) {
      return;
    }

    for (const inputName of this.vadStateInputs) {
      const expectedName = normalizeVadStateName(inputName);
      const matchingOutput = this.vadStateOutputs.find((outputName) =>
        normalizeVadStateName(outputName).startsWith(expectedName)
      );
      const output = (matchingOutput && results[matchingOutput]) || results[inputName];

      if (output?.data) {
        this.vadStates.set(inputName, new Float32Array(output.data));
      }
    }
  }

  async _identifyActiveSpeechSegment(force = false) {
    // Runs on every speech window (~31x/sec), so the cheap gates must come
    // first — concatenating up to 32s of float32 per window is ~64 MB/s of
    // wasted main-thread memcpy during continuous speech.
    if (totalSampleCount(this.speechChunks) < LIVE_IDENTIFICATION_MIN_SAMPLES) {
      return;
    }

    if (
      !force &&
      this.lastLiveIdentificationSample > 0 &&
      this.segmentEndSample - this.lastLiveIdentificationSample <
        LIVE_IDENTIFICATION_INTERVAL_SAMPLES
    ) {
      return;
    }

    const allSamples = concatFloat32Arrays(this.speechChunks);
    const currentSamples =
      allSamples.length > MAX_EMBEDDING_SAMPLES
        ? allSamples.subarray(allSamples.length - MAX_EMBEDDING_SAMPLES)
        : allSamples;

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(currentSamples);
    if (!embedding || !this.enabled) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: false });
    // A voice held as a candidate gets no live label, but its windows still
    // count toward the throttle, or every VAD window re-extracts an embedding.
    this.lastLiveIdentificationSample = this.segmentEndSample;
    if (!resolved?.speakerId) {
      return;
    }

    this.currentSegmentSpeakerId = resolved.speakerId;
    this.currentSegmentForced = resolved.forced;

    this.onSpeakerIdentified?.({
      speakerId: resolved.speakerId,
      ...(this.gated && !resolved.forced && { tentative: true }),
      displayName: resolved.displayName || null,
      startTime: Math.max(
        this.enabledFromSample / SAMPLE_RATE,
        this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS
      ),
      endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
      ...this._segmentSpeechRange(),
    });
  }

  // The window an identification covers is padded on both sides, so it reaches
  // into the neighbouring speakers' audio. The speech range is the part that is
  // this segment's own.
  _segmentSpeechRange() {
    return {
      speechStartTime: this.segmentStartSample / SAMPLE_RATE,
      speechEndTime: this.segmentEndSample / SAMPLE_RATE,
    };
  }

  async _finalizeSpeechSegment() {
    const samples = concatFloat32Arrays(this.speechChunks);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;

    if (samples.length < MIN_SEGMENT_SAMPLES) {
      return;
    }

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(
      selectBestEmbeddingWindow(samples)
    );
    if (!embedding || !this.enabled) {
      return;
    }

    const startTime = Math.max(
      this.enabledFromSample / SAMPLE_RATE,
      this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS
    );
    const endTime = this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS;
    const window = { startTime, endTime, ...this._segmentSpeechRange() };
    const resolved = this._resolveSpeakerForEmbedding(embedding, {
      updateCentroid: true,
      segment: {
        seconds: (this.segmentEndSample - this.segmentStartSample) / SAMPLE_RATE,
        ...window,
      },
    });

    const speakerId = resolved?.speakerId;
    if (speakerId && this.enabled) {
      const displayName = resolved.displayName;

      // A promoted or absorbed candidate's earlier lines go out first, so the
      // renderer can relabel them without taking them for the current speaker.
      for (const earlier of resolved.backfill || []) {
        this.onSpeakerIdentified?.({ speakerId, displayName, ...earlier, retroactive: true });
      }
      const rejudged = this.currentSegmentSpeakerId && this.currentSegmentSpeakerId !== speakerId;
      this.onSpeakerIdentified?.({
        speakerId,
        displayName,
        ...window,
        ...(rejudged && { rejudged: true }),
      });
    }

    this.currentSegmentSpeakerId = null;
    this.currentSegmentForced = false;
    this.lastLiveIdentificationSample = 0;
  }

  _findTransientMatch(embedding) {
    let bestSpeakerId = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const [speakerId, centroid] of this._eligibleSpeakers()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return bestSimilarity >= this._inMeetingMatchThreshold() &&
      bestSimilarity - secondBestSimilarity >= MATCH_MARGIN
      ? bestSpeakerId
      : null;
  }

  _inMeetingMatchThreshold() {
    return this.gated ? this.candidateRule.matchThreshold : MATCH_THRESHOLD;
  }

  _findStoredProfileMatch(embedding) {
    let profiles = [];

    try {
      profiles = this.getSpeakerProfiles?.() || [];
    } catch (error) {
      debugLogger.debug("Live speaker profile lookup failed", { error: error.message });
      return null;
    }

    let bestProfile = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const profile of profiles) {
      if (!profile?.embedding) continue;

      const profileEmbedding =
        profile.embedding instanceof Float32Array
          ? profile.embedding
          : Array.isArray(profile.embedding)
            ? new Float32Array(profile.embedding)
            : getBufferFloat32View(profile.embedding);

      if (!profileEmbedding.length) continue;

      const similarity = speakerEmbeddings.cosineSimilarity(embedding, profileEmbedding);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestProfile = profile;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return bestSimilarity >= MATCH_THRESHOLD &&
      bestSimilarity - secondBestSimilarity >= MATCH_MARGIN
      ? bestProfile
      : null;
  }

  _resolveSpeakerForEmbedding(embedding, options = {}) {
    const resolved = this._matchOrCreateSpeaker(embedding, options);
    if (
      options.segment &&
      this.currentSegmentSpeakerId &&
      resolved.speakerId !== this.currentSegmentSpeakerId
    ) {
      this._logGate("rejudged", { liveWindowSpeaker: this.currentSegmentSpeakerId });
    }
    // A held voice can turn out to be a speaker confirmed without it: by a
    // stored profile, or once that speaker's centroid has moved. Only a finished
    // segment can send its lines along.
    if (options.segment && resolved.speakerId && this._candidates.length > 0) {
      resolved.backfill = [
        ...resolved.backfill,
        ...(resolved.forced
          ? this._takeCandidateWindows(embedding)
          : this._takeWindowsOfCandidatesMatching(resolved.speakerId)),
      ].sort((left, right) => left.startTime - right.startTime);
    }
    return resolved;
  }

  _matchOrCreateSpeaker(embedding, options) {
    const { updateCentroid = false, segment = null } = options;

    // Reconsider a tentative live match on the whole segment. The legacy
    // threshold still takes precedence; a weaker match must first give an
    // enrolled attendee's voice a chance.
    const stickySpeaker =
      !segment || !this.gated || this.currentSegmentForced ? this.currentSegmentSpeakerId : null;
    let speakerId = stickySpeaker || this._findTransientMatch(embedding);
    let forced = Boolean(stickySpeaker && this.currentSegmentForced);
    const weakMatch =
      !stickySpeaker &&
      speakerId &&
      this.gated &&
      speakerEmbeddings.cosineSimilarity(embedding, this.transientEmbeddings.get(speakerId)) <
        MATCH_THRESHOLD;
    const matchedProfile = !speakerId || weakMatch ? this._findStoredProfileMatch(embedding) : null;
    if (matchedProfile) {
      speakerId = this._findTransientSpeakerForProfile(matchedProfile.id);
      if (!speakerId) {
        ({ speakerId, forced } = this._assignOrForceCluster(embedding));
      } else if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }

      // A forced at-cap fold lands on someone else's cluster — retagging it
      // with the overflow speaker's profile would erase the original identity
      // and keep capturing this voice via the profile lookup even after the
      // cap rises.
      if (forced) {
        return {
          speakerId,
          displayName: this.transientDisplayNames.get(speakerId) || null,
          forced,
          backfill: [],
        };
      }

      this.transientProfileIds.set(speakerId, matchedProfile.id);
      this.transientDisplayNames.set(speakerId, matchedProfile.display_name);
      return {
        speakerId,
        displayName: matchedProfile.display_name,
        forced,
        backfill: [],
      };
    }

    if (speakerId) {
      // At the cap the label is only a fallback until the final embedding
      // actually matches it; otherwise the next cap increase inherits a mixed voice.
      if (updateCentroid && (!forced || this._foldedVoiceMatches(embedding, speakerId))) {
        this._updateCentroid(speakerId, embedding);
      }
      return {
        speakerId,
        displayName: this.transientDisplayNames.get(speakerId) || null,
        forced,
        backfill: [],
      };
    }

    // The first voice needs no gate, and at the cap there is no new speaker to
    // hold a voice for: it is folded onto the nearest one, as without the gate.
    if (
      this.gated &&
      this.transientEmbeddings.size > 0 &&
      this.transientEmbeddings.size < this.maxSpeakers
    ) {
      // Live windows are too short to judge a new voice, so only finished
      // segments add evidence.
      return segment
        ? this._holdAsCandidate(embedding, segment)
        : { speakerId: null, displayName: null, forced: false, backfill: [] };
    }

    ({ speakerId, forced } = this._assignOrForceCluster(embedding));

    return {
      speakerId,
      displayName: this.transientDisplayNames.get(speakerId) || null,
      forced,
      backfill: [],
    };
  }

  _foldedVoiceMatches(embedding, speakerId) {
    if (this._findTransientMatch(embedding) !== speakerId) return false;
    const profile = this._findStoredProfileMatch(embedding);
    return !profile || this.transientProfileIds.get(speakerId) === profile.id;
  }

  _takeCandidateWindows(embedding) {
    const candidate = this._findCandidateMatch(embedding);
    if (!candidate) return [];
    this._removeCandidate(candidate);
    this._logGate("folded at the cap", { lines: candidate.windows.length });
    return candidate.windows;
  }

  _takeWindowsOfCandidatesMatching(speakerId) {
    const windows = [];
    for (const candidate of this._candidates) {
      if (this._findTransientMatch(candidate.centroid) !== speakerId) continue;
      this._removeCandidate(candidate);
      this._logGate("absorbed", { speakerId, lines: candidate.windows.length });
      windows.push(...candidate.windows);
    }
    return windows;
  }

  _holdAsCandidate(embedding, segment) {
    let candidate = this._findCandidateMatch(embedding);
    if (candidate) {
      candidate.centroid = addToRunningMean(candidate.centroid, candidate.count, embedding);
      candidate.count += 1;
    } else {
      if (this._candidates.length >= MAX_CANDIDATES) this._dropWeakestCandidate();
      candidate = { centroid: cloneFloat32Array(embedding), count: 1, seconds: 0, windows: [] };
      this._candidates.push(candidate);
    }
    candidate.seconds += segment.seconds;

    const absorbedInto = this._findTransientMatch(candidate.centroid);
    if (absorbedInto) {
      this._updateCentroid(absorbedInto, candidate.centroid);
      this._removeCandidate(candidate);
      this._logGate("absorbed", { speakerId: absorbedInto, lines: candidate.windows.length });
      return {
        speakerId: absorbedInto,
        displayName: this.transientDisplayNames.get(absorbedInto) || null,
        forced: false,
        backfill: candidate.windows,
      };
    }

    if (this._candidateHasEnoughEvidence(candidate, segment.seconds)) {
      // The centroid is the mean of every segment heard, and is weighted as such.
      const speakerId = this._assignSpeakerId(candidate.centroid, candidate.count);
      this._removeCandidate(candidate);
      this._logGate("promoted", {
        speakerId,
        segments: candidate.count,
        seconds: candidate.seconds.toFixed(1),
        lines: candidate.windows.length,
      });
      return { speakerId, displayName: null, forced: false, backfill: candidate.windows };
    }

    const { seconds: _seconds, ...window } = segment;
    candidate.windows.push(this.currentSegmentSpeakerId ? { ...window, rejudged: true } : window);
    this._logGate("held", {
      segments: candidate.count,
      seconds: candidate.seconds.toFixed(1),
      nearest: this._nearestTransientSimilarity(embedding),
    });
    return { speakerId: null, displayName: null, forced: false, backfill: [] };
  }

  _findCandidateMatch(embedding) {
    let bestCandidate = null;
    let bestSimilarity = -Infinity;
    for (const candidate of this._candidates) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, candidate.centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestCandidate = candidate;
      }
    }
    return bestSimilarity >= this.candidateRule.matchThreshold ? bestCandidate : null;
  }

  _candidateHasEnoughEvidence(candidate, segmentSeconds) {
    const { minSegments, minSeconds, soloSeconds } = this.candidateRule;
    return (
      (candidate.count >= minSegments && candidate.seconds >= minSeconds) ||
      segmentSeconds >= soloSeconds
    );
  }

  _dropWeakestCandidate() {
    let weakest = this._candidates[0];
    for (const candidate of this._candidates) {
      if (candidate.seconds < weakest.seconds) weakest = candidate;
    }
    this._removeCandidate(weakest);
    this._logGate("dropped", { segments: weakest.count, lines: weakest.windows.length });
  }

  // The gate decides who a line belongs to and says nothing on screen while it
  // holds a voice, so its decisions are the only trace of a wrong label.
  _logGate(decision, details) {
    debugLogger.debug("Live speaker gate", {
      decision,
      ...details,
      candidates: this._candidates.length,
      speakers: this.transientEmbeddings.size,
    });
  }

  _nearestTransientSimilarity(embedding) {
    const nearest = this._findNearestTransient(embedding);
    if (!nearest) return null;
    const centroid = this.transientEmbeddings.get(nearest);
    return `${nearest} ${speakerEmbeddings.cosineSimilarity(embedding, centroid).toFixed(3)}`;
  }

  _removeCandidate(candidate) {
    this._candidates = this._candidates.filter((other) => other !== candidate);
  }

  _assignOrForceCluster(embedding) {
    if (this.transientEmbeddings.size >= this.maxSpeakers) {
      const nearest = this._findNearestTransient(embedding);
      if (nearest) {
        // Label only — never fold the embedding into the centroid. At-cap
        // overflow is usually a different voice, and a polluted centroid would
        // keep capturing it even after the cap rises (participants added
        // mid-meeting).
        return { speakerId: nearest, forced: true };
      }
    }
    return { speakerId: this._assignSpeakerId(embedding), forced: false };
  }

  _findNearestTransient(embedding) {
    let bestSpeakerId = null;
    let bestSimilarity = -Infinity;
    for (const [speakerId, centroid] of this._eligibleSpeakers()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      }
    }
    return bestSpeakerId;
  }

  _findTransientSpeakerForProfile(profileId) {
    for (const [speakerId] of this._eligibleSpeakers()) {
      if (this.transientProfileIds.get(speakerId) === profileId) {
        return speakerId;
      }
    }

    return null;
  }

  // Cluster ids double as the transcript's speaker labels. Ids freed by a
  // recluster merge are never reused: durable state (note speaker mappings,
  // the renderer's name map) may still reference them, and a recycled id would
  // let a new voice inherit the previous person's identity.
  _assignSpeakerId(embedding, count = 1) {
    const speakerId = `speaker_${this.nextLiveIndex}`;
    this.nextLiveIndex += 1;
    this.transientEmbeddings.set(speakerId, cloneFloat32Array(embedding));
    this.transientCounts.set(speakerId, count);
    return speakerId;
  }

  _updateCentroid(speakerId, embedding) {
    const centroid = this.transientEmbeddings.get(speakerId);
    if (!centroid) {
      return;
    }

    const count = this.transientCounts.get(speakerId) || 1;
    this.transientEmbeddings.set(speakerId, addToRunningMean(centroid, count, embedding));
    this.transientCounts.set(speakerId, count + 1);
  }
}

const instance = new LiveSpeakerIdentifier();
module.exports = instance;
module.exports.LiveSpeakerIdentifier = LiveSpeakerIdentifier;
module.exports.CANDIDATE_MIN_SEGMENTS = CANDIDATE_MIN_SEGMENTS;
module.exports.CANDIDATE_MIN_SECONDS = CANDIDATE_MIN_SECONDS;
module.exports.CANDIDATE_SOLO_SECONDS = CANDIDATE_SOLO_SECONDS;
module.exports.MAX_CANDIDATES = MAX_CANDIDATES;
module.exports.AUTO_MATCH_THRESHOLD = AUTO_MATCH_THRESHOLD;
