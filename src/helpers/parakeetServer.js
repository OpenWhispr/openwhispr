const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  getFFmpegPath,
  isWavFormat,
  parseWavFormat,
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
const OrukeetNative = require("./orukeetNative");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // float32
const MAX_SEGMENT_SECONDS = 15;
// Cohere Transcribe accepts clips up to ~35s; longer segments mean fewer
// mid-word cuts at chunk boundaries.
const COHERE_MAX_SEGMENT_SECONDS = 30;
const ORUKEET_MAX_SEGMENT_SECONDS = 30;
const ORUKEET_MIN_SEGMENT_SECONDS = 24;
// Cache-aware streaming models take arbitrarily long audio in one stream; the
// bound only caps memory when transcribing very long files.
const ONLINE_MAX_SEGMENT_SECONDS = 600;
const SILENCE_RMS_THRESHOLD = 0.001;

// Match Orukeet's file decoder: cut at the quietest 100 ms in seconds 24–30.
// Fixed cuts through speech can drop words. Every sample still belongs to one
// window, and no window exceeds the native worker's 30-second limit.
function orukeetSegmentEnd(samples, offset) {
  const bytesPerSecond = SAMPLE_RATE * BYTES_PER_SAMPLE;
  const limit = offset + ORUKEET_MAX_SEGMENT_SECONDS * bytesPerSecond;
  if (limit >= samples.length) return samples.length;
  const blockBytes = bytesPerSecond / 10;
  let quietestEnergy = Infinity;
  let end = limit;
  for (
    let start = offset + ORUKEET_MIN_SEGMENT_SECONDS * bytesPerSecond;
    start < limit;
    start += blockBytes
  ) {
    let energy = 0;
    for (let i = start; i < start + blockBytes; i += BYTES_PER_SAMPLE) {
      const value = samples.readFloatLE(i);
      energy += value * value;
    }
    if (energy < quietestEnergy) {
      quietestEnergy = energy;
      end = start + blockBytes;
    }
  }
  return end;
}

class ParakeetServerManager {
  constructor() {
    this.wsServer = new ParakeetWsServer();
    this.nativeServer = new OrukeetNative();
    this.transcriptionQueue = Promise.resolve();
    this.generation = 0;
    this.activeRuntime = null;
  }

  backend(runtime) {
    return runtime === "orukeet" ? this.nativeServer : this.wsServer;
  }

  getBinaryPath(runtime) {
    return this.backend(runtime).getWsBinaryPath(runtime);
  }

  isAvailable(runtime) {
    return this.backend(runtime).isAvailable(runtime);
  }

