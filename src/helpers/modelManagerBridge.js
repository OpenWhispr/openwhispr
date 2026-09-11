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
const { readGgufMetadataFromFile } = require("./ggufMetadata");
const {
  estimateTokens,
  kvBytesPerToken,
  resolveContextCeiling,
  resolveContextSize,
  BASELINE_CONTEXT_SIZE,
} = require("./llamaContextPolicy");

const MIN_FILE_SIZE = 1_000_000; // 1MB minimum for valid model files

// The context every server still STARTS at. Requests that need more grow it
// on demand, bounded by a per-machine, per-model ceiling (llamaContextPolicy).
// Keeping the starting value at the historical constant means prewarm, chat
// and every short request behave exactly as they did before #2142.
const SERVER_CONTEXT_SIZE = BASELINE_CONTEXT_SIZE;

// Slack on top of the output reservation, for tokenizer drift and llama.cpp's
// own bookkeeping.
const CONTEXT_RESERVE_TOKENS = 512;

// Context a request must leave free for its own answer. Derived in one place
// so the size the window is chosen for and the size it is checked against can
// never drift apart.
const reserveFor = (maxTokens) => maxTokens + CONTEXT_RESERVE_TOKENS;

// Only measure the prompt exactly when the estimate lands within this factor
// of the running window. Below that the answer cannot change, and dictation
// should not pay two HTTP round trips to learn nothing.
const PREFLIGHT_MEASURE_FACTOR = 2;

