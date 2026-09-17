const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  getFFmpegPath,
  isWavFormat,
  parseWavFormat,
  isPcm16Mono16kWav,
  convertToWav,
  wavToFloat32Samples,
  computeFloat32RMS,
} = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { createAbortError } = require("./abortError");
const ParakeetWsServer = require("./parakeetWsServer");
const {
  getModelRuntime,
  getModelType,
  getRequiredModelFiles,
  resolveModelLanguage,
} = require("./parakeetModelInfo");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // float32
const MAX_SEGMENT_SECONDS = 15;
// Cohere Transcribe accepts clips up to ~35s; longer segments mean fewer
// mid-word cuts at chunk boundaries.
const COHERE_MAX_SEGMENT_SECONDS = 30;
// Cache-aware streaming models take arbitrarily long audio in one stream; the
// bound only caps memory when transcribing very long files.
const ONLINE_MAX_SEGMENT_SECONDS = 600;
const SILENCE_RMS_THRESHOLD = 0.001;

// Runs fn over items with at most `limit` in flight; results keep item order.
// Once one item rejects, no further items are started.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index).catch((error) => {
        failed = true;
        throw error;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

class ParakeetServerManager {
  constructor() {
    this.wsServer = new ParakeetWsServer();
  }

  getBinaryPath(runtime) {
    return this.wsServer.getWsBinaryPath(runtime);
  }

  isAvailable(runtime) {
    return this.wsServer.isAvailable(runtime);
  }

  hasAnyWsBinary() {
    return this.wsServer.hasAnyWsBinary();
  }

  getModelsDir() {
    return getModelsDirForService("parakeet");
  }

  isModelDownloaded(modelName) {
    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!fs.existsSync(modelDir)) return false;

