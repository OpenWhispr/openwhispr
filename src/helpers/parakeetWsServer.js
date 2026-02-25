const { spawn } = require("child_process");
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

  async start(modelName, modelDir) {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready && this.modelName === modelName) return;
    if (this.process) await this.stop();

    this.startupPromise = this._doStart(modelName, modelDir);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelName, modelDir) {
    const wsBinary = this.getWsBinaryPath();
    if (!wsBinary) throw new Error("sherpa-onnx WS server binary not found");
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    this.modelName = modelName;
    this.modelDir = modelDir;

    const args = [
      `--tokens=${path.join(modelDir, "tokens.txt")}`,
      `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
      `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
      `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
      `--port=${this.port}`,
      `--num-threads=${Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75)))}`,
    ];

    debugLogger.debug("Starting parakeet WS server", { port: this.port, modelName, args });

    this.process = spawn(wsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
    });

    let stderrBuffer = "";
    let exitCode = null;
    let readyResolve = null;
    const readyFromStderr = new Promise((resolve) => {
      readyResolve = resolve;
    });

    this.process.stdout.on("data", (data) => {
      debugLogger.debug("parakeet-ws stdout", { data: data.toString().trim() });
    });

    this.process.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      debugLogger.debug("parakeet-ws stderr", { data: data.toString().trim() });
      if (data.toString().includes("Listening on:")) {
        readyResolve(true);
      }
    });

    this.process.on("error", (error) => {
      debugLogger.error("parakeet-ws process error", { error: error.message });
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

    debugLogger.info("parakeet-ws server started successfully", {
      port: this.port,
      model: modelName,
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
    };
  }
}

module.exports = ParakeetWsServer;
