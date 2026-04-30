const fs = require("fs");
const debugLogger = require("./debugLogger");
const speakerEmbeddings = require("./speakerEmbeddings");
const { downsample24kTo16k } = require("../utils/audioUtils");
const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");

function clampMaxSpeakers(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_SPEAKER_COUNT;
  return Math.max(1, Math.min(MAX_SPEAKER_COUNT, Math.floor(n)));
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
const MAX_EMBEDDING_SECONDS = 8;
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const SPEECH_CHUNKS_MAX_SAMPLES = MAX_EMBEDDING_SAMPLES * 4;
const SPEECH_THRESHOLD = 0.15;
const SILENCE_THRESHOLD = 0.08;
const SILENCE_WINDOWS_TO_END = 24;
const MATCH_THRESHOLD = 0.65;
const MATCH_MARGIN = 0.03;
const LIVE_WINDOW_PADDING_SECONDS = 0.75;
const DEFAULT_VAD_STATE_SHAPE = [2, 1, 64];

function pcm16BufferToFloat32(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Float32Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] / 32768;
  }

  return output;
}

function appendFloat32(existing, next) {
  if (!existing.length) return next;
  if (!next.length) return existing;

  const merged = new Float32Array(existing.length + next.length);
  merged.set(existing, 0);
  merged.set(next, existing.length);
  return merged;
}

