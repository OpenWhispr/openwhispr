const { runLocalModelOperation, localModelOperationSignal } = require("./localModelPolicyGate");
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
const { splitAtPauses } = require("./parakeetSegmentation");
const {
  getModelRuntime,
  getModelType,
  getRequiredModelFiles,
  resolveModelLanguage,
} = require("./parakeetModelInfo");
const { getSherpaHotwordsScore, buildSherpaHotwords } = require("../utils/sherpaHotwords.js");

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
// Dictionary edits arrive in bursts (imports, auto-learn), and each reload
// costs a model load, so a running server waits for them to settle.
const HOTWORDS_REFRESH_DELAY_MS = 2000;

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
    this.dictionaryProvider = () => [];
    this.hotwordsRefreshTimer = null;
  }

  // provider returns the dictionary, highest priority first.
  setDictionaryProvider(provider) {
    this.dictionaryProvider = provider;
  }

  _hotwordsFor(modelName) {
    const score = getSherpaHotwordsScore(modelName);
    if (score === null) return null;
    const words = buildSherpaHotwords(this.dictionaryProvider());
    return words.length > 0 ? { score, words } : null;
  }

  // Reloads a running server with the current dictionary in the background, so
  // the next dictation does not wait for the model to load.
  refreshHotwordsSoon() {
    clearTimeout(this.hotwordsRefreshTimer);
    this.hotwordsRefreshTimer = setTimeout(() => {
      this.hotwordsRefreshTimer = null;
      // Busy servers keep their words until idle; trying again later spares the
      // next dictation the reload.
      if (
        this.wsServer.startupPromise ||
        this.wsServer.activeDecodes > 0 ||
        this.wsServer.activeTranscriptions.size > 0
      ) {
        this.refreshHotwordsSoon();
        return;
      }
      const { ready, modelName, modelDir, modelRuntime, language } = this.wsServer;
      if (!ready || getSherpaHotwordsScore(modelName) === null) return;
      const stopSignal = this.wsServer.stopSignal;
      this.wsServer
        .start(modelName, modelDir, modelRuntime, language, this._hotwordsFor(modelName))
        .then((reloaded) => {
          // A dictation may have arrived while the reload waited for policy.
          if (reloaded === false && !stopSignal.aborted) this.refreshHotwordsSoon();
        })
        .catch((error) => {
          if (stopSignal.aborted) return;
          debugLogger.warn("Failed to reload parakeet-ws with the new dictionary", {
            error: error.message,
          });
        });
    }, HOTWORDS_REFRESH_DELAY_MS);
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
    const stopSignal = this.wsServer.stopSignal;
    const signal = options.signal ? AbortSignal.any([options.signal, stopSignal]) : stopSignal;
    return runLocalModelOperation(
      this,
      "transcription",
      options.modelName ?? "",
      () =>
        this._policyAllowedTranscribe(audioBuffer, {
          ...options,
          signal: localModelOperationSignal(this, signal),
        }),
      { onAbort: () => !stopSignal.aborted && this.stopServer() }
    );
  }

  async _policyAllowedTranscribe(audioBuffer, options = {}) {
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

    const releaseTranscription = this.wsServer.reserveTranscription();
    let filesToCleanup = [];
    try {
      const wav = await this._ensureWav(audioBuffer);
      const { wavBuffer } = wav;
      filesToCleanup = wav.filesToCleanup;
      throwIfAborted();
      const runtime = getModelRuntime(modelName);
      // Awaiting unconditionally also covers a startup's warm-up completion.
      await this.wsServer.start(
        modelName,
        modelDir,
        runtime,
        resolveModelLanguage(modelName, language),
        this._hotwordsFor(modelName),
        { transcription: releaseTranscription }
      );
      throwIfAborted();

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
      const segments = splitAtPauses(samples, { sampleRate: SAMPLE_RATE, maxSegmentSeconds });

      if (segments.length === 1) {
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

      const shortestSegmentBytes = Math.min(...segments.map((segment) => segment.length));
      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        segmentCount: segments.length,
        shortestSegmentSeconds: shortestSegmentBytes / BYTES_PER_SAMPLE / SAMPLE_RATE,
      });

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
      releaseTranscription();
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
        resolveModelLanguage(modelName, language),
        this._hotwordsFor(modelName)
      );
      return { success: true, port: this.wsServer.port };
    } catch (error) {
      debugLogger.error("Failed to start parakeet WS server", { error: error.message });
      return { success: false, reason: error.message, code: error.code };
    }
  }

  async stopServer() {
    clearTimeout(this.hotwordsRefreshTimer);
    this.hotwordsRefreshTimer = null;
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
