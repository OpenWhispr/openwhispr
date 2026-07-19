const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  getFFmpegPath,
  isWavFormat,
  isWhisperReadyWav,
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
const MAX_SEGMENT_BYTES = MAX_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
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
    // Fast path: renderer already produced a 16 kHz mono PCM WAV — no FFmpeg needed.
    if (isWhisperReadyWav(audioBuffer)) return { wavBuffer: audioBuffer, filesToCleanup: [] };
    // Generic WAV but wrong rate/channels — fall through to FFmpeg for resampling.
    if (isWavFormat(audioBuffer)) {
      // Re-run through FFmpeg to ensure 16 kHz mono.
    }

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "FFmpeg not found - required for audio conversion. Please ensure FFmpeg is installed."
      );
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const inputExt = isWavFormat(audioBuffer) ? "wav" : "webm";
    const tempInputPath = path.join(tempDir, `parakeet-input-${timestamp}.${inputExt}`);
    const tempWavPath = path.join(tempDir, `parakeet-${timestamp}.wav`);

    fs.writeFileSync(tempInputPath, audioBuffer);

    const inputStats = fs.statSync(tempInputPath);
    debugLogger.debug("Converting audio to WAV", { inputSize: inputStats.size });

    await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1 });

    const wavBuffer = fs.readFileSync(tempWavPath);
    return { wavBuffer, filesToCleanup: [tempInputPath, tempWavPath] };
  }

  async _ensureServerStarted(modelName) {
    if (!this.isModelDownloaded(modelName)) {
      throw new Error(`Parakeet model "${modelName}" not downloaded`);
    }
    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.wsServer.ready || this.wsServer.modelName !== modelName) {
      await this.wsServer.start(modelName, modelDir, getModelRuntime(modelName));
    }
  }

  // Transcribes a single pre-extracted float32 PCM segment (16 kHz mono),
  // splitting further if it exceeds MAX_SEGMENT_BYTES. Shared by whole-file
  // transcription and by per-speaker-turn transcription during diarization.
  async transcribeSamples(samples, options = {}) {
    const { modelName = "parakeet-tdt-0.6b-v3" } = options;
    await this._ensureServerStarted(modelName);

    const rms = computeFloat32RMS(samples);
    if (rms < SILENCE_RMS_THRESHOLD) {
      return { text: "", elapsed: 0 };
    }

    if (samples.length <= MAX_SEGMENT_BYTES) {
      return this.wsServer.transcribe(samples, SAMPLE_RATE);
    }

    const texts = [];
    let totalElapsed = 0;

    for (let offset = 0; offset < samples.length; offset += MAX_SEGMENT_BYTES) {
      const end = Math.min(offset + MAX_SEGMENT_BYTES, samples.length);
      const segment = samples.subarray(offset, end);
      const result = await this.wsServer.transcribe(segment, SAMPLE_RATE);
      totalElapsed += result.elapsed || 0;
      if (result.text) {
        texts.push(result.text);
      } else {
        debugLogger.warn("Parakeet segment returned empty text", {
          segmentIndex: offset / MAX_SEGMENT_BYTES,
          segmentDuration: segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE,
        });
      }
    }

    return { text: texts.join(" "), elapsed: totalElapsed };
  }

  // Converts audioBuffer to float32 PCM samples for transcription and guarantees
  // a WAV file on disk (writing one if the fast WAV path skipped conversion), so
  // callers that need a file path (e.g. diarization) always have one.
  async prepareAudioForDiarization(audioBuffer) {
    const { wavBuffer, filesToCleanup } = await this._ensureWav(audioBuffer);
    let wavPath = filesToCleanup.find((p) => p.toLowerCase().endsWith(".wav"));
    if (!wavPath) {
      wavPath = path.join(getSafeTempDir(), `parakeet-diarize-${Date.now()}.wav`);
      fs.writeFileSync(wavPath, wavBuffer);
      filesToCleanup.push(wavPath);
    }
    const samples = wavToFloat32Samples(wavBuffer);
    return { samples, wavPath, filesToCleanup };
  }

  async transcribe(audioBuffer, options = {}) {
    const { modelName = "parakeet-tdt-0.6b-v3" } = options;

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
      const samples = wavToFloat32Samples(wavBuffer);
      const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Parakeet audio analysis", { durationSeconds, rms });

      if (samples.length > MAX_SEGMENT_BYTES) {
        debugLogger.debug("Parakeet segmenting long audio", {
          durationSeconds,
          segmentCount: Math.ceil(samples.length / MAX_SEGMENT_BYTES),
        });
      }

      const result = await this.transcribeSamples(samples, { modelName });
      if (!result.text?.trim() && rms >= SILENCE_RMS_THRESHOLD) {
        debugLogger.warn("Parakeet returned empty text for non-silent audio", {
          durationSeconds,
          rms,
          samplesBytes: samples.length,
        });
      }
      return result;
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

  createOnlineStream(options) {
    return this.wsServer.createOnlineStream(options);
  }

  async stopServer() {
    await this.wsServer.stop();
  }

  getServerStatus() {
    return this.wsServer.getStatus();
  }
}

module.exports = ParakeetServerManager;
