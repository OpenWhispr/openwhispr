const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService, getCacheRoot } = require("./modelDirUtils");
const {
  downloadFile,
  fetchJson,
  createDownloadSignal,
  createDownloadInProgressError,
  cleanupStaleDownloads,
  checkDiskSpace,
  extractArchive,
} = require("./downloadUtils");
const { getFFmpegPath, isPcm16Mono16kWav, convertToWav } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { spawn, execFile } = require("child_process");
const {
  QUALCOMM_MODEL_FILES,
  QUALCOMM_CHIPSETS,
  QUALCOMM_ASSET_TYPE,
  getHfModelSize,
  getRequiredModelFiles,
  isQualcommLocalProvider,
} = require("./qualcommModelInfo");
const {
  getQualcommCapability,
  assertQualcommSupported,
} = require("./qualcommCapability");
const { QualcommRuntimeManager } = require("./qualcommRuntime");

const modelRegistryData = require("../models/modelRegistryData.json");

const SIDECAR_READY_TIMEOUT_MS = 5 * 60 * 1000;
const SIDECAR_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
// Tokenizer/config files from openai/whisper-<size>; optional ones may 404.
const REQUIRED_TOKENIZER_FILES = [
  "config.json",
  "preprocessor_config.json",
  "tokenizer_config.json",
  "vocab.json",
  "merges.txt",
];
const OPTIONAL_TOKENIZER_FILES = [
  "special_tokens_map.json",
  "added_tokens.json",
  "generation_config.json",
];

function getQualcommModelConfig(modelName) {
  const modelInfo = modelRegistryData.qualcommModels[modelName];
  if (!modelInfo) return null;
  return {
    hfRepo: modelInfo.hfRepo,
    hfModelSize: modelInfo.hfModelSize,
    size: modelInfo.sizeMb * 1_000_000,
    language: modelInfo.language,
  };
}

function getValidModelNames() {
  return Object.keys(modelRegistryData.qualcommModels);
}

// Tokenizer sources are plain openai/whisper-* repos; resolve URL for a file.
function hfResolveUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

// Walk release_assets.json for the first available chipset export. Precision
// entries are walked in file order ("float" first today); quantized repos only
// publish that one precision name anyway.
function resolveReleaseAssetUrl(releaseAssets, chipsets = QUALCOMM_CHIPSETS) {
  const precisions = releaseAssets?.precisions || {};
  for (const precision of Object.values(precisions)) {
    const chipsetAssets = precision?.chipset_assets || {};
    for (const chipset of chipsets) {
      const asset = chipsetAssets[chipset]?.[QUALCOMM_ASSET_TYPE];
      if (asset?.download_url) {
        return { url: asset.download_url, chipset, precision: precision.name || "float" };
      }
    }
  }
  return null;
}

class QualcommWhisperManager {
  constructor() {
    this.runtimeManager = new QualcommRuntimeManager();
    this.currentDownloadProcess = null;
    this.isInitialized = false;
    this.sidecar = null; // { child, model, ready, pending: Map, nextId, buffer }
    this.sidecarStarting = null;
    this.requestQueue = Promise.resolve();
  }

  getModelsDir() {
    return getModelsDirForService("qualcomm");
  }

  getRuntimeDir() {
    return path.join(getCacheRoot(), "qualcomm-runtime");
  }