// The smallest answer still worth generating when the prompt has crowded the
// window. Matches the historical floor of calculateMaxTokens, so a request
// that gets trimmed to this is no smaller than the smallest one the app has
// ever made. Below it, refusing beats handing back a sentence and a half.
const MIN_OUTPUT_TOKENS = 512;

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
    this.downloadReservations = new Map();
    this.activeRequests = new Map(); // Track HTTP requests for cancellation
    this.downloadLifecycleVersion = 0;
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
    const { getCacheRoot } = require("./modelDirUtils");
    return path.join(getCacheRoot(), "models");
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
      const modelEntries = [];

      for (const provider of getLocalProviders()) {
        for (const model of provider.models) {
          const modelPath = path.join(this.modelsDir, model.fileName);
          modelEntries.push({ model, provider, modelPath });
        }
      }

      let downloadedStates = [];

      // A download can finish between checking the final file and reading the
      // in-memory active state. Retry when that lifecycle changes so callers
      // never receive the impossible "not downloaded and not downloading" gap.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const lifecycleVersion = this.downloadLifecycleVersion;
        downloadedStates = await Promise.all(
          modelEntries.map(({ modelPath }) => this.checkModelValid(modelPath))
        );
        if (lifecycleVersion === this.downloadLifecycleVersion) break;
      }

      // Read volatile download state only after all asynchronous filesystem checks
      // finish so every model belongs to the same main-process snapshot.
      return modelEntries.map(({ model, provider, modelPath }, index) => {
        const progress = this.downloadProgress.get(model.id);
        const isDownloaded = downloadedStates[index];

        return {
          ...model,
          providerId: provider.id,
          providerName: provider.name,
          isDownloaded,
          isDownloading: this.activeDownloads.has(model.id),
          downloadProgress: progress?.progress || 0,
          downloadedSize: progress?.downloadedSize || 0,
          totalSize: progress?.totalSize || 0,
          path: isDownloaded ? modelPath : null,
        };
      });
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

  serverOptions(modelInfo) {
    return {
      contextSize: Math.min(
        SERVER_CONTEXT_SIZE,
        modelInfo.model.contextLength || SERVER_CONTEXT_SIZE
      ),
      threads: 4,
      gpuLayers: 99,
    };
  }

  async serverStartOptions(modelInfo, overrides = {}) {
    const options = { ...this.serverOptions(modelInfo), ...overrides };
    const draftPath = await this.resolveDraftPath(modelInfo.model);
    if (draftPath) options.draftModelPath = draftPath;
    return options;
  }

  // Seam so the ceiling can be exercised for any machine size in tests.
  _systemMemoryBytes() {
    return require("os").totalmem();
  }

  /**
   * The largest context this machine may give this model, and the prompt-cache
   * bound that goes with it. Memoized per model file: it reads a few MiB off
   * the front of the GGUF, so it must not sit on the hot path.
   */
  async contextCeiling(modelInfo, modelPath) {
    if (this._contextCeilingCache?.modelPath === modelPath) {
      return this._contextCeilingCache.value;
    }

    const metadata = await readGgufMetadataFromFile(modelPath);
    const sizeOf = async (filePath) => {
      if (!filePath) return 0;
      try {
        return (await fsPromises.stat(filePath)).size;
      } catch {
        return 0;
      }
    };

    const value = resolveContextCeiling({
      totalMemoryBytes: this._systemMemoryBytes(),
      weightsBytes: await sizeOf(modelPath),
      draftWeightsBytes: await sizeOf(await this.resolveDraftPath(modelInfo.model)),
      kvBytesPerToken: kvBytesPerToken(metadata),
      hasRecurrentState: metadata?.hasRecurrentState,
      // The GGUF is the file llama.cpp actually loads, so it outranks the
      // registry, which is wrong for at least the qwen2.5-7b entries.
      trainedContextTokens: metadata?.contextLength || modelInfo.model.contextLength || 0,
      // Anywhere but Apple Silicon the GPU may have its own memory that we do
      // not probe, so the system-RAM budget alone is not a safe bound. Stay
      // modest and let the GPU fallback ladder handle the rest. Intel Macs
      // count: a discrete Radeon has a few GB of its own, and the darwin start
      // path has no reduced-context rung to catch an over-sized window.
      discreteGpuUnverified: process.platform !== "darwin" || process.arch !== "arm64",
    });

    debugLogger.info("Resolved llama-server context ceiling", {
      model: modelInfo.model.id,
      architecture: metadata?.architecture ?? null,
      kvBytesPerToken: kvBytesPerToken(metadata),
      ...value,
    });

    this._contextCeilingCache = { modelPath, value };
    return value;
  }

  getReservedDownloadBytes() {
    let reserved = 0;
    for (const [modelId, bytes] of this.downloadReservations) {
      reserved += Math.max(0, bytes - (this.downloadProgress.get(modelId)?.downloadedSize || 0));
    }
    return reserved;
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

    if (this.activeDownloads.has(modelId)) {
      throw new ModelError("Model is already being downloaded", "DOWNLOAD_IN_PROGRESS", {
        modelId,
      });
    }

    this.activeDownloads.set(modelId, true);
    this.downloadLifecycleVersion += 1;
    const { signal, abort } = createDownloadSignal();
    this.activeRequests.set(modelId, { abort });

    try {
      await this.ensureModelsDirExists();

      const hasDrafter = this.modelHasDrafter(model);

      let requiredBytes = model.sizeBytes || model.sizeMb * 1_000_000 || 0;
      if (requiredBytes > 0 && hasDrafter) {
        requiredBytes += model.draftSizeBytes;
      }
      if (requiredBytes > 0) {
        this.downloadReservations.set(modelId, requiredBytes * 1.2);
        const reservedBytes = this.getReservedDownloadBytes();
        const spaceCheck = await checkDiskSpace(this.modelsDir, reservedBytes);
        if (!spaceCheck.ok) {
          throw new ModelError(
            `Not enough disk space. Need ~${Math.round(reservedBytes / 1_000_000)}MB, ` +
              `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`,
            "INSUFFICIENT_DISK_SPACE",
            { required: reservedBytes, available: spaceCheck.availableBytes }
          );
        }
      }

      const downloadUrl = this.getDownloadUrl(provider, model);

      // With a drafter, weight progress across both files by declared bytes and
      // clamp it so the bar never regresses across the phase boundary. Without a
      // drafter, keep today's single-file progress exactly.
      const combinedTotal = hasDrafter ? (model.sizeBytes || 0) + model.draftSizeBytes : 0;
      let lastCombined = 0;
      const emitCombined = (rawCombined) => {
        let combined = Math.min(rawCombined, combinedTotal);
        if (combined < lastCombined) combined = lastCombined;
        else lastCombined = combined;
        const progress = combinedTotal > 0 ? (combined / combinedTotal) * 100 : 0;
        this.downloadProgress.set(modelId, {
          modelId,
          progress,
          downloadedSize: combined,
          totalSize: combinedTotal,
        });
        if (onProgress) onProgress(progress, combined, combinedTotal);
      };

      await sharedDownloadFile(downloadUrl, modelPath, {
        signal,
        onProgress: hasDrafter
          ? (downloadedBytes) => emitCombined(downloadedBytes)
          : (downloadedBytes, totalBytes) => {
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

      // Drafter is opportunistic: a failure or cancel here leaves the main model
      // fully usable, so never fail the download or delete the main file.
      if (hasDrafter) {
        const draftPath = path.join(this.modelsDir, model.draftFileName);
        try {
          await sharedDownloadFile(this.getDraftDownloadUrl(provider, model), draftPath, {
            signal,
            onProgress: (downloadedBytes) => emitCombined(stats.size + downloadedBytes),
          });
          const draftStats = await fsPromises.stat(draftPath);
          if (draftStats.size < MIN_FILE_SIZE) {
            await fsPromises.unlink(draftPath).catch(() => {});
            debugLogger.warn("MTP drafter file too small, keeping model without it", { modelId });
          }
        } catch (draftError) {
          await fsPromises.unlink(draftPath).catch(() => {});
          if (draftError.isAbort) throw draftError;
          debugLogger.warn("MTP drafter download failed, keeping model without it", {
            modelId,
            error: draftError.message,
          });
        }
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
      if (this.activeDownloads.delete(modelId)) {
        this.downloadLifecycleVersion += 1;
      }
      this.activeRequests.delete(modelId);
      this.downloadProgress.delete(modelId);
      this.downloadReservations.delete(modelId);
    }
  }

  getDownloadUrl(provider, model) {
    const baseUrl = provider.baseUrl || "https://huggingface.co";
    return `${baseUrl}/${model.hfRepo}/resolve/main/${model.fileName}`;
  }

  getDraftDownloadUrl(provider, model) {
    const baseUrl = provider.baseUrl || "https://huggingface.co";
    return `${baseUrl}/${model.draftHfRepo}/resolve/main/${model.draftFileName}`;
  }

  modelHasDrafter(model) {
    return Boolean(model && model.draftHfRepo && model.draftFileName && model.draftSizeBytes);
  }

  // Opportunistic MTP drafter path: only when declared and the file passes the
  // same >1MB validity gate as models. Returns null otherwise (start without MTP).
  async resolveDraftPath(model) {
    if (!this.modelHasDrafter(model)) return null;
    const draftPath = path.join(this.modelsDir, model.draftFileName);
    if (await this.checkModelValid(draftPath)) return draftPath;
    return null;
  }

  cancelDownload(modelId) {
    const entry = this.activeRequests.get(modelId);
    if (entry) {
      // Keep the guard and status visible until downloadModel's finally block
      // has finished cleaning up the writer and its temporary file.
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

    // Remove the drafter too when present, best effort (ignore ENOENT).
    if (modelInfo.model.draftFileName) {
      const draftPath = path.join(this.modelsDir, modelInfo.model.draftFileName);
      await fsPromises.unlink(draftPath).catch(() => {});
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

  /**
   * Make sure the prompt actually fits the running window, growing it once if
   * it does not, trading output room for the prompt if it still does not, and
   * refusing only when no usable answer is left.
   *
   * The estimate above only picks a starting size. This is where the decision
   * becomes exact, because a wrong guess here is the bug: llama-server answers
   * an overlong prompt with a 400 whose JSON body used to reach the user.
   *
   * Returns the output allowance the request should actually be sent with.
   */
  async _ensurePromptFits({
    modelInfo,
    messages,
    options,
    estimatedTokens,
    maxTokens,
    contextFloor,
    ceilingFor,
    startServer,
  }) {
    const reserveTokens = reserveFor(maxTokens);
    const running = this.serverManager.contextSize || contextFloor;

    // Comfortably inside the window: measuring cannot change the outcome, and
    // every dictation would otherwise pay for two HTTP round trips.
    if ((estimatedTokens + reserveTokens) * PREFLIGHT_MEASURE_FACTOR <= running) return maxTokens;

    const usable = (await this.serverManager.usableContextSize()) ?? running;
    const exactTokens = await this.serverManager.countPromptTokens(messages, {
      disableThinking: options.disableThinking,
    });

    // A measurement we could not take must never fail the request; the
    // estimate already sized the window, and an overflow would still surface
    // as a typed error from llama-server itself.
    if (exactTokens === null) {
      debugLogger.warn("Could not measure prompt tokens; proceeding on the estimate", {
        model: modelInfo.model.id,
        estimatedTokens,
      });
      return maxTokens;
    }

    const neededTokens = exactTokens + reserveTokens;
    if (neededTokens <= usable) return maxTokens;

    const { ceiling: maxContext } = await ceilingFor();
    const grown = resolveContextSize({
      needed: neededTokens,
      floor: contextFloor,
      ceiling: maxContext,
    });

    if (grown > usable) await startServer(grown);

    const nowUsable =
      (await this.serverManager.usableContextSize()) ?? this.serverManager.contextSize ?? grown;
    if (neededTokens <= nowUsable) return maxTokens;

    // The window is as big as this machine allows and the prompt still does not
    // leave room for the answer we wanted. But llama-server rejects only a
    // prompt that fills the window on its own (`n_tokens >= n_ctx`) —
    // overrunning during generation just ends the reply with finish_reason
    // "length" — so a shorter answer is still a real answer, and refusing one
    // the user could have had is the regression this preflight would otherwise
    // introduce (#2142).
    //
    // No `- CONTEXT_RESERVE_TOKENS` here: that slack absorbs drift in the
    // *estimate* that sized the window, while this is an exact count of the
    // exact prompt. The MIN_OUTPUT_TOKENS floor below already keeps the prompt
    // clear of the edge by the same margin, so charging it twice would only
    // shorten the answer.
    const affordableOutput = nowUsable - exactTokens;
    if (!options.requireCompleteOutput && affordableOutput >= MIN_OUTPUT_TOKENS) {
      debugLogger.info("Trimming the output allowance to fit the context window", {
        model: modelInfo.model.id,
        requested: maxTokens,
        granted: affordableOutput,
        promptTokens: exactTokens,
        contextSize: nowUsable,
      });
      return affordableOutput;
    }

    // Either nothing usable is left, or the caller cannot accept a partial
    // answer at all (a selection edit replaces the user's own text, so half of
    // one is worse than none).
    throw new ModelError(
      `This content needs about ${neededTokens} tokens of context, but ${modelInfo.model.name} can only use ${nowUsable} on this computer.`,
      "CONTEXT_TOO_LARGE",
      {
        modelId: modelInfo.model.id,
        modelName: modelInfo.model.name,
        neededTokens,
        maxContextTokens: nowUsable,
      }
    );
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

    // Build messages for chat completion
    const messages = [
      { role: "system", content: options.systemPrompt || "" },
      { role: "user", content: prompt },
    ];

    const maxTokens = options.maxTokens ?? 512;
    // Whatever the prompt needs, plus room for the reply. The output reserve
    // is part of the context budget, not on top of it.
    const reserveTokens = reserveFor(maxTokens);
    const estimatedTokens = estimateTokens(options.systemPrompt || "") + estimateTokens(prompt);
    // A caller may ask for a larger floor (selection editing does); it can
    // raise the floor but never breach the ceiling.
    const contextFloor = Math.max(SERVER_CONTEXT_SIZE, options.contextSize || 0);

    let ceiling = null;
    const ceilingFor = async () => {
      if (ceiling === null) ceiling = await this.contextCeiling(modelInfo, modelPath);
      return ceiling;
    };

    let targetContextSize = contextFloor;
    // A raised floor has to clear the ceiling too, or a caller asking for a
    // window the machine cannot afford reopens #1203. The baseline floor needs
    // no check, which is what keeps the GGUF read off the short-request path.
    if (contextFloor > SERVER_CONTEXT_SIZE || estimatedTokens + reserveTokens > contextFloor) {
      const { ceiling: maxContext } = await ceilingFor();
      targetContextSize = resolveContextSize({
        needed: estimatedTokens + reserveTokens,
        floor: contextFloor,
        ceiling: maxContext,
      });
    }

    // The smallest window this machine has already refused for this model,
    // whether by failing to start or by quietly loading something smaller.
    // Retrying it would cost a second model load to learn the same thing.
    let smallestRefusedContextSize = Infinity;
    const refuse = (size) => {
      smallestRefusedContextSize = Math.min(smallestRefusedContextSize, size);
    };

    const startServer = async (contextSize) => {
      if (this.serverManager.ready && contextSize >= smallestRefusedContextSize) return;

      const { cacheRamMiB } = ceiling ?? {};
      // Only a live server already serving THIS model has a window worth
      // coming back to. contextSize outlives a crash — llamaServer clears it
      // in stop() alone, not when a process dies or a health check trips — and
      // another model's window says nothing about this one.
      const restorableContextSize =
        this.serverManager.ready &&
        this.serverManager.process &&
        this.currentServerModelId === modelId
          ? this.serverManager.contextSize
          : null;
      const startAt = async (size) =>
        this.serverManager.start(
          modelPath,
          await this.serverStartOptions(modelInfo, { contextSize: size, cacheRamMiB })
        );
      // llama.cpp's startup dump is the diagnostic, so it goes to the log here
      // and nowhere else: details crosses IPC to the renderer, which neither
      // reads it nor should carry a stderr blob and absolute model paths.
      const unavailable = (cause) => {
        debugLogger.error("llama-server could not be started", {
          model: modelId,
          contextSize,
          error: cause.message,
        });
        return new ModelError(
          `${modelInfo.model.name} could not be started on this computer.`,
          "LOCAL_SERVER_UNAVAILABLE",
          { modelId, modelName: modelInfo.model.name }
        );
      };

      try {
        await startAt(contextSize);
        // The GPU ladder can load a smaller window than it was asked for
        // without ever throwing. Recording that is what stops the preflight
        // asking for the same window again and paying a second model load to
        // be stepped down again.
        if (this.serverManager.contextSize < contextSize) refuse(contextSize);
      } catch (error) {
        refuse(contextSize);
        // start() stops the running server before it spawns, so a grow that
        // dies has already taken a working window with it. Come back at the
        // one that worked rather than leaving the user with no local model.
        if (!restorableContextSize || restorableContextSize >= contextSize) {
          throw unavailable(error);
        }

        debugLogger.warn("llama-server failed to grow; restoring the previous context", {
          model: modelId,
          attempted: contextSize,
          restoring: restorableContextSize,
          error: error.message,
        });
        try {
          await startAt(restorableContextSize);
        } catch (restoreError) {
          throw unavailable(restoreError);
        }
      }
      this.currentServerModelId = modelId;
    };

    // Start/restart the server if needed, if the model changed, or if this
    // request needs a bigger window than the running one has.
    if (
      !this.serverManager.ready ||
      this.currentServerModelId !== modelId ||
      targetContextSize > (this.serverManager.contextSize || SERVER_CONTEXT_SIZE)
    ) {
      debugLogger.logReasoning("INFERENCE_STARTING_SERVER", {
        currentModel: this.currentServerModelId,
        requestedModel: modelId,
        serverReady: this.serverManager.ready,
        contextSize: targetContextSize,
      });

      await startServer(targetContextSize);

      debugLogger.logReasoning("INFERENCE_SERVER_STARTED", {
        port: this.serverManager.port,
        model: modelId,
        contextSize: this.serverManager.contextSize,
      });
    }

    const grantedMaxTokens = await this._ensurePromptFits({
      modelInfo,
      messages,
      options,
      estimatedTokens,
      maxTokens,
      contextFloor,
      ceilingFor,
      startServer,
    });

    debugLogger.logReasoning("INFERENCE_SENDING_REQUEST", {
      messageCount: messages.length,
      systemPromptLength: (options.systemPrompt || "").length,
      userPromptLength: prompt.length,
    });

    try {
      const result = await this.serverManager.inference(messages, {
        temperature: options.temperature ?? 0.7,
        // The preflight may have traded output room for prompt room; sending
        // the original value would put the request back over the window.
        max_tokens: grantedMaxTokens,
        disableThinking: options.disableThinking,
        requireCompleteOutput: options.requireCompleteOutput,
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
      // A typed failure (a context overflow, say) must keep its identity, or
      // the renderer cannot translate it and the user sees raw server text.
      if (error.code === "CONTEXT_TOO_LARGE") {
        throw new ModelError(error.message, "CONTEXT_TOO_LARGE", {
          modelId,
          modelName: modelInfo.model.name,
          neededTokens: error.neededTokens ?? null,
          maxContextTokens: error.maxContextTokens ?? null,
        });
      }
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
      await this.serverManager.start(modelPath, await this.serverStartOptions(modelInfo));
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
