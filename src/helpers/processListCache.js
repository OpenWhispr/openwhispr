const debugLogger = require("./debugLogger");

const CACHE_TTL_MS = 5000;

class ProcessListCache {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._pending = null;
  }

  async getProcessList() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < CACHE_TTL_MS) {
      return this._cache;
    }

    if (this._pending) return this._pending;

    this._pending = this._fetch(now);
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async _fetch(now) {
    try {
      const psList = (await import("ps-list")).default;
      const procs = await psList();
      const names = procs.map((p) => (p.name || "").toLowerCase());
      this._cache = names;
      this._cacheTime = now;
      debugLogger.debug("Process list refreshed", { count: names.length }, "meeting");
      return names;
    } catch (err) {
      debugLogger.warn("Failed to fetch process list", { error: err.message }, "meeting");
      return [];
    }
  }

  invalidate() {
    this._cache = null;
    this._cacheTime = 0;
    this._pending = null;
  }
}

module.exports = new ProcessListCache();
