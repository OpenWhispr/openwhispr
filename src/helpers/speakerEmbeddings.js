const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const onnxWorkerClient = require("./onnxWorkerClient");

const SAMPLE_RATE = 16000;
const EMBEDDING_DIM = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE * MIN_SEGMENT_SECONDS;
const MAX_EMBEDDING_SECONDS = 8;
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const BYTES_PER_SAMPLE = 2;
// Same as the meeting path's per-speaker centroids.
const CENTROID_SEGMENTS_PER_CLUSTER = 3;
// Enough for the RIFF, fmt and metadata chunks ffmpeg writes before "data".
const WAV_HEADER_READ_BYTES = 64 * 1024;
const MODEL_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
// Live meetings extract during remote speech, so this normally fires once a meeting and its
// post-meeting diarization are done (a longer silence mid-meeting costs one reload). The
// unload lets the idle ONNX worker exit.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

class SpeakerEmbeddings {
  constructor() {
    this.loadPromise = null;
    this.loadedGeneration = null;
    this.operationQueue = Promise.resolve();
    this.idleTimer = null;
  }

  getModelPath() {
    if (process.resourcesPath) {
      const bundledPath = path.join(process.resourcesPath, "bin", "diarization-models", MODEL_FILE);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(getModelsDirForService("diarization"), MODEL_FILE);
  }

  isAvailable() {
    return fs.existsSync(this.getModelPath());
  }

  _ensureLoaded() {
    if (this.loadPromise && this.loadedGeneration === onnxWorkerClient.generation) {
      return this.loadPromise;
    }
    if (!this.isAvailable()) {
      return Promise.reject(
        new Error(`Speaker embedding model not found at ${this.getModelPath()}`)
      );
    }
    const modelPath = this.getModelPath();
    debugLogger.debug("speaker-embeddings loading model", { modelPath });
    this.loadedGeneration = onnxWorkerClient.generation;
    this.loadPromise = onnxWorkerClient
      .request("speaker.load", { modelPath })
      .then(() => debugLogger.debug("speaker-embeddings model loaded"))
      .catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    return this.loadPromise;
  }

  _enqueue(operation) {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  _clearIdleTimer() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _armIdleTimer() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.unload().catch((err) =>
        debugLogger.warn("speaker-embeddings idle unload failed", { error: err?.message })
      );
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  _extractEmbeddingFromSamples(samples) {
    // A timer armed by an earlier extract must not queue an unload behind this one.
    this._clearIdleTimer();
    return this._enqueue(async () => {
      try {
        await this._ensureLoaded();

        const samplesBuffer = samples.buffer.slice(
          samples.byteOffset,
          samples.byteOffset + samples.byteLength
        );

        // No transfer-list: MessagePortMain can't transfer ArrayBuffers, so the samples are cloned.
        const { embeddingBuffer } = await onnxWorkerClient.request("speaker.extract", {
          samplesBuffer,
        });

        if (!embeddingBuffer) return null;
        return new Float32Array(embeddingBuffer);
      } finally {
        this._armIdleTimer();
      }
    });
  }

  unload() {
    return this._enqueue(async () => {
      try {
        await onnxWorkerClient.request("speaker.unload", {});
      } finally {
        this.loadPromise = null;
        this.loadedGeneration = null;
        await onnxWorkerClient.releaseIfIdle();
      }
    });
  }

  async extractEmbeddingFromSamples(samples) {
    if (samples.length < MIN_SEGMENT_SAMPLES) return null;
    const capped =
      samples.length > MAX_EMBEDDING_SAMPLES
        ? samples.subarray(samples.length - MAX_EMBEDDING_SAMPLES)
        : samples;
    return this._extractEmbeddingFromSamples(capped);
  }

  async extractEmbedding(wavPath, startSec, endSec) {
    if (endSec - startSec < MIN_SEGMENT_SECONDS) return null;

    const buf = fs.readFileSync(wavPath);
    const { byteOffset, numSamples } = this._embeddingWindow(
      this._parseWavHeader(buf),
      startSec,
      endSec
    );
    return this._extractEmbeddingFromSamples(this._decodePcm16(buf, byteOffset, numSamples));
  }

  // One voice per diarized cluster, from its longest segments. Reads only the
  // audio each embedding uses: an upload's WAV runs about 115 MB an hour. A
  // cluster whose extraction fails goes without a voice; the others keep theirs.
  async extractClusterCentroids(wavPath, segments, { signal = null } = {}) {
    const bySpeaker = new Map();
    for (const segment of segments) {
      if (segment.end - segment.start < MIN_SEGMENT_SECONDS) continue;
      if (!bySpeaker.has(segment.speaker)) bySpeaker.set(segment.speaker, []);
      bySpeaker.get(segment.speaker).push(segment);
    }

    const centroids = new Map();
    const fd = fs.openSync(wavPath, "r");
    try {
      const header = this._parseWavHeader(this._readBytes(fd, 0, WAV_HEADER_READ_BYTES));
      for (const [speaker, speakerSegments] of bySpeaker) {
        if (signal?.aborted) break;
        const longest = speakerSegments
          .sort((a, b) => b.end - b.start - (a.end - a.start))
          .slice(0, CENTROID_SEGMENTS_PER_CLUSTER);
        try {
          const embeddings = [];
          for (const segment of longest) {
            const { byteOffset, numSamples } = this._embeddingWindow(
              header,
              segment.start,
              segment.end
            );
            const pcm = this._readBytes(fd, byteOffset, numSamples * BYTES_PER_SAMPLE);
            const embedding = await this._extractEmbeddingFromSamples(
              this._decodePcm16(pcm, 0, numSamples)
            );
            if (embedding) embeddings.push(embedding);
          }
          if (embeddings.length > 0) centroids.set(speaker, this.computeCentroid(embeddings));
        } catch (error) {
          debugLogger.warn("speaker-embeddings cluster voice unavailable", {
            speaker,
            error: error.message,
          });
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return centroids;
  }

  _readBytes(fd, position, length) {
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  }

  // The last MAX_EMBEDDING_SECONDS of the segment, as a byte offset into the WAV.
  _embeddingWindow({ sampleRate, dataOffset }, startSec, endSec) {
    const cappedSeconds = Math.min(endSec - startSec, MAX_EMBEDDING_SECONDS);
    const startSample = Math.floor((endSec - cappedSeconds) * sampleRate);
    const numSamples = Math.floor(endSec * sampleRate) - startSample;
    return { byteOffset: dataOffset + startSample * BYTES_PER_SAMPLE, numSamples };
  }

  // Samples past the end of buf stay silent.
  _decodePcm16(buf, offset, numSamples) {
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const bytePos = offset + i * BYTES_PER_SAMPLE;
      if (bytePos + 1 >= buf.length) break;
      samples[i] = buf.readInt16LE(bytePos) / 32768;
    }
    return samples;
  }

  _parseWavHeader(buf) {
    let offset = 12;
    let sampleRate = 16000;
    let dataOffset = 44;

    while (offset < buf.length - 8) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);

      if (chunkId === "fmt ") {
        sampleRate = buf.readUInt32LE(offset + 12);
      } else if (chunkId === "data") {
        dataOffset = offset + 8;
        break;
      }

      offset += 8 + chunkSize;
    }

    return { sampleRate, dataOffset };
  }

  computeCentroid(embeddings) {
    if (embeddings.length === 0) return new Float32Array(EMBEDDING_DIM);

    const centroid = new Float32Array(EMBEDDING_DIM);
    for (const emb of embeddings) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        centroid[i] += emb[i];
      }
    }
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      centroid[i] /= embeddings.length;
    }
    return centroid;
  }

  cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

const instance = new SpeakerEmbeddings();
module.exports = instance;
module.exports.SpeakerEmbeddings = SpeakerEmbeddings;
module.exports.MAX_EMBEDDING_SECONDS = MAX_EMBEDDING_SECONDS;
