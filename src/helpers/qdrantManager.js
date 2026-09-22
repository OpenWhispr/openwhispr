const { spawn } = require("child_process");
const EventEmitter = require("events");
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
const sidecarPidFile = require("./sidecarPidFile");
const { waitForExit } = require("./sidecarReaper");

const PORT_RANGE_START = 6333;
const PORT_RANGE_END = 6350;
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_POLL_INTERVAL_MS = 100;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
// A wedged qdrant (alive but failing health checks, observed spinning at full
// CPU) is restarted after ~40s of consecutive failures. Restarts are capped
// per session so a genuinely broken binary doesn't crash-loop; note search
// falls back to FTS5 keywords while qdrant is down.
const HEALTH_FAILURES_BEFORE_RESTART = 8;
const MAX_RESTARTS_PER_SESSION = 3;
// gracefulStopProcess can resolve right after sending SIGKILL, so a restart
// verifies the old process is really gone before spawning its replacement.
const RESTART_EXIT_WAIT_MS = 2000;

const STORAGE_DIR = path.join(
  os.homedir(),
  ".cache",
  "openwhispr",
  process.env.NODE_ENV === "development" ? "qdrant-data-dev" : "qdrant-data"
);

// Emits "restarted" (port) after a successful unhealthy-restart so the
// composition root can re-wire clients (the replacement may be on a new port).
class QdrantManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.port = null;
    this.ready = false;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedBinaryPath = null;
    this.consecutiveHealthFailures = 0;
    this.restartCount = 0;
    this.restarting = false;
    this.stopRequested = false;
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
    // Only this public entry clears a deliberate stop; the restart path must
    // not resurrect a stopRequested that an app quit set mid-restart.
    this.stopRequested = false;
    await this._start();
  }

  async _start() {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready) return;
    if (this.process) await this._stopProcess();

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

    // A deliberate stop (app quit) can land during the port scan, when there
    // is no process for it to kill; abort instead of spawning a child that
    // outlives the app.
    if (this.stopRequested) {
      this.port = null;
      debugLogger.debug("qdrant start aborted by stop request");
      return;
    }

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
      "log_level: warn",
      "",
    ].join("\n");

    fs.writeFileSync(configPath, configContent, "utf-8");

    debugLogger.debug("Starting qdrant", {
      port: this.port,
      binaryPath,
      configPath,
      storagePath,
    });

    const child = spawn(binaryPath, ["--config-path", configPath], {
      cwd: STORAGE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.process = child;
    sidecarPidFile.write("qdrant", child.pid);

    let stderrBuffer = "";
    let lastErrorLine = "";
    let exitCode = null;

    child.stdout.on("data", (data) => {
      const text = data.toString();
      debugLogger.debug("qdrant stdout", { data: text.trim() });
      const errorLine = text.split("\n").findLast((line) => line.includes(" ERROR "));
      if (errorLine) lastErrorLine = errorLine.trim();
    });

    child.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      debugLogger.debug("qdrant stderr", { data: data.toString().trim() });
    });

    child.on("error", (error) => {
      debugLogger.error("qdrant process error", { error: error.message });
      if (this.process === child) this.ready = false;
    });

    child.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("qdrant process exited", { code });
      // A straggler close from a child already replaced by a restart must not
      // clobber the new process's state or pid entry.
      if (this.process !== child) return;
      this.ready = false;
      this.process = null;
      this._stopHealthCheck();
      sidecarPidFile.clear("qdrant");
    });

    await this._waitForReady(() => ({ stderr: stderrBuffer, lastErrorLine, exitCode }));
    this._startHealthCheck();

    debugLogger.info("qdrant started successfully", { port: this.port });
  }

  async _waitForReady(getProcessInfo) {
    const startTime = Date.now();
    let pollCount = 0;

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const details =
          info.lastErrorLine ||
          (info.stderr ? info.stderr.trim() : "") ||
          (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(
          `qdrant process died during startup${details ? `: ${details.slice(0, 400)}` : ""}`
        );
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
    this.consecutiveHealthFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this._stopHealthCheck();
        return;
      }
      if (await this._checkHealth()) {
        this.consecutiveHealthFailures = 0;
        return;
      }
      this.consecutiveHealthFailures++;
      debugLogger.warn("qdrant health check failed", {
        consecutiveFailures: this.consecutiveHealthFailures,
      });
      this.ready = false;
      if (this.consecutiveHealthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
        this._restartUnhealthy();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  _stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // Never rejects; called fire-and-forget from the health-check interval.
  async _restartUnhealthy() {
    if (this.restarting) return;
    this.restarting = true;
    try {
      if (this.restartCount >= MAX_RESTARTS_PER_SESSION) {
        await this._stopProcess();
        debugLogger.warn(
          "qdrant still unhealthy after max restarts, leaving it stopped (note search falls back to FTS5 keywords)",
          { maxRestarts: MAX_RESTARTS_PER_SESSION }
        );
        return;
      }
      this.restartCount++;
      debugLogger.warn("qdrant unresponsive, restarting", {
        attempt: this.restartCount,
        maxRestarts: MAX_RESTARTS_PER_SESSION,
      });
      const pid = this.process?.pid;
      await this._stopProcess();
      if (pid && !(await waitForExit(pid, RESTART_EXIT_WAIT_MS))) {
        // Mirror the reaper's policy: keep the pid entry so the next launch retries.
        sidecarPidFile.write("qdrant", pid);
        debugLogger.error("qdrant survived SIGKILL, not restarting", { pid });
        return;
      }
      if (this.stopRequested) return; // a deliberate stop (app quit) raced the restart
      await this._start();
      if (this.ready) this.emit("restarted", this.port);
    } catch (error) {
      // _doStart can reject after spawning (e.g. startup timeout); make sure
      // the replacement really is stopped, not left running unsupervised.
      await this._stopProcess();
      debugLogger.warn("qdrant restart failed, leaving it stopped", { error: error.message });
    } finally {
      this.restarting = false;
    }
  }

  async stop() {
    // A deliberate stop also cancels any in-flight unhealthy restart.
    this.stopRequested = true;
    await this._stopProcess();
  }

  async _stopProcess() {
    this._stopHealthCheck();

    const child = this.process;
    if (!child) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping qdrant");

    try {
      await gracefulStopProcess(child);
    } catch (error) {
      debugLogger.error("Error stopping qdrant", { error: error.message });
    }

    // On the SIGKILL escalation path gracefulStopProcess resolves before
    // 'close' fires, so clean up here; the close handler's guard skips the
    // straggler event.
    if (this.process === child) {
      this.process = null;
      sidecarPidFile.clear("qdrant");
    }
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
module.exports.HEALTH_FAILURES_BEFORE_RESTART = HEALTH_FAILURES_BEFORE_RESTART;
module.exports.MAX_RESTARTS_PER_SESSION = MAX_RESTARTS_PER_SESSION;
