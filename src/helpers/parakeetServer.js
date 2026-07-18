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
const ParakeetWsServer = require("./parakeetWsServer");
const { getModelRuntime, REQUIRED_MODEL_FILES } = require("./parakeetModelInfo");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // float32
const MAX_SEGMENT_SECONDS = 15;
// Cache-aware streaming models take arbitrarily long audio in one stream; the
// bound only caps memory when transcribing very long files.
const ONLINE_MAX_SEGMENT_SECONDS = 600;
const SILENCE_RMS_THRESHOLD = 0.001;

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

    return REQUIRED_MODEL_FILES.every((file) => fs.existsSync(path.join(modelDir, file)));
  }

  async _ensureWav(audioBuffer) {
    if (isWavFormat(audioBuffer)) {
      const format = parseWavFormat(audioBuffer);
      if (format?.sampleRate === SAMPLE_RATE && format?.channels === 1) {
        return { wavBuffer: audioBuffer, filesToCleanup: [] };
      }
      debugLogger.debug("WAV input needs resampling", { format });
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

  async transcribe(audioBuffer, options = {}) {
    const { modelName = "parakeet-tdt-0.6b-v3" } = options;

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      throw new Error(`Parakeet model "${modelName}" not downloaded`);
    }

    debugLogger.debug("Parakeet transcription request", {
      modelName,
      audioSize: audioBuffer?.length || 0,
      isWavFormat: isWavFormat(audioBuffer),
    });

    const { wavBuffer, filesToCleanup } = await this._ensureWav(audioBuffer);
    try {
      const runtime = getModelRuntime(modelName);
      // Awaiting unconditionally also covers a startup's warm-up completion.
      await this.wsServer.start(modelName, modelDir, runtime);

      const samples = wavToFloat32Samples(wavBuffer);
      const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;

      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Parakeet audio analysis", { durationSeconds, rms });
      if (rms < SILENCE_RMS_THRESHOLD) {
        return { text: "", elapsed: 0 };
      }

      const maxSegmentSeconds =
        runtime === "online" ? ONLINE_MAX_SEGMENT_SECONDS : MAX_SEGMENT_SECONDS;
      const maxSegmentBytes = maxSegmentSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE;

      if (samples.length <= maxSegmentBytes) {
        const result = await this.wsServer.transcribe(samples, SAMPLE_RATE);
        if (!result.text?.trim()) {
          debugLogger.warn("Parakeet returned empty text for non-silent audio", {
            durationSeconds,
            rms,
            samplesBytes: samples.length,
          });
        }
        return result;
      }

      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        segmentCount: Math.ceil(samples.length / maxSegmentBytes),
      });

      const texts = [];
      let totalElapsed = 0;
      let truncated = false;

      for (let offset = 0; offset < samples.length; offset += maxSegmentBytes) {
        const end = Math.min(offset + maxSegmentBytes, samples.length);
        const segment = samples.subarray(offset, end);
        const result = await this.wsServer.transcribe(segment, SAMPLE_RATE);
        totalElapsed += result.elapsed || 0;
        if (result.truncated) truncated = true;
        if (result.text) {
          texts.push(result.text);
        } else {
          debugLogger.warn("Parakeet segment returned empty text", {
            segmentIndex: offset / maxSegmentBytes,
            segmentDuration: segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE,
          });
        }
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

  async startServer(modelName) {
    const runtime = getModelRuntime(modelName);
    if (!this.wsServer.isAvailable(runtime)) {
      return { success: false, reason: "parakeet WS server binary not found" };
    }

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.wsServer.start(modelName, modelDir, runtime);
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
