const path = require("path");
const { app, utilityProcess, MessageChannelMain } = require("electron");
const debugLogger = require("./debugLogger");

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING_REQUESTS = 1000;
const RESPAWN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RESPAWN_ATTEMPTS = 5;
const SHUTDOWN_TIMEOUT_MS = 5000;

const WORKER_SCRIPT = path.join(__dirname, "..", "workers", "onnxWorker.js");

class WorkerCrashedError extends Error {
  constructor(message = "ONNX worker crashed") {
    super(message);
    this.name = "WorkerCrashedError";
  }
}

class WorkerOverloadedError extends Error {
  constructor() {
    super("ONNX worker request queue full");
    this.name = "WorkerOverloadedError";
  }
}

class OnnxWorkerClient {
  constructor() {
    this.child = null;
    this.port = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.crashCount = 0;
    this.shuttingDown = false;
    this.gaveUp = false;
    this.spawnPromise = null;
    this.respawnTimer = null;
  }

  _logPath() {
    try {
      return path.join(app.getPath("userData"), "logs", "onnx-worker.log");
    } catch {
      return null;
    }
  }

  async _spawn() {
    if (this.child) return;
    if (this.spawnPromise) return this.spawnPromise;

    this.spawnPromise = (async () => {
      const env = { ...process.env };
      const logPath = this._logPath();
      if (logPath) env.OPENWHISPR_ONNX_WORKER_LOG = logPath;

      const child = utilityProcess.fork(WORKER_SCRIPT, [], {
        serviceName: "openwhispr-onnx",
        stdio: "pipe",
        env,
        execArgv: ["--max-old-space-size=512"],
      });

      const forwardStderr = (chunk) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line) debugLogger.warn("onnx worker stderr", { line });
        }
      };
      child.stderr?.on("data", forwardStderr);
      child.stdout?.on("data", forwardStderr);

      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener("error", onError);
          resolve();
        };
        const onError = (err) => {
          child.removeListener("spawn", onSpawn);
          reject(err);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });

      const { port1, port2 } = new MessageChannelMain();
      port1.on("message", (event) => this._onMessage(event.data));
      port1.start();

      child.postMessage("init", [port2]);

      child.on("exit", (code) => this._onExit(code));

      this.child = child;
      this.port = port1;
      debugLogger.info("onnx worker spawned", { pid: child.pid });
    })();

    try {
      await this.spawnPromise;
    } finally {
      this.spawnPromise = null;
    }
  }

  _onMessage(reply) {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    clearTimeout(entry.timeout);
    if (reply.error) {
      entry.reject(new Error(reply.error.message));
    } else {
      this.crashCount = 0;
      entry.resolve(reply.result);
    }
  }

  _onExit(code) {
    debugLogger.warn("onnx worker exited", {
      code,
      pending: this.pending.size,
      shuttingDown: this.shuttingDown,
    });

    this.child = null;
    if (this.port) {
      try {
        this.port.close();
      } catch {
        // already closed
      }
      this.port = null;
    }

    const err = new WorkerCrashedError();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this.pending.clear();

    if (this.shuttingDown) return;

    if (code !== 0) {
      this.crashCount += 1;
      if (this.crashCount > MAX_RESPAWN_ATTEMPTS) {
        this.gaveUp = true;
        debugLogger.error("onnx worker giving up", { crashCount: this.crashCount });
        return;
      }
      const delay =
        RESPAWN_BACKOFF_MS[Math.min(this.crashCount - 1, RESPAWN_BACKOFF_MS.length - 1)];
      debugLogger.info("onnx worker respawn scheduled", {
        delayMs: delay,
        crashCount: this.crashCount,
      });
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this._spawn().catch((spawnErr) => {
          debugLogger.error("onnx worker respawn failed", { error: spawnErr?.message });
        });
      }, delay);
    }
  }

  async request(method, payload, transferList) {
    if (this.shuttingDown) {
      throw new WorkerCrashedError("worker shutting down");
    }

    if (this.gaveUp) {
      throw new WorkerCrashedError("worker unavailable");
    }

    if (this.respawnTimer) {
      throw new WorkerCrashedError("worker restarting");
    }

    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldestId = this.pending.keys().next().value;
      const oldest = this.pending.get(oldestId);
      if (oldest) {
        this.pending.delete(oldestId);
        clearTimeout(oldest.timeout);
        oldest.reject(new WorkerOverloadedError());
      }
    }

    await this._spawn();

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`onnx worker request timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.port.postMessage({ id, method, payload }, transferList || []);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async stop() {
    this.shuttingDown = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (!this.child) return;

    const child = this.child;
    try {
      this.port?.postMessage({ id: 0, method: "shutdown", payload: {} });
    } catch {
      // worker may already be gone
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already dead
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const instance = new OnnxWorkerClient();
module.exports = instance;
module.exports.OnnxWorkerClient = OnnxWorkerClient;
module.exports.WorkerCrashedError = WorkerCrashedError;
module.exports.WorkerOverloadedError = WorkerOverloadedError;
