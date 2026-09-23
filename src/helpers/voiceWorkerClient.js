const path = require("path");
const { EventEmitter } = require("events");
const { app, utilityProcess, MessageChannelMain } = require("electron");
const debugLogger = require("./debugLogger");

const REQUEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const WORKER_SCRIPT = path.join(__dirname, "..", "workers", "voiceWorker.js");

/**
 * Spike client for the voice worker. Unlike the ONNX worker it streams events
 * (TTS audio, VAD transitions) besides request replies; a crash rejects what is
 * in flight and the next request spawns a fresh worker.
 */
class VoiceWorkerClient extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.port = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.spawnPromise = null;
  }

  get running() {
    return this.child !== null;
  }

  async _spawn() {
    if (this.child) return;
    if (this.spawnPromise) return this.spawnPromise;
    this.spawnPromise = (async () => {
      const env = { ...process.env };
      try {
        env.OPENWHISPR_VOICE_WORKER_LOG = path.join(
          app.getPath("userData"),
          "logs",
          "voice-worker.log"
        );
      } catch {
        // No log path outside a ready app.
      }
      const child = utilityProcess.fork(WORKER_SCRIPT, [], {
        serviceName: "openwhispr-voice",
        stdio: "pipe",
        env,
      });
      const forward = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (line) debugLogger.warn("voice worker output", { line });
        }
      };
      child.stderr?.on("data", forward);
      child.stdout?.on("data", forward);
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const { port1, port2 } = new MessageChannelMain();
      port1.on("message", (event) => this._onMessage(event.data));
      port1.start();
      child.postMessage("init", [port2]);
      child.on("exit", (code) => this._onExit(code));
      this.child = child;
      this.port = port1;
      debugLogger.info("voice worker spawned", { pid: child.pid });
    })();
    try {
      await this.spawnPromise;
    } finally {
      this.spawnPromise = null;
    }
  }

  _onMessage(message) {
    if (message.event) {
      this.emit(message.event, message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timeout);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  }

  _onExit(code) {
    debugLogger.warn("voice worker exited", { code, pending: this.pending.size });
    this.child = null;
    try {
      this.port?.close();
    } catch {
      // Already closed.
    }
    this.port = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("voice worker exited"));
    }
    this.pending.clear();
    this.emit("exit", { code });
  }

  async request(method, payload) {
    await this._spawn();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`voice worker timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.port.postMessage({ id, method, payload });
    });
  }

  /** Fire-and-forget message; dropped when the worker is not running. */
  notify(method, payload) {
    if (!this.port) return;
    this.port.postMessage({ id: 0, method, payload });
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.notify("shutdown", {});
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
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

module.exports = new VoiceWorkerClient();
module.exports.VoiceWorkerClient = VoiceWorkerClient;