function concatFloat32Arrays(chunks) {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function trimChunksToMaxSamples(chunks, maxSamples) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
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
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
    this._diarizationManager = null;
    this.maxSpeakers = MAX_SPEAKER_COUNT;
    this.enabled = true;
  }

  setDiarizationManager(manager) {
    this._diarizationManager = manager;
  }

  isAvailable() {
    return this._diarizationManager?.isVadModelDownloaded() && speakerEmbeddings.isAvailable();
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
    } = resolvedOptions;

    this.onSpeakerIdentified =
      typeof onSpeakerIdentified === "function" ? onSpeakerIdentified : null;
    this.getSpeakerProfiles = typeof getSpeakerProfiles === "function" ? getSpeakerProfiles : null;
    this.maxSpeakers = clampMaxSpeakers(maxSpeakers);
    this.enabled = enabled !== false;
    this._resetMeetingState();

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
  }

  recluster() {
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(() => resolve(this._performRecluster()))
        .catch(() => resolve([]));
    });
  }

  _performRecluster() {
    const speakers = [...this.transientEmbeddings.entries()];
    if (speakers.length < 2) return [];

    const merges = [];
    const removed = new Set();

    for (let i = 0; i < speakers.length; i += 1) {
      if (removed.has(speakers[i][0])) continue;
      for (let j = i + 1; j < speakers.length; j += 1) {
        if (removed.has(speakers[j][0])) continue;

        const similarity = speakerEmbeddings.cosineSimilarity(speakers[i][1], speakers[j][1]);
        if (similarity < MATCH_THRESHOLD) continue;

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
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false;
  }

  mapSpeaker(liveId, profileId, displayName, noteId) {
    if (!liveId || !this.transientEmbeddings.has(liveId)) {
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

    const ort = require("onnxruntime-node");
    this.session = await ort.InferenceSession.create(vadModelPath);
    this.vadStateInputs = (this.session.inputNames || []).filter((name) => /state|h|c/i.test(name));
    this.vadStateOutputs = (this.session.outputNames || []).filter((name) =>
      /state|h|c/i.test(name)
    );
    this._resetVadRuntimeState();
  }

  _resetMeetingState() {
    this.queue = Promise.resolve();
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
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
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

    const downsampled = downsample24kTo16k(
      Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer)
    );
    if (!downsampled.length) return;

    this.audioRemainder = appendFloat32(this.audioRemainder, pcm16BufferToFloat32(downsampled));

    while (this.audioRemainder.length >= VAD_WINDOW_SIZE) {
      const window = this.audioRemainder.subarray(0, VAD_WINDOW_SIZE);
      this.audioRemainder = this.audioRemainder.slice(VAD_WINDOW_SIZE);

      const windowStartSample = this.sampleCursor;
      this.sampleCursor += window.length;

      await this._processWindow(window, windowStartSample, this.sampleCursor);
    }
  }

  async _processWindow(window, windowStartSample, windowEndSample) {
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
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  async _getVadProbability(window) {
    if (!this.session) return 0;

    const ort = require("onnxruntime-node");
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
    const allSamples = concatFloat32Arrays(this.speechChunks);
    if (allSamples.length < LIVE_IDENTIFICATION_MIN_SAMPLES) {
      return;
    }
    const currentSamples =
      allSamples.length > MAX_EMBEDDING_SAMPLES
        ? allSamples.subarray(allSamples.length - MAX_EMBEDDING_SAMPLES)
        : allSamples;

    if (
      !force &&
      this.lastLiveIdentificationSample > 0 &&
      this.segmentEndSample - this.lastLiveIdentificationSample <
        LIVE_IDENTIFICATION_INTERVAL_SAMPLES
    ) {
      return;
    }

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(currentSamples);
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: false });
    if (!resolved?.speakerId) {
      return;
    }

    this.currentSegmentSpeakerId = resolved.speakerId;
    this.currentSegmentSpeakerName = resolved.displayName || null;
    this.lastLiveIdentificationSample = this.segmentEndSample;

    if (!this.enabled) return;

    this.onSpeakerIdentified?.({
      speakerId: resolved.speakerId,
      displayName: resolved.displayName || null,
      startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
      endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
    });
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
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: true });
    if (!resolved?.speakerId) {
      return;
    }

    const speakerId = resolved.speakerId;
    const displayName =
      resolved.displayName ||
      this.currentSegmentSpeakerName ||
      this.transientDisplayNames.get(speakerId) ||
      null;

    if (this.enabled) {
      this.onSpeakerIdentified?.({
        speakerId,
        displayName,
        startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
        endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
      });
    }

    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  _findTransientMatch(embedding) {
    let bestSpeakerId = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const [speakerId, centroid] of this.transientEmbeddings.entries()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return bestSimilarity >= MATCH_THRESHOLD &&
      bestSimilarity - secondBestSimilarity >= MATCH_MARGIN
      ? bestSpeakerId
      : null;
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
    const { updateCentroid = false } = options;

    let speakerId = this.currentSegmentSpeakerId || this._findTransientMatch(embedding);
    let displayName = this.currentSegmentSpeakerName || null;

    if (speakerId) {
      if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }

      return {
        speakerId,
        displayName: displayName || this.transientDisplayNames.get(speakerId) || null,
      };
    }

    const matchedProfile = this._findStoredProfileMatch(embedding);
    if (matchedProfile) {
      speakerId = this._findTransientSpeakerForProfile(matchedProfile.id);
      if (!speakerId) {
        speakerId = this._assignOrForceCluster(embedding);
      } else if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }

      this.transientProfileIds.set(speakerId, matchedProfile.id);
      this.transientDisplayNames.set(speakerId, matchedProfile.display_name);
      return {
        speakerId,
        displayName: matchedProfile.display_name,
      };
    }

    speakerId = this.currentSegmentSpeakerId || this._assignOrForceCluster(embedding);
    if (updateCentroid && this.currentSegmentSpeakerId) {
      this._updateCentroid(speakerId, embedding);
    }

    return {
      speakerId,
      displayName: this.transientDisplayNames.get(speakerId) || null,
    };
  }

  _assignOrForceCluster(embedding) {
    if (this.transientEmbeddings.size >= this.maxSpeakers) {
      const nearest = this._findNearestTransient(embedding);
      if (nearest) {
        this._updateCentroid(nearest, embedding);
        return nearest;
      }
    }
    return this._assignSpeakerId(embedding);
  }

  _findNearestTransient(embedding) {
    let bestSpeakerId = null;
    let bestSimilarity = -Infinity;
    for (const [speakerId, centroid] of this.transientEmbeddings.entries()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      }
    }
    return bestSpeakerId;
  }

  _findTransientSpeakerForProfile(profileId) {
    for (const [speakerId, candidateProfileId] of this.transientProfileIds.entries()) {
      if (candidateProfileId === profileId) {
        return speakerId;
      }
    }

    return null;
  }

  _assignSpeakerId(embedding) {
    const speakerId = `speaker_${this.nextLiveIndex}`;
    this.nextLiveIndex += 1;
    this.transientEmbeddings.set(speakerId, cloneFloat32Array(embedding));
    this.transientCounts.set(speakerId, 1);
    return speakerId;
  }

  _updateCentroid(speakerId, embedding) {
    const centroid = this.transientEmbeddings.get(speakerId);
    if (!centroid) {
      return;
    }

    const count = this.transientCounts.get(speakerId) || 1;
    const nextCentroid = new Float32Array(embedding.length);

    for (let i = 0; i < embedding.length; i += 1) {
      nextCentroid[i] = (centroid[i] * count + embedding[i]) / (count + 1);
    }

    this.transientEmbeddings.set(speakerId, nextCentroid);
    this.transientCounts.set(speakerId, count + 1);
  }
}

const instance = new LiveSpeakerIdentifier();
module.exports = instance;
module.exports.LiveSpeakerIdentifier = LiveSpeakerIdentifier;
