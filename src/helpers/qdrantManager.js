const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const debugLogger = require("./debugLogger");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
} = require("../utils/serverUtils");

const PORT_RANGE_START = 6333;
const PORT_RANGE_END = 6350;
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_POLL_INTERVAL_MS = 100;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

const STORAGE_DIR = path.join(os.homedir(), ".cache", "openwhispr", "qdrant-data");

class QdrantManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedBinaryPath = null;
  }

  getBinaryPath() {
    if (this.cachedBinaryPath) return this.cachedBinaryPath;

    const platformArch = `${process.platform}-${process.arch}`;
    const binaryName =
      process.platform === "win32" ? `qdrant-${platformArch}.exe` : `qdrant-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    return this.getBinaryPath() !== null;
  }

  async start() {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready) return;
    if (this.process) await this.stop();

    this.startupPromise = this._doStart();
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart() {
    const binaryPath = this.getBinaryPath();
    if (!binaryPath) throw new Error("qdrant binary not found");

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);

    fs.mkdirSync(STORAGE_DIR, { recursive: true });

    const configPath = path.join(STORAGE_DIR, "config.yaml");
    const storagePath = path.join(STORAGE_DIR, "storage");
    const configContent = [
      "storage:",
      `  storage_path: ${storagePath}`,
      "service:",
      "  host: 127.0.0.1",
      `  http_port: ${this.port}`,
      `  grpc_port: ${this.port + 1}`,
      "",
    ].join("\n");

    fs.writeFileSync(configPath, configContent, "utf-8");

    debugLogger.debug("Starting qdrant", {
      port: this.port,
      binaryPath,
      configPath,
      storagePath,
    });

    this.process = spawn(binaryPath, ["--config-path", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
      debugLogger.debug("qdrant stdout", { data: data.toString().trim() });
    });

    this.process.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      debugLogger.debug("qdrant stderr", { data: data.toString().trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("qdrant process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("qdrant process exited", { code });
      this.ready = false;
      this.process = null;
      this._stopHealthCheck();
    });

    await this._waitForReady(() => ({ stderr: stderrBuffer, exitCode }));
    this._startHealthCheck();

    debugLogger.info("qdrant started successfully", { port: this.port });
  }

  async _waitForReady(getProcessInfo) {
    const startTime = Date.now();
    let pollCount = 0;

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(`qdrant process died during startup${details ? `: ${details}` : ""}`);
      }

      pollCount++;
      if (await this._checkHealth()) {
        this.ready = true;
        debugLogger.debug("qdrant ready", {
          startupTimeMs: Date.now() - startTime,
          pollCount,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
    }

    throw new Error(`qdrant failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  _checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/healthz",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(true);
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

  _startHealthCheck() {
    this._stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this._stopHealthCheck();
        return;
      }
      if (!(await this._checkHealth())) {
        debugLogger.warn("qdrant health check failed");
        this.ready = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  _stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async stop() {
    this._stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping qdrant");

    try {
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping qdrant", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
  }

  isReady() {
    return this.ready;
  }

  getPort() {
    return this.port;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
    };
  }
}

module.exports = QdrantManager;
