const fs = require("fs");
const path = require("path");

class CliAgentSessionStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  _writeAll(all) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(all));
  }

  get(cliId, maxAgeMinutes) {
    if (!maxAgeMinutes || maxAgeMinutes <= 0) return null;
    const entry = this._readAll()[cliId];
    if (!entry?.sessionId || typeof entry.ts !== "number") return null;
    if (Date.now() - entry.ts > maxAgeMinutes * 60_000) return null;
    return entry.sessionId;
  }

  set(cliId, sessionId) {
    const all = this._readAll();
    all[cliId] = { sessionId, ts: Date.now() };
    this._writeAll(all);
  }

  clear(cliId) {
    const all = this._readAll();
    delete all[cliId];
    this._writeAll(all);
  }
}

module.exports = { CliAgentSessionStore };
