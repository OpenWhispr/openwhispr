const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const os = require("os");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
} = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");

const PORT_RANGE_START = 6006;
const PORT_RANGE_END = 6029;
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const TRANSCRIPTION_TIMEOUT_MS = 300000;

class ParakeetWsServer {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelName = null;
    this.modelDir = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.transcribing = false;
    this.cachedWsBinaryPath = null;
    this.lastBackendTrace = {
      launch: null,
      providerPreference: "auto",
      providerAttempted: null,
      providerUsed: null,
      fallbackUsed: false,
      cudaLibDirs: [],
      evidenceLines: [],
      lastError: null,
    };
  }

  getWsBinaryPath() {
    if (this.cachedWsBinaryPath) return this.cachedWsBinaryPath;

    const platformArch = `${process.platform}-${process.arch}`;
    const binaryName =
      process.platform === "win32"
        ? `sherpa-onnx-ws-${platformArch}.exe`
        : `sherpa-onnx-ws-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedWsBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    return this.getWsBinaryPath() !== null;
  }

  getProviderPreference() {
    const raw = String(process.env.OPENWHISPR_PARAKEET_PROVIDER || "auto")
      .trim()
      .toLowerCase();
    if (raw === "gpu") return "cuda";
    if (raw === "cuda" || raw === "cpu" || raw === "auto") return raw;
    return "auto";
  }

  hasNvidiaGpu() {
    try {
      const output = execSync("nvidia-smi -L", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 3000,
      });
      return Boolean(output && output.trim());
    } catch {
      return false;
    }
  }

  buildSpawnEnv(wsBinaryDir) {
    const spawnEnv = { ...process.env };
    const pathSep = process.platform === "win32" ? ";" : ":";

    // Keep companion shared libraries resolvable.
    spawnEnv.PATH = wsBinaryDir + pathSep + (process.env.PATH || "");

    const trace = { cudaLibDirs: [], ldLibraryPathConfigured: false };

    if (process.platform === "linux") {
      const homeDir = os.homedir();
      const localCuda12Root =
        process.env.OPENWHISPR_CUDA12_RUNTIME_DIR ||
        path.join(homeDir, ".cache", "openwhispr", "cuda12-runtime");

      const cudaLibDirs = [
        wsBinaryDir,
        "/opt/cuda/targets/x86_64-linux/lib",
        "/opt/cuda/lib64",
        "/usr/local/cuda/targets/x86_64-linux/lib",
        "/usr/local/cuda/lib64",
        path.join(localCuda12Root, "nvidia", "cuda_runtime", "lib"),
        path.join(localCuda12Root, "nvidia", "cublas", "lib"),
        path.join(localCuda12Root, "nvidia", "cufft", "lib"),
        path.join(localCuda12Root, "nvidia", "nvjitlink", "lib"),
        path.join(localCuda12Root, "nvidia", "cudnn", "lib"),
      ].filter((dir) => fs.existsSync(dir));

      trace.cudaLibDirs = cudaLibDirs;

      if (cudaLibDirs.length > 0) {
        const ldLibraryPath = process.env.LD_LIBRARY_PATH || "";
        const ldParts = ldLibraryPath.split(":").filter(Boolean);
        const merged = [...cudaLibDirs, ...ldParts].filter(
          (dir, index, arr) => arr.indexOf(dir) === index
        );
        spawnEnv.LD_LIBRARY_PATH = merged.join(":");
        trace.ldLibraryPathConfigured = true;
      }
    }

    return { spawnEnv, trace };
  }

  shouldPreferCuda(providerPreference, wsBinaryDir) {
    if (providerPreference === "cpu") return false;
    if (providerPreference === "cuda") return true;

    if (process.platform !== "linux" || process.arch !== "x64") return false;
    const hasCudaProviderLib = fs.existsSync(
      path.join(wsBinaryDir, "libonnxruntime_providers_cuda.so")
    );
    return hasCudaProviderLib && this.hasNvidiaGpu();
  }

  getProviderAttemptOrder(providerPreference, wsBinaryDir) {
    if (this.shouldPreferCuda(providerPreference, wsBinaryDir)) {
      return ["cuda", "cpu"];
    }
    return ["cpu"];
  }

  async start(modelName, modelDir) {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready && this.modelName === modelName) return;
    if (this.process) await this.stop();

    const wsBinary = this.getWsBinaryPath();
    const wsBinaryDir = wsBinary ? path.dirname(wsBinary) : getSafeTempDir();
    const providerPreference = this.getProviderPreference();
    const providerAttempts = this.getProviderAttemptOrder(providerPreference, wsBinaryDir);

    this.startupPromise = (async () => {
      let lastError = null;
      for (let i = 0; i < providerAttempts.length; i += 1) {
        const provider = providerAttempts[i];
        const isFallbackAttempt = i > 0;

        try {
          debugLogger.info("Parakeet backend attempt", {
            providerPreference,
            provider,
            isFallbackAttempt,
            providerAttempts,
          });

          await this._doStart(modelName, modelDir, {
            provider,
            providerPreference,
            isFallbackAttempt,
            providerAttempts,
          });
          return;
        } catch (error) {
          lastError = error;
          this.lastBackendTrace.lastError = error.message;
          debugLogger.warn("Parakeet backend startup attempt failed", {
            provider,
            isFallbackAttempt,
            error: error.message,
          });
          try {
            await this.stop();
          } catch {}
        }
      }

      throw lastError || new Error("Parakeet backend failed to start");
    })();
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelName, modelDir, options = {}) {
    const wsBinary = this.getWsBinaryPath();
    if (!wsBinary) throw new Error("sherpa-onnx WS server binary not found");
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    this.modelName = modelName;
    this.modelDir = modelDir;
    const provider = options.provider || "cpu";
    const wsBinaryDir = path.dirname(wsBinary);
    const { spawnEnv, trace: envTrace } = this.buildSpawnEnv(wsBinaryDir);

    const args = [
      `--provider=${provider}`,
      `--tokens=${path.join(modelDir, "tokens.txt")}`,
      `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
      `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
      `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
      `--port=${this.port}`,
      `--num-threads=${Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75)))}`,
    ];

    let wsBinarySizeMb = null;
    try {
      wsBinarySizeMb = Math.round(fs.statSync(wsBinary).size / (1024 * 1024));
    } catch {}

    this.lastBackendTrace = {
      launch: {
        binaryPath: wsBinary,
        binarySizeMb: wsBinarySizeMb,
        port: this.port,
        provider,
        providerPreference: options.providerPreference || "auto",
        providerAttempts: options.providerAttempts || [provider],
      },
      providerPreference: options.providerPreference || "auto",
      providerAttempted: provider,
      providerUsed: null,
      fallbackUsed: Boolean(options.isFallbackAttempt),
      cudaLibDirs: envTrace.cudaLibDirs,
      evidenceLines: [],
      lastError: null,
    };

    if (envTrace.cudaLibDirs.length > 0) {
      debugLogger.info("Parakeet CUDA runtime search paths configured", {
        provider,
        cudaLibDirs: envTrace.cudaLibDirs,
        ldLibraryPathConfigured: envTrace.ldLibraryPathConfigured,
      });
    }

    debugLogger.debug("Starting parakeet WS server", { port: this.port, modelName, args });
    debugLogger.info("Parakeet backend launch trace", this.lastBackendTrace.launch);

    this.process = spawn(wsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
      env: spawnEnv,
    });

    let stderrBuffer = "";
    let exitCode = null;
    let readyResolve = null;
    const readyFromStderr = new Promise((resolve) => {
      readyResolve = resolve;
    });

    this.process.stdout.on("data", (data) => {
      const text = data.toString();
      debugLogger.debug("parakeet-ws stdout", { data: text.trim() });

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (/provider/i.test(line) || /CUDAExecutionProvider/i.test(line)) {
          this.lastBackendTrace.evidenceLines.push(line);
          debugLogger.info("Parakeet provider trace", { stream: "stdout", line });
        }
      }
    });

    this.process.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer += text;
      debugLogger.debug("parakeet-ws stderr", { data: text.trim() });

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (
          /Available providers:|Fallback to cpu|provider=.*cuda|CPUExecutionProvider|CUDAExecutionProvider/i.test(
            line
          )
        ) {
          this.lastBackendTrace.evidenceLines.push(line);
          debugLogger.info("Parakeet provider trace", { stream: "stderr", line });

          if (/Fallback to cpu/i.test(line)) {
            this.lastBackendTrace.providerUsed = "cpu";
          }
        }

        if (
          /libonnxruntime_providers_cuda\.so|libcudart\.so\.12|libcublas(?:Lt)?\.so\.12|libcufft\.so\.11|Failed to load shared library/i.test(
            line
          )
        ) {
          this.lastBackendTrace.lastError = line;
          debugLogger.error("Parakeet CUDA startup error", { line });
        }

        if (line.includes("Listening on:")) {
          readyResolve(true);
        }
      }

      if (text.includes("Listening on:")) {
        readyResolve(true);
      }
    });

    this.process.on("error", (error) => {
      debugLogger.error("parakeet-ws process error", { error: error.message });
      this.lastBackendTrace.lastError = error.message;
      this.ready = false;
      readyResolve(false);
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("parakeet-ws process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
      readyResolve(false);
    });

    await this._waitForReady(readyFromStderr, () => ({ stderr: stderrBuffer, exitCode }));
    this._startHealthCheck();

    this.lastBackendTrace.providerUsed = this.lastBackendTrace.providerUsed || provider;
    debugLogger.info("parakeet-ws server started successfully", {
      port: this.port,
      model: modelName,
      providerAttempted: provider,
      providerUsed: this.lastBackendTrace.providerUsed,
    });

    await this._warmUp();
  }

  async _warmUp() {
    try {
      const sampleRate = 16000;
      const numSamples = sampleRate;
      const silentSamples = Buffer.alloc(numSamples * 4);
      await this.transcribe(silentSamples, sampleRate);
      debugLogger.debug("parakeet-ws warm-up inference complete");
    } catch (err) {
      debugLogger.warn("parakeet-ws warm-up failed (non-fatal)", {
        error: err.message,
      });
    }
  }

  async _waitForReady(readySignal, getProcessInfo) {
    const startTime = Date.now();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`parakeet-ws failed to start within ${STARTUP_TIMEOUT_MS}ms`)),
        STARTUP_TIMEOUT_MS
      );
    });

    const ready = await Promise.race([readySignal, timeoutPromise]);

    if (!ready) {
      const info = getProcessInfo ? getProcessInfo() : {};
      const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
      const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
      throw new Error(`parakeet-ws process died during startup${details ? `: ${details}` : ""}`);
    }

    this.ready = true;
    debugLogger.debug("parakeet-ws ready", { startupTimeMs: Date.now() - startTime });
  }

  _isProcessAlive() {
    if (!this.process || this.process.killed) return false;
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  _startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }
      if (this.transcribing) return;

      if (!this._isProcessAlive()) {
        debugLogger.warn("parakeet-ws health check failed: process not alive");
        this.ready = false;
        this.stopHealthCheck();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  transcribe(samplesBuffer, sampleRate) {
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }

    this.transcribing = true;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let result = "";

      const done =
        (fn) =>
        (...args) => {
          this.transcribing = false;
          fn(...args);
        };

      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        done(reject)(new Error("parakeet-ws transcription timed out"));
      }, TRANSCRIPTION_TIMEOUT_MS);

      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      ws.on("open", () => {
        // sherpa-onnx offline WS binary protocol:
        // [int32LE sample_rate][int32LE num_audio_bytes][float32 samples...]
        const message = Buffer.alloc(8 + samplesBuffer.length);
        message.writeInt32LE(sampleRate, 0);
        message.writeInt32LE(samplesBuffer.length, 4);
        samplesBuffer.copy(message, 8);

        debugLogger.debug("parakeet-ws sending audio", {
          samplesBytes: samplesBuffer.length,
          sampleRate,
        });

        ws.send(message, (err) => {
          if (err) {
            debugLogger.error("parakeet-ws send error", { error: err.message });
          }
        });
      });

      ws.on("message", (data) => {
        result += data.toString();
        ws.send("Done");
      });

      ws.on("close", (code) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;

        debugLogger.debug("parakeet-ws transcription completed", {
          elapsed,
          code,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        });

        try {
          const parsed = JSON.parse(result);
          done(resolve)({ text: (parsed.text || "").trim(), elapsed });
        } catch {
          done(resolve)({ text: result.trim(), elapsed });
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        done(reject)(new Error(`parakeet-ws transcription failed: ${error.message}`));
      });
    });
  }

  async stop() {
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping parakeet-ws server");

    try {
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping parakeet-ws server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelName = null;
    this.modelDir = null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelName: this.modelName,
      backendTrace: this.lastBackendTrace,
    };
  }
}

module.exports = ParakeetWsServer;
