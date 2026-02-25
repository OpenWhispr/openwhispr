const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const { getSafeTempDir } = require("./safeTempDir");
const { app } = require("electron");

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8220;
const STARTUP_TIMEOUT_MS = 60000;
const VULKAN_STARTUP_TIMEOUT_MS = 15000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;

class LlamaServerManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.healthCheckFailures = 0;
    this.cachedServerBinaryPaths = null;
    this.activeBackend = null;
  }

  getServerBinaryPaths() {
    if (this.cachedServerBinaryPaths) return this.cachedServerBinaryPaths;

    const platform = process.platform;
    const arch = process.arch;
    const platformArch = `${platform}-${arch}`;
    const ext = platform === "win32" ? ".exe" : "";

    const resolveBinary = (name) => {
      const candidates = [];
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, "bin", name));
      }
      candidates.push(path.join(__dirname, "..", "..", "resources", "bin", name));

      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) {
            fs.statSync(candidate);
            return candidate;
          }
        } catch {
          // Can't access binary
        }
      }
      return null;
    };

    let paths;

    if (platform === "darwin") {
      const defaultBin =
        resolveBinary(`llama-server-${platformArch}`) || resolveBinary(`llama-server${ext}`);
      paths = defaultBin ? { default: defaultBin } : {};
    } else {
      const userBinDir = path.join(app.getPath("userData"), "bin");
      const vulkanName = `llama-server-vulkan${ext}`;
      let vulkanBin = null;
      try {
        const vulkanPath = path.join(userBinDir, vulkanName);
        if (fs.existsSync(vulkanPath)) vulkanBin = vulkanPath;
      } catch {}

      const cpuBin =
        resolveBinary(`llama-server-${platformArch}-cpu${ext}`) ||
        resolveBinary(`llama-server-${platformArch}${ext}`) ||
        resolveBinary(`llama-server${ext}`);

      paths = {};
      if (vulkanBin) paths.vulkan = vulkanBin;
      if (cpuBin) paths.cpu = cpuBin;
    }

    this.cachedServerBinaryPaths = paths;
    return paths;
  }

  isAvailable() {
    const paths = this.getServerBinaryPaths();
    return Object.keys(paths).length > 0;
  }

  async findAvailablePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await this.isPortAvailable(port)) return port;
    }
    throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close();
        resolve(true);
      });
      server.listen(port, "127.0.0.1");
    });
  }

  async start(modelPath, options = {}) {
    if (this.startupPromise) return this.startupPromise;

    if (this.ready && this.modelPath === modelPath) return;

    if (this.process) {
      await this.stop();
    }

    this.startupPromise = this._doStart(modelPath, options);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelPath, options = {}) {
    const binaryPaths = this.getServerBinaryPaths();
    if (Object.keys(binaryPaths).length === 0) throw new Error("llama-server binary not found");
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

    this.port = await this.findAvailablePort();
    this.modelPath = modelPath;

    const baseArgs = [
      "--model",
      modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(this.port),
      "--ctx-size",
      String(options.contextSize || 4096),
      "--threads",
      String(options.threads || 4),
    ];

    if (process.platform === "darwin") {
      const args = [...baseArgs, "--n-gpu-layers", "99"];
      await this._startWithBinary(
        binaryPaths.default,
        args,
        this._buildEnv(binaryPaths.default),
        STARTUP_TIMEOUT_MS
      );
      this.activeBackend = "metal";
      this._saveGpuBackend("metal");
    } else {
      await this._startWithGpuFallback(binaryPaths, baseArgs, options);
    }

    this.startHealthCheck();
    debugLogger.info("llama-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
      backend: this.activeBackend,
    });
  }

  async _startWithGpuFallback(binaryPaths, baseArgs, options) {
    const cached = this._loadGpuBackend();
    const gpuArgs = [...baseArgs, "--n-gpu-layers", "99"];
    const cpuArgs = baseArgs;

    if (cached !== "cpu" && binaryPaths.vulkan) {
      try {
        debugLogger.debug("Attempting Vulkan backend startup");
        await this._startWithBinary(
          binaryPaths.vulkan,
          gpuArgs,
          this._buildEnv(binaryPaths.vulkan),
          VULKAN_STARTUP_TIMEOUT_MS
        );
        this.activeBackend = "vulkan";
        this._saveGpuBackend("vulkan");
        return;
      } catch (err) {
        debugLogger.warn("Vulkan backend failed, falling back to CPU", { error: err.message });
        await this._killCurrentProcess();
        this.port = await this.findAvailablePort();
      }
    }

    if (!binaryPaths.cpu) throw new Error("No CPU llama-server binary available");

    debugLogger.debug("Starting with CPU backend");
    await this._startWithBinary(
      binaryPaths.cpu,
      cpuArgs,
      this._buildEnv(binaryPaths.cpu),
      STARTUP_TIMEOUT_MS
    );
    this.activeBackend = "cpu";
    this._saveGpuBackend("cpu");
  }

  _buildEnv(binaryPath) {
    const binDir = path.dirname(binaryPath);
    const env = { ...process.env };

    if (process.platform === "darwin") {
      env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");
    } else if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
    } else if (process.platform === "win32") {
      env.PATH = binDir + (env.PATH ? `;${env.PATH}` : "");
    }

    return env;
  }

  _startWithBinary(binaryPath, args, env, timeoutMs) {
    return new Promise((resolve, reject) => {
      debugLogger.debug("Spawning llama-server", { binary: binaryPath, port: this.port, args });

      this.process = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: getSafeTempDir(),
        env,
      });

      let stderrBuffer = "";
      let exitCode = null;
      let exitSignal = null;
      let settled = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      this.process.stdout.on("data", (data) => {
        debugLogger.debug("llama-server stdout", { data: data.toString().trim() });
      });

      this.process.stderr.on("data", (data) => {
        stderrBuffer += data.toString();
        debugLogger.debug("llama-server stderr", { data: data.toString().trim() });
      });

      this.process.on("error", (error) => {
        debugLogger.error("llama-server process error", { error: error.message });
        this.ready = false;
        settle(() => reject(new Error(`Failed to spawn llama-server: ${error.message}`)));
      });

      this.process.on("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        debugLogger.debug("llama-server process exited", { code, signal });
        this.ready = false;
        this.process = null;
        this.stopHealthCheck();
      });

      const getProcessInfo = () => ({ stderr: stderrBuffer, exitCode, exitSignal });

      const startTime = Date.now();
      let pollCount = 0;

      const poll = async () => {
        if (settled) return;

        if (!this.process || this.process.killed) {
          const info = getProcessInfo();
          const signal = info.exitSignal;
          const diagParts = [];
          if (signal) diagParts.push(`signal: ${signal}`);
          else if (info.exitCode !== null && info.exitCode !== undefined)
            diagParts.push(`exit code: ${info.exitCode}`);
          const oomHint =
            signal === "SIGKILL"
              ? " — the process was killed by the OS, likely due to insufficient memory. Try a smaller/more quantized model, or reduce the context size."
              : "";
          const stderr = info.stderr ? info.stderr.trim().slice(-800) : "";
          const diagStr = diagParts.length ? ` (${diagParts.join(", ")})` : "";
          settle(() =>
            reject(
              new Error(
                `llama-server process died during startup${diagStr}${oomHint}${stderr ? `\nProcess output: ${stderr}` : ""}`
              )
            )
          );
          return;
        }

        pollCount++;
        if (await this.checkHealth()) {
          this.ready = true;
          debugLogger.debug("llama-server ready", {
            startupTimeMs: Date.now() - startTime,
            pollCount,
          });
          settle(() => resolve());
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          settle(() => reject(new Error(`llama-server failed to start within ${timeoutMs}ms`)));
          return;
        }

        setTimeout(poll, STARTUP_POLL_INTERVAL_MS);
      };

      poll();
    });
  }

  async _killCurrentProcess() {
    if (!this.process) return;

    this.stopHealthCheck();

    try {
      killProcess(this.process, "SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) killProcess(this.process, "SIGKILL");
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error killing llama-server process", { error: error.message });
    }

    this.process = null;
    this.ready = false;
  }

  _loadGpuBackend() {
    const val = process.env.LLAMA_GPU_BACKEND;
    if (val === "vulkan" || val === "cpu" || val === "metal") return val;
    return null;
  }

  _saveGpuBackend(backend) {
    process.env.LLAMA_GPU_BACKEND = backend;
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/health",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this.process) {
          this.stopHealthCheck();
          return;
        }
        if (await this.checkHealth()) {
          this.healthCheckFailures = 0;
        } else {
          this.healthCheckFailures++;
          if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
            debugLogger.warn("llama-server health check failed", {
              consecutiveFailures: this.healthCheckFailures,
            });
            this.ready = false;
          }
        }
      } catch (err) {
        debugLogger.error("Health check error", { error: err.message });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async inference(messages, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("llama-server is not running");
    }

    const body = JSON.stringify({
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 512,
      stream: false,
    });

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 300000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            debugLogger.debug("llama-server inference completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
            });

            if (res.statusCode !== 200) {
              reject(new Error(`llama-server returned status ${res.statusCode}: ${data}`));
              return;
            }

            try {
              const response = JSON.parse(data);
              const text = response.choices?.[0]?.message?.content || "";
              resolve(text.trim());
            } catch (e) {
              reject(new Error(`Failed to parse llama-server response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", (error) => {
        reject(new Error(`llama-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("llama-server request timed out"));
      });

      req.write(body);
      req.end();
    });
  }

  async stop() {
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping llama-server");

    try {
      killProcess(this.process, "SIGTERM");

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            killProcess(this.process, "SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error stopping llama-server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
    this.activeBackend = null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".gguf") : null,
      backend: this.activeBackend,
      gpuAccelerated: this.activeBackend === "vulkan" || this.activeBackend === "metal",
    };
  }

  resetGpuDetection() {
    delete process.env.LLAMA_GPU_BACKEND;
    this.activeBackend = null;
    this.cachedServerBinaryPaths = null;
  }
}

module.exports = LlamaServerManager;
