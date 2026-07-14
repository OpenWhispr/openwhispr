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
const sidecarPidFile = require("./sidecarPidFile");
const { parseOfflineMessage, createOnlineAccumulator } = require("./parakeetWsResult");
const { pcm16ToFloat32 } = require("../utils/audioUtils");

const PORT_RANGE_START = 6006;
const PORT_RANGE_END = 6029;
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const TRANSCRIPTION_TIMEOUT_MS = 300000;
const ONLINE_CHUNK_BYTES = 8000 * 4;
const ONLINE_FINISH_TIMEOUT_MS = 10000;

class ParakeetWsServer {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelName = null;
    this.modelDir = null;
    this.modelRuntime = "offline";
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedBinaryPaths = {};
  }

  getWsBinaryPath(runtime = "offline") {
    if (this.cachedBinaryPaths[runtime]) return this.cachedBinaryPaths[runtime];

    const platformArch = `${process.platform}-${process.arch}`;
    const prefix = runtime === "online" ? "sherpa-onnx-online-ws" : "sherpa-onnx-ws";
    const binaryName =
      process.platform === "win32" ? `${prefix}-${platformArch}.exe` : `${prefix}-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPaths[runtime] = resolved;
    return resolved;
  }

  isAvailable(runtime = "offline") {
    return this.getWsBinaryPath(runtime) !== null;
  }

  hasAnyWsBinary() {
    return this.isAvailable("offline") || this.isAvailable("online");
  }

  async start(modelName, modelDir, runtime = "offline") {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready && this.modelName === modelName) return;
    if (this.process) await this.stop();

    this.startupPromise = this._doStart(modelName, modelDir, runtime);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelName, modelDir, runtime) {
    const wsBinary = this.getWsBinaryPath(runtime);
    if (!wsBinary) throw new Error(`sherpa-onnx ${runtime} WS server binary not found`);
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    this.modelName = modelName;
    this.modelDir = modelDir;
    this.modelRuntime = runtime;

    const threads = Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75)));
    const args = [
      `--tokens=${path.join(modelDir, "tokens.txt")}`,
      `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
      `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
      `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
      `--port=${this.port}`,
      ...(runtime === "online"
        ? [`--num-work-threads=${threads}`, "--warm-up=0"]
        : [`--num-threads=${threads}`]),
    ];

    debugLogger.debug("Starting parakeet WS server", { port: this.port, modelName, runtime, args });

    this.process = spawn(wsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
      detached: process.platform !== "win32",
    });
    sidecarPidFile.write("parakeet", this.process.pid);

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
      sidecarPidFile.clear("parakeet");
      readyResolve(false);
    });

    await this._waitForReady(readyFromStderr, () => ({ stderr: stderrBuffer, exitCode }));
    this._startHealthCheck();

    debugLogger.info("parakeet-ws server started successfully", {
      port: this.port,
      model: modelName,
      runtime,
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

    if (this.modelRuntime === "online") {
      return this._transcribeOnline(samplesBuffer);
    }

    return this._transcribeOffline(samplesBuffer, sampleRate);
  }

  _transcribeOffline(samplesBuffer, sampleRate) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let result = "";

      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("parakeet-ws transcription timed out"));
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

        resolve({ text: parseOfflineMessage(result), elapsed });
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`parakeet-ws transcription failed: ${error.message}`));
      });
    });
  }

  // samplesBuffer must already be 16kHz float32.
  async _transcribeOnline(samplesBuffer) {
    const startTime = Date.now();
    let streamError = null;
    let timedOut = false;

    const stream = this.createOnlineStream({
      onError: (error) => {
        streamError = error;
      },
    });

    debugLogger.debug("parakeet-ws sending streaming audio", {
      samplesBytes: samplesBuffer.length,
    });
    for (let offset = 0; offset < samplesBuffer.length; offset += ONLINE_CHUNK_BYTES) {
      stream.sendFloat32(samplesBuffer.subarray(offset, offset + ONLINE_CHUNK_BYTES));
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      stream.abort();
    }, TRANSCRIPTION_TIMEOUT_MS);
    try {
      const { text } = await stream.finish();
      if (timedOut) throw new Error("parakeet-ws transcription timed out");
      if (streamError) {
        throw new Error(`parakeet-ws transcription failed: ${streamError.message}`);
      }

      const elapsed = Date.now() - startTime;
      debugLogger.debug("parakeet-ws streaming transcription completed", {
        elapsed,
        resultLength: text.length,
        resultPreview: text.slice(0, 200),
      });
      return { text, elapsed };
    } finally {
      clearTimeout(timeout);
    }
  }

  createOnlineStream({ onUpdate, onError } = {}) {
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }
    if (this.modelRuntime !== "online") {
      throw new Error("createOnlineStream requires an online-runtime model");
    }

    const results = createOnlineAccumulator();
    const pendingChunks = [];
    let finishResolve = null;
    let closed = false;
    let lastEmitted = "";

    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

    const settle = () => {
      if (closed) return;
      closed = true;
      if (finishResolve) finishResolve({ text: results.text() });
    };

    const sendFloat32 = (float32Samples) => {
      if (closed || finishResolve) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(float32Samples, (err) => {
          if (err) {
            debugLogger.error("parakeet-ws online stream send error", { error: err.message });
          }
        });
      } else {
        pendingChunks.push(float32Samples);
      }
    };

    ws.on("open", () => {
      for (const chunk of pendingChunks) {
        ws.send(chunk);
      }
      pendingChunks.length = 0;
      if (finishResolve) ws.send("Done");
    });

    ws.on("message", (data) => {
      const message = data.toString();
      if (message === "Done!") {
        ws.close();
        return;
      }
      const text = results.push(message);
      if (!closed && text && text !== lastEmitted) {
        lastEmitted = text;
        onUpdate?.(text);
      }
    });

    ws.on("close", () => settle());

    ws.on("error", (error) => {
      debugLogger.warn("parakeet-ws online stream error", { error: error.message });
      onError?.(error);
      settle();
    });

    return {
      sendFloat32,
      sendPcm16: (pcmBuffer) => sendFloat32(pcm16ToFloat32(pcmBuffer)),
      finish: () =>
        new Promise((resolve) => {
          if (closed) {
            resolve({ text: results.text() });
            return;
          }
          finishResolve = resolve;
          if (ws.readyState === WebSocket.OPEN) ws.send("Done");
          // Backstop in case the server never acknowledges with "Done!".
          setTimeout(() => {
            if (!closed) {
              try {
                ws.close();
              } catch {}
              settle();
            }
          }, ONLINE_FINISH_TIMEOUT_MS).unref?.();
        }),
      abort: () => {
        try {
          ws.close();
        } catch {}
        settle();
      },
    };
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
    this.modelRuntime = "offline";
  }

  getStatus() {
    return {
      available: this.hasAnyWsBinary(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelName: this.modelName,
    };
  }
}

module.exports = ParakeetWsServer;
