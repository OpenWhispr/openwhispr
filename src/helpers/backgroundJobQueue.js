const { EventEmitter } = require("events");

class BackgroundJobQueue extends EventEmitter {
  constructor() {
    super();
    this._queue = [];
    this._running = false;
    this._activeJob = null;
  }

  get length() {
    return this._queue.length;
  }

  get activeJob() {
    return this._activeJob;
  }

  enqueue(jobId, fn) {
    this._queue.push({ id: jobId, fn });
    if (!this._running) this._process();
  }

  cancelPending() {
    this._queue.length = 0;
  }

  async drain() {
    if (!this._running && this._queue.length === 0) return;
    return new Promise((resolve) => {
      const check = () => {
        if (!this._running && this._queue.length === 0) {
          this.removeListener("_tick", check);
          resolve();
        }
      };
      this.on("_tick", check);
      check();
    });
  }

  async _process() {
    if (this._running) return;
    this._running = true;

    while (this._queue.length > 0) {
      const { id, fn } = this._queue.shift();
      this._activeJob = id;
      this.emit("status", { jobId: id, status: "running" });

      try {
        await fn();
        this.emit("status", { jobId: id, status: "complete" });
      } catch (err) {
        this.emit("status", { jobId: id, status: "error", error: err.message });
      }

      this._activeJob = null;
      this.emit("_tick");
    }

    this._running = false;
    this.emit("_tick");
  }
}

module.exports = { BackgroundJobQueue };
