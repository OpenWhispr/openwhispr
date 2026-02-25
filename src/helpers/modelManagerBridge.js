const path = require("path");
const fs = require("fs");
const { promises: fsPromises } = require("fs");
const { app } = require("electron");
const {
  downloadFile: sharedDownloadFile,
  createDownloadSignal,
  cleanupStaleDownloads,
  checkDiskSpace,
} = require("./downloadUtils");

const modelRegistryData = require("../models/modelRegistryData.json");
const LlamaServerManager = require("./llamaServer");
const debugLogger = require("./debugLogger");

const MIN_FILE_SIZE = 1_000_000; // 1MB minimum for valid model files

function getLocalProviders() {
  return modelRegistryData.localProviders || [];
}

class ModelError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.details = details;
  }
}

class ModelNotFoundError extends ModelError {
  constructor(modelId) {
    super(`Model ${modelId} not found`, "MODEL_NOT_FOUND", { modelId });
  }
}

class ModelManager {
  constructor() {
    this.modelsDir = null;
    this.downloadProgress = new Map();
    this.activeDownloads = new Map();
    this.activeRequests = new Map(); // Track HTTP requests for cancellation
    this.serverManager = new LlamaServerManager();
    this.currentServerModelId = null;
    this._initialized = false;

    // IMPORTANT: Do NOT call app.getPath() here!
    // It can hang or fail before app.whenReady() in Electron 36+.
    // Initialization will happen on first use via ensureInitialized().
  }

  /**
   * Ensures the manager is initialized. Safe to call multiple times.
   * This must be called before any operation that requires modelsDir.
   */
  ensureInitialized() {
    if (this._initialized) return;

    // Check if app is ready before accessing app.getPath()
    if (!app.isReady()) {
      throw new Error(
        "ModelManager cannot be initialized before app.whenReady(). " +
          "This is a programming error - ensure ModelManager methods are only called after app is ready."
      );
    }

    this.modelsDir = this.getModelsDir();
    this._initialized = true;
    // Don't await - let this run in background
    this.ensureModelsDirExists();
    cleanupStaleDownloads(this.modelsDir);
  }

  getModelsDir() {
    const os = require("os");
    // Use os.homedir() as fallback if app.getPath fails
    const homeDir = app.isReady() ? app.getPath("home") : os.homedir();
    return path.join(homeDir, ".cache", "openwhispr", "models");
  }

  async ensureModelsDirExists() {
    try {
      if (!this.modelsDir) {
        this.ensureInitialized();
      }
      await fsPromises.mkdir(this.modelsDir, { recursive: true });
    } catch (error) {
      console.error("Failed to create models directory:", error);
    }
  }

  async ensureLlamaCpp() {
    if (!this.serverManager.isAvailable()) {
      throw new ModelError(
        "llama-server binary not found. Please ensure the app is installed correctly.",
        "LLAMASERVER_NOT_FOUND"
      );
    }
    return true;
  }

  async getAllModels() {
    this.ensureInitialized();
    try {
      const models = [];

      for (const provider of getLocalProviders()) {
        for (const model of provider.models) {
          const modelPath = path.join(this.modelsDir, model.fileName);
          const isDownloaded = await this.checkModelValid(modelPath);

          models.push({
            ...model,
            providerId: provider.id,
            providerName: provider.name,
            isDownloaded,
            path: isDownloaded ? modelPath : null,
          });
        }
      }

      return models;
    } catch (error) {
      console.error("[ModelManager] Error getting all models:", error);
      throw error;
    }
  }

  async getModelsWithStatus() {
    return this.getAllModels();
  }