  validateModelName(modelName) {
    const validModels = getValidModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(
        `Invalid Qualcomm model: ${modelName}. Valid models: ${validModels.join(", ")}`
      );
    }
    return true;
  }

  getModelPath(modelName) {
    this.validateModelName(modelName);
    return path.join(this.getModelsDir(), modelName);
  }

  isModelDownloaded(modelName) {
    try {
      const modelPath = this.getModelPath(modelName);
      return getRequiredModelFiles(modelName).every((file) =>
        fs.existsSync(path.join(modelPath, file))
      );
    } catch {
      return false;
    }
  }

  getSidecarScriptPath() {
    const packagedPath = path.join(process.resourcesPath || "", "qualcomm", "whisper_npu_sidecar.py");
    if (process.resourcesPath && fs.existsSync(packagedPath)) {
      return packagedPath;
    }
    // Repo layout from src/helpers.
    return path.join(__dirname, "..", "..", "resources", "qualcomm", "whisper_npu_sidecar.py");
  }

  async initializeAtStartup(settings = {}) {
    const startTime = Date.now();
    try {
      this.isInitialized = true;
      await cleanupStaleDownloads(this.getModelsDir());

      const { localTranscriptionProvider, qualcommModel } = settings;
      const capability = getQualcommCapability();

      if (
        capability.supported &&
        isQualcommLocalProvider(localTranscriptionProvider) &&
        qualcommModel &&
        this.isModelDownloaded(qualcommModel) &&
        this.runtimeManager.isRuntimeReady()
      ) {
        debugLogger.info("Pre-warming Qualcomm NPU sidecar", { model: qualcommModel });
        try {
          await this._startSidecar(qualcommModel);
        } catch (err) {
          debugLogger.warn("Qualcomm sidecar pre-warm failed (will start on first use)", {
            error: err.message,
            model: qualcommModel,
          });
        }
      } else {
        debugLogger.debug("Skipping Qualcomm sidecar pre-warm", {
          reason: !capability.supported
            ? capability.message
            : !isQualcommLocalProvider(localTranscriptionProvider)
              ? "provider not qualcomm"
              : !qualcommModel
                ? "no model selected"
                : !this.isModelDownloaded(qualcommModel)
                  ? "model not downloaded"
                  : "runtime not installed",
        });
      }
    } catch (error) {
      debugLogger.warn("Qualcomm initialization error", { error: error.message });
      this.isInitialized = true;
    }
    debugLogger.info("Qualcomm initialization complete", { totalTimeMs: Date.now() - startTime });
  }

  async checkInstallation() {
    const capability = getQualcommCapability();
    const scriptPath = this.getSidecarScriptPath();
    const scriptAvailable = fs.existsSync(scriptPath);

    if (!capability.supported) {
      return { installed: scriptAvailable, working: false, ...capability };
    }

    const runtimeStatus = this.runtimeManager.getStatus();
    return {
      installed: scriptAvailable,
      working: scriptAvailable && runtimeStatus.ready,
      supported: true,
      scriptPath,
      runtime: runtimeStatus,
    };
  }

  getRuntimeStatus() {
    return this.runtimeManager.getStatus();
  }

  async installRuntime(onProgress = null) {
    assertQualcommSupported();
    return this.runtimeManager.ensureRuntime({ onProgress });
  }

  cancelRuntimeInstall() {
    return this.runtimeManager.cancelInstall();
  }

  // ---- Sidecar lifecycle -------------------------------------------------

  _ensureSidecar(modelName) {
    if (this.sidecar && this.sidecar.model === modelName && this.sidecar.ready) {
      return Promise.resolve(this.sidecar);
    }
    if (!this.sidecarStarting || this.sidecarStarting.model !== modelName) {
      this.sidecarStarting = this._startSidecar(modelName).catch((error) => {
        this.sidecarStarting = null;
        throw error;
      });
      this.sidecarStarting.model = modelName;
    }
    return this.sidecarStarting;
  }

  // A crashed or force-killed app leaves its sidecar python alive (Windows
  // does not kill children with the parent), and a second sidecar blocks
  // forever initializing the QNN/NPU device the orphan still holds. Sweep any
  // process running our sidecar script before spawning a fresh one.
  _killOrphanedSidecars() {
    if (process.platform !== "win32") return;
    return new Promise((resolve) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | " +
            "Where-Object { $_.CommandLine -like '*whisper_npu_sidecar.py*' } | " +
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        ],
        { windowsHide: true, timeout: 20000 },
        (error) => {
          if (error) {
            debugLogger.debug("Orphaned sidecar sweep failed (non-fatal)", {
              error: error.message,
            });
          }
          resolve();
        }
      );
    });
  }

  async _startSidecar(modelName) {
    await this._killOrphanedSidecars();
    await this._stopSidecar();

    const runtimeManager = this.runtimeManager;
    if (!runtimeManager.isRuntimeReady()) {
      throw Object.assign(
        new Error("The Qualcomm NPU runtime is not installed yet. Install it from Settings."),
        { code: "QUALCOMM_RUNTIME_MISSING" }
      );
    }
    const pythonPath = runtimeManager.getVenvPythonPath();
    if (!fs.existsSync(pythonPath)) {
      throw Object.assign(new Error("Qualcomm NPU runtime python not found"), {
        code: "QUALCOMM_RUNTIME_MISSING",
      });
    }

    const scriptPath = this.getSidecarScriptPath();
    const modelDir = this.getModelPath(modelName);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Qualcomm sidecar script not found: ${scriptPath}`);
    }

    debugLogger.info("Starting Qualcomm NPU sidecar", { pythonPath, modelDir });
    const child = spawn(
      pythonPath,
      ["-X", "utf8", "-u", scriptPath, "--model-dir", modelDir],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      }
    );

    const state = {
      child,
      model: modelName,
      ready: false,
      pending: new Map(),
      nextId: 1,
      buffer: "",
      closed: false,
    };
    this.sidecar = state;

    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Qualcomm sidecar did not report ready in time"));
        this._stopSidecar();
      }, SIDECAR_READY_TIMEOUT_MS);

      const onLine = (line) => {
        debugLogger.debug("Qualcomm sidecar stdout", { line });
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type === "ready") {
          clearTimeout(timeout);
          if (message.ok) {
            state.ready = true;
            resolve(state);
          } else {
            reject(new Error(message.error || "Qualcomm sidecar failed to load the model"));
            this._stopSidecar();
          }
          return;
        }
        // Request responses: match the id and settle the awaiting transcribe.
        const pending = state.pending.get(message.id);
        if (pending) {
          state.pending.delete(message.id);
          pending.resolve(message);
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        state.buffer += chunk;
        let index;
        while ((index = state.buffer.indexOf("\n")) !== -1) {
          const line = state.buffer.slice(0, index).trim();
          state.buffer = state.buffer.slice(index + 1);
          if (line) onLine(line);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) debugLogger.debug("Qualcomm sidecar stderr", { line: line.trim() });
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start Qualcomm sidecar: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        state.closed = true;
        state.ready = false;
        for (const [id, pending] of state.pending) {
          pending.reject(
            new Error(`Qualcomm sidecar exited (code ${code}) before responding to request ${id}`)
          );
          state.pending.delete(id);
        }
        if (this.sidecar === state) {
          this.sidecar = null;
        }
      });
    });

    try {
      await readyPromise;
    } catch (error) {
      if (this.sidecar === state) this.sidecar = null;
      throw error;
    }
    return state;
  }

  async _stopSidecar() {
    const state = this.sidecar;
    if (!state) return;
    this.sidecar = null;
    state.ready = false;
    for (const [, pending] of state.pending) {
      pending.reject(new Error("Qualcomm sidecar stopped"));
    }
    state.pending.clear();
    await new Promise((resolve) => {
      if (state.child.exitCode !== null) return resolve();
      state.child.once("close", resolve);
      state.child.kill();
      setTimeout(resolve, 3000);
    });
  }

  async stop() {
    await this._stopSidecar();
  }

  async transcribeWavFile(wavPath, options = {}) {
    const modelName = options.model;
    this.validateModelName(modelName);

    const request = () =>
      new Promise((resolve, reject) => {
        const state = this.sidecar;
        if (!state || !state.ready) {
          reject(new Error("Qualcomm sidecar is not running"));
          return;
        }
        const id = state.nextId++;
        const timer = setTimeout(() => {
          state.pending.delete(id);
          reject(new Error("Qualcomm NPU transcription timed out"));
          // A hung NPU decode poisons every later request; restart on next use.
          this._stopSidecar();
        }, options.timeoutMs || SIDECAR_REQUEST_TIMEOUT_MS);
        state.pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        state.child.stdin.write(JSON.stringify({ id, wav: wavPath, language: options.language }) + "\n");
      });

    // Serialize requests: the sidecar answers strictly in order.
    const run = this.requestQueue.then(request, (error) => {
      throw error;
    });
    this.requestQueue = run.catch(() => {});
    return run;
  }

  // ---- Transcription -----------------------------------------------------

  async transcribeLocalQualcomm(audioBlob, options = {}) {
    const model = options.model || "whisper-tiny";
    assertQualcommSupported();

    if (!this.runtimeManager.isRuntimeReady()) {
      throw Object.assign(
        new Error("The Qualcomm NPU runtime is not installed yet. Install it from Settings."),
        { code: "QUALCOMM_RUNTIME_MISSING" }
      );
    }
    if (!this.isModelDownloaded(model)) {
      throw new Error(`Qualcomm model "${model}" not downloaded. Please download it from Settings.`);
    }

    let audioBuffer;
    if (Buffer.isBuffer(audioBlob)) {
      audioBuffer = audioBlob;
    } else if (ArrayBuffer.isView(audioBlob)) {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
    } else if (audioBlob instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      audioBuffer = Buffer.from(audioBlob, "base64");
    } else {
      throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
    }
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty - no audio data received");
    }

    const wavPath = await this._ensureWavFile(audioBuffer);
    try {
      await this._ensureSidecar(model);

      const startTime = Date.now();
      const response = await this.transcribeWavFile(wavPath, {
        model,
        language: options.language,
        signal: options.signal,
      });
      const elapsed = Date.now() - startTime;
      debugLogger.logSTTPipeline("transcribeLocalQualcomm - completed", {
        elapsed,
        textLength: response.text?.length || 0,
        model,
      });

      return this.parseQualcommResult(response);
    } finally {
      fsPromises.unlink(wavPath).catch(() => {});
    }
  }

  async _ensureWavFile(audioBuffer) {
    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const wavPath = path.join(tempDir, `qualcomm-input-${timestamp}-${Math.random().toString(36).slice(2)}.wav`);

    // The sidecar reads WAV files directly; only convert when the capture
    // pipeline handed over a compressed container instead of 16 kHz PCM.
    if (isPcm16Mono16kWav(audioBuffer)) {
      await fsPromises.writeFile(wavPath, audioBuffer);
      return wavPath;
    }

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "FFmpeg not found - required for audio conversion. Please ensure FFmpeg is installed."
      );
    }
    const tempInputPath = path.join(tempDir, `qualcomm-raw-${timestamp}.webm`);
    await fsPromises.writeFile(tempInputPath, audioBuffer);
    try {
      await convertToWav(tempInputPath, wavPath, { sampleRate: 16000, channels: 1 });
    } finally {
      fsPromises.unlink(tempInputPath).catch(() => {});
    }
    return wavPath;
  }

  parseQualcommResult(response) {
    if (!response || typeof response.text !== "string") {
      return {
        success: false,
        error: "invalid_response",
        message: "Transcription engine returned an unexpected response",
      };
    }
    const text = response.text.trim();
    if (!text) {
      return { success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" };
    }
    return { success: true, text };
  }

  // ---- Download ----------------------------------------------------------

  async downloadQualcommModel(modelName, progressCallback = null) {
    this.validateModelName(modelName);
    assertQualcommSupported();
    const modelConfig = getQualcommModelConfig(modelName);
    const modelPath = this.getModelPath(modelName);
    const modelsDir = this.getModelsDir();

    if (this.isModelDownloaded(modelName)) {
      return { model: modelName, downloaded: true, path: modelPath, success: true };
    }
    if (this.currentDownloadProcess) {
      throw createDownloadInProgressError(modelName, this.currentDownloadProcess.model);
    }

    const { signal, abort } = createDownloadSignal();
    const downloadProcess = {
      abort,
      model: modelName,
      phase: "progress",
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: 0,
    };
    this.currentDownloadProcess = downloadProcess;

    const reportProgress = (payload) => {
      if (progressCallback) progressCallback(payload);
    };

    try {
      await fsPromises.mkdir(modelsDir, { recursive: true });

      reportProgress({ type: "resolving", model: modelName, percentage: 0 });

      const releaseAssets = await fetchJson(
        `https://huggingface.co/${modelConfig.hfRepo}/raw/main/release_assets.json`,
        { credentials: "omit", cache: "no-store" }
      );
      const asset = resolveReleaseAssetUrl(releaseAssets);
      if (!asset) {
        throw new Error(
          `No precompiled QNN export for ${QUALCOMM_CHIPSETS.join(" or ")} in ${modelConfig.hfRepo}`
        );
      }
      debugLogger.info("Resolved Qualcomm model asset", { modelName, ...asset });

      const spaceCheck = await checkDiskSpace(modelsDir, modelConfig.size * 2.5);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space to download and extract the model. Need ~${Math.round(
            (modelConfig.size * 2.5) / 1_000_000
          )}MB, only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      const zipPath = path.join(modelsDir, `${modelName}.zip`);
      await downloadFile(asset.url, zipPath, {
        timeout: 1800000,
        signal,
        onProgress: (downloadedBytes, totalBytes) => {
          downloadProcess.percentage =
            totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          downloadProcess.downloadedBytes = downloadedBytes;
          downloadProcess.totalBytes = totalBytes;
          reportProgress({
            type: "progress",
            model: modelName,
            downloaded_bytes: downloadedBytes,
            total_bytes: totalBytes,
            percentage: downloadProcess.percentage,
          });
        },
      });

      downloadProcess.phase = "installing";
      downloadProcess.percentage = 100;
      reportProgress({ type: "installing", model: modelName, percentage: 100 });

      const extractDir = path.join(modelsDir, `temp-extract-${modelName}`);
      await fsPromises.rm(extractDir, { recursive: true, force: true });
      await fsPromises.mkdir(extractDir, { recursive: true });
      try {
        await extractArchive(zipPath, extractDir);
        // The zip holds one top-level directory; flatten it into the model dir.
        const entries = await fsPromises.readdir(extractDir, { withFileTypes: true });
        const sourceDir = entries.filter((e) => e.isDirectory()).length
          ? path.join(extractDir, entries.find((e) => e.isDirectory()).name)
          : extractDir;
        await fsPromises.rm(modelPath, { recursive: true, force: true });
        await fsPromises.rename(sourceDir, modelPath);
      } finally {
        await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      }
      await fsPromises.unlink(zipPath).catch(() => {});

      reportProgress({ type: "tokenizer", model: modelName, percentage: 100 });

      const tokenizerBase = `openai/whisper-${modelConfig.hfModelSize}`;
      for (const file of [...REQUIRED_TOKENIZER_FILES, ...OPTIONAL_TOKENIZER_FILES]) {
        const target = path.join(modelPath, file);
        try {
          await downloadFile(hfResolveUrl(tokenizerBase, file), target, {
            timeout: 120000,
            signal,
          });
        } catch (error) {
          if (REQUIRED_TOKENIZER_FILES.includes(file)) {
            throw new Error(`Failed to download ${file} from ${tokenizerBase}: ${error.message}`);
          }
          debugLogger.debug("Optional tokenizer file unavailable", { file, error: error.message });
        }
      }

      const missing = getRequiredModelFiles(modelName).filter(
        (file) => !fs.existsSync(path.join(modelPath, file))
      );
      if (missing.length > 0) {
        throw new Error(`Installed model is missing required files: ${missing.join(", ")}`);
      }

      reportProgress({ type: "complete", model: modelName, percentage: 100 });

      // Pre-warm the sidecar for a freshly downloaded model.
      this._ensureSidecar(modelName).catch((err) => {
        debugLogger.warn("Post-download sidecar pre-warm failed (non-fatal)", {
          error: err.message,
          model: modelName,
        });
      });

      return { model: modelName, downloaded: true, path: modelPath, success: true };
    } catch (error) {
      if (error.isAbort) {
        throw Object.assign(new Error("Download interrupted by user"), {
          code: "DOWNLOAD_CANCELLED",
        });
      }
      throw error;
    } finally {
      if (this.currentDownloadProcess === downloadProcess) {
        this.currentDownloadProcess = null;
      }
    }
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      if (this.currentDownloadProcess.phase === "installing") {
        return {
          success: false,
          error: "Model installation cannot be cancelled once extraction has started",
          code: "INSTALLATION_IN_PROGRESS",
        };
      }
      this.currentDownloadProcess.abort();
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async checkModelStatus(modelName) {
    const modelPath = this.getModelPath(modelName);
    const activeDownload = this.currentDownloadProcess?.model === modelName;
    const downloadStatus = {
      isDownloading: activeDownload,
      isInstalling: activeDownload && this.currentDownloadProcess.phase === "installing",
      downloadProgress: activeDownload ? this.currentDownloadProcess.percentage : 0,
      downloadedBytes: activeDownload ? this.currentDownloadProcess.downloadedBytes : 0,
      totalBytes: activeDownload ? this.currentDownloadProcess.totalBytes : 0,
    };

    if (this.isModelDownloaded(modelName)) {
      const sizeBytes = this._getModelWeightsSize(modelPath);
      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: sizeBytes,
        size_mb: Math.round(sizeBytes / (1024 * 1024)),
        success: true,
        ...downloadStatus,
      };
    }

    return { model: modelName, downloaded: false, success: true, ...downloadStatus };
  }

  _getModelWeightsSize(modelDir) {
    let total = 0;
    for (const file of ["encoder.bin", "decoder.bin"]) {
      try {
        total += fs.statSync(path.join(modelDir, file)).size;
      } catch {}
    }
    return total;
  }

  async listQualcommModels() {
    const models = getValidModelNames();
    const modelInfo = [];
    for (const model of models) {
      modelInfo.push(await this.checkModelStatus(model));
    }
    return {
      models: modelInfo,
      cache_dir: this.getModelsDir(),
      success: true,
    };
  }

  async deleteQualcommModel(modelName) {
    const modelPath = this.getModelPath(modelName);
    if (this.sidecar?.model === modelName) {
      await this._stopSidecar();
    }
    if (fs.existsSync(modelPath)) {
      try {
        const freedBytes = this._getModelWeightsSize(modelPath);
        fs.rmSync(modelPath, { recursive: true, force: true });
        return {
          model: modelName,
          deleted: true,
          freed_bytes: freedBytes,
          freed_mb: Math.round(freedBytes / (1024 * 1024)),
          success: true,
        };
      } catch (error) {
        return { model: modelName, deleted: false, error: error.message, success: false };
      }
    }
    return { model: modelName, deleted: false, error: "Model not found", success: false };
  }

  async deleteAllQualcommModels() {
    const modelsDir = this.getModelsDir();
    let totalFreed = 0;
    let deletedCount = 0;
    try {
      await this._stopSidecar();
      if (!fs.existsSync(modelsDir)) {
        return { success: true, deleted_count: 0, freed_bytes: 0, freed_mb: 0 };
      }
      const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(modelsDir, entry.name);
          try {
            totalFreed += this._getModelWeightsSize(dirPath);
            fs.rmSync(dirPath, { recursive: true, force: true });
            deletedCount++;
          } catch {}
        }
      }
      return {
        success: true,
        deleted_count: deletedCount,
        freed_bytes: totalFreed,
        freed_mb: Math.round(totalFreed / (1024 * 1024)),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getDiagnostics() {
    const diagnostics = {
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath || null,
      isPackaged: !!process.resourcesPath && !process.resourcesPath.includes("node_modules"),
      sidecarScript: { available: fs.existsSync(this.getSidecarScriptPath()), path: this.getSidecarScriptPath() },
      runtime: this.runtimeManager.getStatus(),
      modelsDir: this.getModelsDir(),
      models: [],
    };
    try {
      const modelsDir = this.getModelsDir();
      if (fs.existsSync(modelsDir)) {
        const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
        diagnostics.models = entries
          .filter((e) => e.isDirectory() && this.isModelDownloaded(e.name))
          .map((e) => e.name);
      }
    } catch {}
    return diagnostics;
  }
}

module.exports = { QualcommWhisperManager, resolveReleaseAssetUrl };