  hasAnyWsBinary() {
    return this.wsServer.hasAnyWsBinary() || this.nativeServer.isAvailable();
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
    if (isWavFormat(audioBuffer)) {
      const format = parseWavFormat(audioBuffer);
      if (
        format?.audioFormat === 1 &&
        format?.bitsPerSample === 16 &&
        format?.sampleRate === SAMPLE_RATE &&
        format?.channels === 1
      ) {
        return { wavBuffer: audioBuffer, filesToCleanup: [] };
      }
      debugLogger.debug("WAV input needs normalization", { format });
    }

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

  // Lease the loaded model for one bounded decode, so uploads yield to dictation.
  withBackend(modelName, modelDir, signal, generation, action, language) {
    const run = async () => {
      const check = () => {
        if (signal?.aborted || generation !== this.generation)
          throw createAbortError("Parakeet transcription cancelled");
      };
      check();
      const runtime = getModelRuntime(modelName);
      const backend = this.backend(runtime);
      if (this.activeRuntime && this.activeRuntime !== runtime)
        await this.backend(this.activeRuntime).stop();
      this.activeRuntime = runtime;
      const abort = () => {
        if (runtime === "orukeet") void backend.stop();
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        check();
        await backend.start(
          modelName,
          modelDir,
          runtime,
          resolveModelLanguage(modelName, language)
        );
        check();
        return await action(backend);
      } catch (error) {
        check();
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    };
    const next = this.transcriptionQueue.then(run);
    this.transcriptionQueue = next.catch(() => {});
    return next;
  }

  transcribe(audioBuffer, options = {}) {
    return this._transcribe(audioBuffer, { ...options, generation: this.generation });
  }

  async _transcribe(audioBuffer, options = {}) {
    // signal is optional. Native cancellation also interrupts the worker;
    // other runtimes stop scheduling after the in-flight segment finishes.
    const { modelName = "orukeet-v0.1.0-q8", language, signal } = options;
    const throwIfAborted = () => {
      if (signal?.aborted || options.generation !== this.generation)
        throw createAbortError("Parakeet transcription cancelled");
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
      const decode = (samples) =>
        this.withBackend(
          modelName,
          modelDir,
          signal,
          options.generation,
          (backend) => backend.transcribe(samples, SAMPLE_RATE, { signal }),
          language
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
          : runtime === "orukeet"
            ? ORUKEET_MAX_SEGMENT_SECONDS
            : getModelType(modelName) === "cohere-transcribe"
              ? COHERE_MAX_SEGMENT_SECONDS
              : MAX_SEGMENT_SECONDS;
      const maxSegmentBytes = maxSegmentSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE;

      if (samples.length <= maxSegmentBytes) {
        const result = await decode(samples);
        if (result.text?.trim()) return result;
        throwIfAborted();
        // The RMS gate above already established audible audio, so an empty
        // decode here loses the whole dictation — retry once before giving up.
        debugLogger.warn("Parakeet returned empty text for non-silent audio, retrying", {
          durationSeconds,
          rms,
          samplesBytes: samples.length,
        });
        const retry = await decode(samples);
        return { ...retry, elapsed: (result.elapsed || 0) + (retry.elapsed || 0) };
      }

      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        maxSegmentSeconds,
      });

      const texts = [];
      let totalElapsed = 0;
      let truncated = false;

      for (let offset = 0, segmentIndex = 0; offset < samples.length; segmentIndex++) {
        throwIfAborted();
        const end =
          runtime === "orukeet"
            ? orukeetSegmentEnd(samples, offset)
            : Math.min(offset + maxSegmentBytes, samples.length);
        const segment = samples.subarray(offset, end);
        let result = await decode(segment);
        totalElapsed += result.elapsed || 0;
        if (!result.text && computeFloat32RMS(segment) >= SILENCE_RMS_THRESHOLD) {
          throwIfAborted();
          // An empty decode of audible audio silently amputates the transcript
          // (#1435: dictation openings dropped); retry once before conceding.
          debugLogger.warn("Parakeet segment returned empty text, retrying", {
            segmentIndex,
            segmentDuration: segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE,
          });
          result = await decode(segment);
          totalElapsed += result.elapsed || 0;
          if (!result.text) {
            truncated = true;
            debugLogger.warn("Parakeet segment still empty after retry; transcript truncated", {
              segmentIndex,
            });
          }
        }
        // Latched after the retry so a discarded attempt's truncation dies with it.
        if (result.truncated) truncated = true;
        if (result.text) texts.push(result.text);
        offset = end;
      }

      const text = texts.join(" ");
      return truncated
        ? { text, elapsed: totalElapsed, truncated }
        : { text, elapsed: totalElapsed };
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
    if (!this.backend(runtime).isAvailable(runtime)) {
      return { success: false, reason: "parakeet WS server binary not found" };
    }

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      return await this.withBackend(
        modelName,
        modelDir,
        null,
        this.generation,
        async (backend) => ({ success: true, port: backend.port || null }),
        language
      );
    } catch (error) {
      debugLogger.error("Failed to start parakeet WS server", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async stopServer() {
    this.generation++;
    this.activeRuntime = null;
    await Promise.all([this.wsServer.stop(), this.nativeServer.stop()]);
  }

  getServerStatus() {
    return this.backend(this.activeRuntime).getStatus();
  }

  createOnlineStream(options) {
    return this.wsServer.createOnlineStream(options);
  }
}

module.exports = ParakeetServerManager;