    return getRequiredModelFiles(modelName).every((file) =>
      fs.existsSync(path.join(modelDir, file))
    );
  }

  async _ensureWav(audioBuffer) {
    if (isPcm16Mono16kWav(audioBuffer)) return { wavBuffer: audioBuffer, filesToCleanup: [] };
    const format = parseWavFormat(audioBuffer);
    if (format) debugLogger.debug("WAV input needs normalization", { format });

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "FFmpeg not found - required for audio conversion. Please ensure FFmpeg is installed."
      );
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `parakeet-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `parakeet-${timestamp}.wav`);

    fs.writeFileSync(tempInputPath, audioBuffer);

    const inputStats = fs.statSync(tempInputPath);
    debugLogger.debug("Converting audio to WAV", { inputSize: inputStats.size });

    await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1 });

    const wavBuffer = fs.readFileSync(tempWavPath);
    return { wavBuffer, filesToCleanup: [tempInputPath, tempWavPath] };
  }

  async transcribe(audioBuffer, options = {}) {
    // signal is optional; only cancellable uploads pass one. Aborting stops
    // scheduling further segments — the in-flight one finishes server-side.
    const { modelName = "parakeet-tdt-0.6b-v3", language, signal } = options;
    const throwIfAborted = () => {
      if (signal?.aborted) throw createAbortError("Parakeet transcription cancelled");
    };

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      throw new Error(`Parakeet model "${modelName}" not downloaded`);
    }

    debugLogger.debug("Parakeet transcription request", {
      modelName,
      audioSize: audioBuffer?.length || 0,
      isWavFormat: isWavFormat(audioBuffer),
    });

    // An already-cancelled upload skips the ffmpeg conversion entirely.
    throwIfAborted();

    const { wavBuffer, filesToCleanup } = await this._ensureWav(audioBuffer);
    try {
      throwIfAborted();
      const runtime = getModelRuntime(modelName);
      // Awaiting unconditionally also covers a startup's warm-up completion.
      await this.wsServer.start(
        modelName,
        modelDir,
        runtime,
        resolveModelLanguage(modelName, language)
      );

      const samples = wavToFloat32Samples(wavBuffer);
      const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;

      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Parakeet audio analysis", { durationSeconds, rms });
      if (rms < SILENCE_RMS_THRESHOLD) {
        return { text: "", elapsed: 0 };
      }

      const maxSegmentSeconds =
        runtime === "online"
          ? ONLINE_MAX_SEGMENT_SECONDS
          : getModelType(modelName) === "cohere-transcribe"
            ? COHERE_MAX_SEGMENT_SECONDS
            : MAX_SEGMENT_SECONDS;
      const maxSegmentBytes = maxSegmentSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE;

      if (samples.length <= maxSegmentBytes) {
        const result = await this.wsServer.transcribe(samples, SAMPLE_RATE, { signal });
        if (result.text?.trim()) return result;
        throwIfAborted();
        // The RMS gate above already established audible audio, so an empty
        // decode here loses the whole dictation — retry once before giving up.
        debugLogger.warn("Parakeet returned empty text for non-silent audio, retrying", {
          durationSeconds,
          rms,
          samplesBytes: samples.length,
        });
        const retry = await this.wsServer.transcribe(samples, SAMPLE_RATE, { signal });
        return { ...retry, elapsed: (result.elapsed || 0) + (retry.elapsed || 0) };
      }

      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        segmentCount: Math.ceil(samples.length / maxSegmentBytes),
      });

      const segments = [];
      for (let offset = 0; offset < samples.length; offset += maxSegmentBytes) {
        segments.push(samples.subarray(offset, offset + maxSegmentBytes));
      }

      const decodeSegment = async (segment, segmentIndex) => {
        throwIfAborted();
        const first = await this.wsServer.transcribe(segment, SAMPLE_RATE, { signal });
        if (first.text || computeFloat32RMS(segment) < SILENCE_RMS_THRESHOLD) return first;
        throwIfAborted();
        // An empty decode of audible audio silently amputates the transcript
        // (#1435: dictation openings dropped); retry once before conceding.
        debugLogger.warn("Parakeet segment returned empty text, retrying", {
          segmentIndex,
          segmentDuration: segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE,
        });
        const retry = await this.wsServer.transcribe(segment, SAMPLE_RATE, { signal });
        if (!retry.text) {
          debugLogger.warn("Parakeet segment still empty after retry; transcript truncated", {
            segmentIndex,
          });
        }
        // Only the retry's truncation counts; the discarded attempt's dies with it.
        return {
          ...retry,
          elapsed: (first.elapsed || 0) + (retry.elapsed || 0),
          truncated: !!retry.truncated || !retry.text,
        };
      };

      // Segments are independent, so a minute of dictation decodes on the
      // server's work threads side by side instead of in four serial passes.
      const results = await mapWithConcurrency(
        segments,
        this.wsServer.maxConcurrentDecodes,
        decodeSegment
      );
      const text = results
        .map((result) => result.text)
        .filter(Boolean)
        .join(" ");
      const elapsed = results.reduce((sum, result) => sum + (result.elapsed || 0), 0);
      return results.some((result) => result.truncated)
        ? { text, elapsed, truncated: true }
        : { text, elapsed };
    } finally {
      this._cleanupFiles(filesToCleanup);
    }
  }

  _cleanupFiles(filePaths) {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        debugLogger.warn("Failed to cleanup temp audio file", {
          path: filePath,
          error: err.message,
        });
      }
    }
  }

  async startServer(modelName, language) {
    const runtime = getModelRuntime(modelName);
    if (!this.wsServer.isAvailable(runtime)) {
      return { success: false, reason: "parakeet WS server binary not found" };
    }

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.wsServer.start(
        modelName,
        modelDir,
        runtime,
        resolveModelLanguage(modelName, language)
      );
      return { success: true, port: this.wsServer.port };
    } catch (error) {
      debugLogger.error("Failed to start parakeet WS server", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async stopServer() {
    await this.wsServer.stop();
  }

  getServerStatus() {
    return this.wsServer.getStatus();
  }

  createOnlineStream(options) {
    return this.wsServer.createOnlineStream(options);
  }
}

module.exports = ParakeetServerManager;
