/**
 * WindowsLayoutProbe - asks `windows-key-listener.exe --layout-server` which keyboard
 * layout the foreground window uses. The helper stays alive between dictations and
 * answers one stdout line per "QUERY" line, so a capture costs a pipe write and the
 * reply is usually ready before recording starts.
 */

const { spawn: nodeSpawn } = require("child_process");
const debugLogger = require("./debugLogger");

const REPLY_TIMEOUT_MS = 300;
const RESPAWN_INTERVAL_MS = 5000;

function parseLayoutLine(line) {
  const error = /^LAYOUT_ERROR\s+(\S+)/.exec(line);
  if (error) return { ok: false, reason: error[1] };

  const layout = /^LAYOUT\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
  if (layout) return { ok: true, klid: layout[1], iso: layout[2], layoutName: layout[3] };

  return null;
}

class WindowsLayoutProbe {
  constructor({ spawn = nodeSpawn, resolveBinary, platform, now = Date.now } = {}) {
    this.spawn = spawn;
    this.resolveBinary = resolveBinary || defaultResolveBinary;
    this.platform = platform || process.platform;
    this.now = now;
    this.child = null;
    this.lastSpawnAt = -Infinity;
    this.pending = []; // FIFO of in-flight queries, oldest first
    this.buffer = "";
    this.lastCapture = null;
  }

  // Sends the query synchronously so it runs before OpenWhispr can take focus.
  capture() {
    if (this.platform !== "win32") {
      this.lastCapture = Promise.resolve({ ok: false, reason: "unsupported-platform" });
      return;
    }

    if (!this._ensureChild()) {
      this.lastCapture = Promise.resolve({ ok: false, reason: "helper-unavailable" });
      return;
    }

    const entry = { settled: false };
    entry.promise = new Promise((resolve) => {
      entry.resolve = (result) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        resolve(result);
      };
    });
    // A timed-out entry stays queued so a late reply still lines up with its query.
    entry.timer = setTimeout(
      () => entry.resolve({ ok: false, reason: "timeout" }),
      REPLY_TIMEOUT_MS
    );

    this.pending.push(entry);
    this.lastCapture = entry.promise;
    try {
      this.child.stdin.write("QUERY\n");
    } catch (error) {
      this._onChildGone(this.child, error.message);
    }
  }

  getLastCapture() {
    return this.lastCapture || Promise.resolve({ ok: false, reason: "not-captured" });
  }

  stop() {
    const child = this.child;
    this._onChildGone(child, "stopped");
    if (child) child.kill();
  }

  _ensureChild() {
    if (this.child) return true;
    if (this.now() - this.lastSpawnAt < RESPAWN_INTERVAL_MS) return false;
    this.lastSpawnAt = this.now();

    const binary = this.resolveBinary();
    if (!binary) return false;

    let child;
    try {
      child = this.spawn(binary, ["--layout-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      debugLogger.warn("[WindowsLayoutProbe] spawn failed", { error: error.message });
      return false;
    }

    this.child = child;
    this.buffer = "";
    if (child.stdout.setEncoding) child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr?.on("data", () => {});
    child.stdin.on("error", () => this._onChildGone(child, "stdin-error"));
    child.on("error", (error) => this._onChildGone(child, error.message));
    child.on("exit", (code) => this._onChildGone(child, `exit ${code}`));
    return true;
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (const line of lines) {
      const result = parseLayoutLine(line.trim());
      if (!result) continue; // READY and anything else
      debugLogger.debug("[WindowsLayoutProbe] reply", { ...result, pending: this.pending.length });
      const entry = this.pending.shift();
      if (entry) entry.resolve(result);
    }
  }

  _onChildGone(child, detail) {
    if (child && this.child !== child) return;
    if (child) debugLogger.debug("[WindowsLayoutProbe] helper gone", { detail });
    this.child = null;
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) entry.resolve({ ok: false, reason: "helper-exited" });
  }
}

function defaultResolveBinary() {
  // resolveListenerBinary only inspects the filesystem, so it needs no manager instance.
  const WindowsKeyManager = require("./windowsKeyManager");
  return WindowsKeyManager.prototype.resolveListenerBinary.call(null);
}

module.exports = { WindowsLayoutProbe, parseLayoutLine };