  async isModelDownloaded(modelId) {
    this.ensureInitialized();
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) return false;

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    return this.checkModelValid(modelPath);
  }

  async checkFileExists(filePath) {
    try {
      await fsPromises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async checkModelValid(filePath) {
    try {
      const stats = await fsPromises.stat(filePath);
      return stats.size > MIN_FILE_SIZE;
    } catch {
      return false;
    }
  }

  findModelById(modelId) {
    for (const provider of getLocalProviders()) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) {
        return { model, provider };
      }
    }
    return null;
  }

  async downloadModel(modelId, onProgress) {
    this.ensureInitialized();
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const { model, provider } = modelInfo;
    const modelPath = path.join(this.modelsDir, model.fileName);

    if (await this.checkModelValid(modelPath)) {
      return modelPath;
    }

    if (this.activeDownloads.get(modelId)) {
      throw new ModelError("Model is already being downloaded", "DOWNLOAD_IN_PROGRESS", {
        modelId,
      });
    }

    this.activeDownloads.set(modelId, true);
    const { signal, abort } = createDownloadSignal();
    this.activeRequests.set(modelId, { abort });

    try {
      await this.ensureModelsDirExists();

      const requiredBytes = model.sizeBytes || model.sizeMb * 1_000_000 || 0;
      if (requiredBytes > 0) {
        const spaceCheck = await checkDiskSpace(this.modelsDir, requiredBytes * 1.2);
        if (!spaceCheck.ok) {
          throw new ModelError(
            `Not enough disk space. Need ~${Math.round((requiredBytes * 1.2) / 1_000_000)}MB, ` +
              `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`,
            "INSUFFICIENT_DISK_SPACE",
            { required: requiredBytes, available: spaceCheck.availableBytes }
          );
        }
      }

      const downloadUrl = this.getDownloadUrl(provider, model);

      await sharedDownloadFile(downloadUrl, modelPath, {
        signal,
        onProgress: (downloadedBytes, totalBytes) => {
          const progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
          this.downloadProgress.set(modelId, {
            modelId,
            progress,
            downloadedSize: downloadedBytes,
            totalSize: totalBytes,
          });
          if (onProgress) {
            onProgress(progress, downloadedBytes, totalBytes);
          }
        },
      });

      const stats = await fsPromises.stat(modelPath);
      if (stats.size < MIN_FILE_SIZE) {
        await fsPromises.unlink(modelPath).catch(() => {});
        throw new ModelError(
          "Downloaded file appears to be corrupted or incomplete",
          "DOWNLOAD_CORRUPTED",
          { size: stats.size, minSize: MIN_FILE_SIZE }
        );
      }

      return modelPath;
    } catch (error) {
      if (error.isAbort) {
        throw new ModelError("Download cancelled by user", "DOWNLOAD_CANCELLED", { modelId });
      }
      if (error.isHttpError) {
        throw new ModelError(`Download failed with status ${error.statusCode}`, "DOWNLOAD_FAILED", {
          statusCode: error.statusCode,
        });
      }
      if (!(error instanceof ModelError)) {
        throw new ModelError(`Network error: ${error.message}`, "NETWORK_ERROR", {
          error: error.message,
        });
      }
      throw error;
    } finally {
      this.activeDownloads.delete(modelId);
      this.activeRequests.delete(modelId);
      this.downloadProgress.delete(modelId);
    }
  }

  getDownloadUrl(provider, model) {
    const baseUrl = provider.baseUrl || "https://huggingface.co";
    return `${baseUrl}/${model.hfRepo}/resolve/main/${model.fileName}`;
  }

  cancelDownload(modelId) {
    const entry = this.activeRequests.get(modelId);
    if (entry) {
      this.activeDownloads.delete(modelId);
      this.activeRequests.delete(modelId);
      this.downloadProgress.delete(modelId);
      entry.abort();
      return true;
    }
    return false;
  }

  async deleteModel(modelId) {
    this.ensureInitialized();
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);

    if (await this.checkFileExists(modelPath)) {
      await fsPromises.unlink(modelPath);
    }
  }

  async deleteAllModels() {
    this.ensureInitialized();
    try {
      if (fsPromises.rm) {
        await fsPromises.rm(this.modelsDir, { recursive: true, force: true });
      } else {
        const entries = await fsPromises
          .readdir(this.modelsDir, { withFileTypes: true })
          .catch(() => []);
        for (const entry of entries) {
          const fullPath = path.join(this.modelsDir, entry.name);
          if (entry.isDirectory()) {
            await fsPromises.rmdir(fullPath, { recursive: true }).catch(() => {});
          } else {
            await fsPromises.unlink(fullPath).catch(() => {});
          }
        }
      }
    } catch (error) {
      throw new ModelError(
        `Failed to delete models directory: ${error.message}`,
        "DELETE_ALL_ERROR",
        { error: error.message }
      );
    } finally {
      await this.ensureModelsDirExists();
    }
  }

  async runInference(modelId, prompt, options = {}) {
    this.ensureInitialized();
    const startTime = Date.now();
    debugLogger.logReasoning("INFERENCE_START", {
      modelId,
      promptLength: prompt.length,
      options: { ...options, systemPrompt: options.systemPrompt ? "[set]" : "[not set]" },
    });

    // Ensure server is available
    if (!this.serverManager.isAvailable()) {
      debugLogger.logReasoning("INFERENCE_SERVER_NOT_AVAILABLE", {});
      throw new ModelError(
        "llama-server binary not found. Please ensure the app is installed correctly.",
        "LLAMASERVER_NOT_FOUND"
      );
    }

    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      debugLogger.logReasoning("INFERENCE_MODEL_NOT_FOUND", { modelId });
      throw new ModelNotFoundError(modelId);
    }

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    debugLogger.logReasoning("INFERENCE_MODEL_PATH", {
      modelPath,
      modelName: modelInfo.model.name,
      providerId: modelInfo.provider.id,
    });

    if (!(await this.checkModelValid(modelPath))) {
      debugLogger.logReasoning("INFERENCE_MODEL_INVALID", { modelId, modelPath });
      throw new ModelError(
        `Model ${modelId} is not downloaded or is corrupted`,
        "MODEL_NOT_DOWNLOADED",
        { modelId }
      );
    }

    // Start/restart server if needed or if model changed
    if (!this.serverManager.ready || this.currentServerModelId !== modelId) {
      debugLogger.logReasoning("INFERENCE_STARTING_SERVER", {
        currentModel: this.currentServerModelId,
        requestedModel: modelId,
        serverReady: this.serverManager.ready,
      });

      await this.serverManager.start(modelPath, {
        contextSize: options.contextSize || modelInfo.model.contextLength || 4096,
        threads: options.threads || 4,
        gpuLayers: 99,
      });
      this.currentServerModelId = modelId;

      debugLogger.logReasoning("INFERENCE_SERVER_STARTED", {
        port: this.serverManager.port,
        model: modelId,
      });
    }

    // Build messages for chat completion
    const messages = [
      { role: "system", content: options.systemPrompt || "" },
      { role: "user", content: prompt },
    ];

    debugLogger.logReasoning("INFERENCE_SENDING_REQUEST", {
      messageCount: messages.length,
      systemPromptLength: (options.systemPrompt || "").length,
      userPromptLength: prompt.length,
    });

    try {
      const result = await this.serverManager.inference(messages, {
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 512,
      });

      const totalTime = Date.now() - startTime;
      debugLogger.logReasoning("INFERENCE_SUCCESS", {
        totalTimeMs: totalTime,
        resultLength: result.length,
        resultPreview: result.substring(0, 200) + (result.length > 200 ? "..." : ""),
      });

      return result;
    } catch (error) {
      const totalTime = Date.now() - startTime;
      debugLogger.logReasoning("INFERENCE_FAILED", {
        totalTimeMs: totalTime,
        error: error.message,
      });
      throw new ModelError(`Inference failed: ${error.message}`, "INFERENCE_FAILED", {
        error: error.message,
      });
    }
  }

  async stopServer() {
    await this.serverManager.stop();
    this.currentServerModelId = null;
  }

  getServerStatus() {
    return this.serverManager.getStatus();
  }

  async prewarmServer(modelId) {
    if (!modelId) return false;
    this.ensureInitialized();

    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) return false;

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    if (!(await this.checkModelValid(modelPath))) return false;

    if (!this.serverManager.isAvailable()) return false;

    try {
      await this.serverManager.start(modelPath, {
        contextSize: modelInfo.model.contextLength || 4096,
        threads: 4,
        gpuLayers: 99,
      });
      this.currentServerModelId = modelId;
      debugLogger.info("llama-server pre-warmed", { modelId });
      return true;
    } catch (error) {
      debugLogger.warn("Failed to pre-warm llama-server", { error: error.message });
      return false;
    }
  }
}

module.exports = {
  default: new ModelManager(),
  ModelError,
  ModelNotFoundError,
};
