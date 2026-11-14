const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { resolveBundledBinary } = require("./binaryResolver");

const BINARY_NAME = "windows-dictation-audio-guard.exe";
const COMMAND_TIMEOUT_MS = 6000;
const FORWARD_RETRY_MS = 5000;

// Virtual devices that ship a render side for apps to play into and a capture
// side for call apps to pick as their microphone. Matched against the render
// endpoint's name when the user hasn't picked one.
const KNOWN_VIRTUAL_INPUTS = [/^CABLE Input\b/i, /^VoiceMeeter Input\b/i, /^CABLE-A Input\b/i];

const DEFAULT_CONFIG = Object.freeze({
  duckEnabled: false,
  duckPercent: 10,
  callMicGateEnabled: false,
  callMicSourceId: "default",
  callMicTargetId: "",
});

function clampPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.duckPercent;
  return Math.min(99, Math.max(0, n));
}

// Endpoint ids from the helper are `{0.0.x.00000000}.{guid}`; anything else is
// refused so a stored value can never smuggle extra tokens into a command line.
function isEndpointId(value) {
  return typeof value === "string" && /^\{[0-9.]+\}\.\{[0-9a-fA-F-]{36}\}$/.test(value);
}

function normalizeConfig(input = {}) {
  return {
    duckEnabled: input.duckEnabled === true,
    duckPercent: clampPercent(input.duckPercent ?? DEFAULT_CONFIG.duckPercent),
    callMicGateEnabled: input.callMicGateEnabled === true,
    callMicSourceId: isEndpointId(input.callMicSourceId) ? input.callMicSourceId : "default",
    callMicTargetId: isEndpointId(input.callMicTargetId) ? input.callMicTargetId : "",
  };
}

function parseDeviceLine(line) {
  const match = line.match(/^DEVICE (capture|render) ([01]) (\S+)\t(.*)$/);
  if (!match) return null;
  return { flow: match[1], isDefault: match[2] === "1", id: match[3], name: match[4] };
}

function pickVirtualTarget(renderDevices) {
  for (const pattern of KNOWN_VIRTUAL_INPUTS) {
    const found = renderDevices.find((device) => pattern.test(device.name));
    if (found) return found;
  }
  return null;
}

/**
 * Owns windows-dictation-audio-guard.exe (resources/windows-dictation-audio-guard.c):
 * lowers other apps while a dictation records, and keeps the call microphone gate
 * (real mic forwarded into a virtual device, silenced during dictation).
 *
 * One helper process, spawned on first use and kept while a feature is on. Commands
 * are serialized; the helper restores every ducked volume and stops the forward when
 * its stdin closes or this process exits, so a crash can never leave calls muted.
 */
class DictationAudioGuard {
  constructor({
    platform = process.platform,
    rootPid = process.pid,
    spawnImpl = spawn,
    resolveBinary = () => resolveBundledBinary(BINARY_NAME, "audio-guard"),
    logger = debugLogger,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.platform = platform;
    this.rootPid = rootPid;
    this.spawnImpl = spawnImpl;
    this.resolveBinary = resolveBinary;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.config = { ...DEFAULT_CONFIG };
    this.child = null;
    this.buffer = "";
    this.pending = []; // { expect, collect, lines, resolve, timer }
    this.queue = Promise.resolve();
    this.forwarding = false;
    this.forwardTargetName = null;
    this.forwardError = null;
    this.dictationActive = false;
    this.retryTimer = null;
    this.stopped = false;
  }

  isSupported() {
    return this.platform === "win32" && !!this.resolveBinary();
  }

  getStatus() {
    return {
      supported: this.isSupported(),
      forwarding: this.forwarding,
      forwardTargetName: this.forwardTargetName,
      forwardError: this.forwardError,
    };
  }

  // ---- process ----

  _ensureChild() {
    if (this.child) return true;
    if (this.stopped || this.platform !== "win32") return false;
    const binary = this.resolveBinary();
    if (!binary) return false;

    let child;
    try {
      child = this.spawnImpl(binary, ["--parent", String(this.rootPid)], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.logger.warn("Audio guard failed to start", { error: error.message }, "audio-guard");
      return false;
    }
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr?.on("data", (chunk) =>
      this.logger.debug("Audio guard stderr", { text: String(chunk).trim() }, "audio-guard")
    );
    child.on("error", (error) =>
      this.logger.warn("Audio guard process error", { error: error.message }, "audio-guard")
    );
    child.on("exit", (code) => this._onExit(child, code));
    return true;
  }

  _onExit(child, code) {
    if (this.child !== child) return;
    this.child = null;
    const wasForwarding = this.forwarding;
    this.forwarding = false;
    for (const entry of this.pending.splice(0)) {
      this.clearTimer(entry.timer);
      entry.resolve({ ok: false, error: "exited" });
    }
    this.logger.warn("Audio guard exited", { code }, "audio-guard");
    // The helper restored everything on its way out; bring the call mic back.
    if (wasForwarding && !this.stopped) this._scheduleForwardRetry();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    if (line.startsWith("READY")) return;
    if (line.startsWith("FORWARD_LOST")) {
      this.forwarding = false;
      this.forwardError = line.slice("FORWARD_LOST".length).trim() || "lost";
      this.logger.warn("Call mic forward lost", { reason: this.forwardError }, "audio-guard");
      this._scheduleForwardRetry();
      return;
    }
    const entry = this.pending[0];
    if (!entry) return;
    if (entry.collect && line.startsWith(entry.collect)) {
      entry.lines.push(line);
      return;
    }
    if (line.startsWith(entry.expect) || line.startsWith("ERROR")) {
      this.pending.shift();
      this.clearTimer(entry.timer);
      const ok = line.startsWith(entry.expect);
      entry.resolve({ ok, line, lines: entry.lines, error: ok ? null : line.slice(6) });
    }
  }

  // Runs one command after the previous one settled; never rejects.
  _command(text, expect, { collect = null } = {}) {
    const run = () =>
      new Promise((resolve) => {
        if (!this._ensureChild()) {
          resolve({ ok: false, error: "unavailable" });
          return;
        }
        const entry = { expect, collect, lines: [], resolve, timer: null };
        entry.timer = this.setTimer(() => {
          const index = this.pending.indexOf(entry);
          if (index !== -1) this.pending.splice(index, 1);
          this.logger.warn("Audio guard command timed out", { command: text }, "audio-guard");
          resolve({ ok: false, error: "timeout" });
          // A helper that stopped answering is replaced; its exit restores audio.
          this.child?.kill();
        }, COMMAND_TIMEOUT_MS);
        this.pending.push(entry);
        try {
          this.child.stdin.write(`${text}\n`);
        } catch (error) {
          this.pending.splice(this.pending.indexOf(entry), 1);
          this.clearTimer(entry.timer);
          resolve({ ok: false, error: error.message });
        }
      });
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  // ---- devices ----

  async listDevices() {
    if (this.platform !== "win32") return { capture: [], render: [] };
    const result = await this._command("LIST", "LISTED", { collect: "DEVICE" });
    const devices = { capture: [], render: [] };
    if (!result.ok) return devices;
    for (const line of result.lines) {
      const device = parseDeviceLine(line);
      if (device) devices[device.flow].push(device);
    }
    return devices;
  }

  // ---- configuration ----

  async configure(input) {
    const next = normalizeConfig(input);
    const previous = this.config;
    this.config = next;

    const gateChanged =
      next.callMicGateEnabled !== previous.callMicGateEnabled ||
      next.callMicSourceId !== previous.callMicSourceId ||
      next.callMicTargetId !== previous.callMicTargetId;
    if (gateChanged || (next.callMicGateEnabled && !this.forwarding && !this.retryTimer)) {
      await this._applyForward();
    }
    if (!next.callMicGateEnabled && !next.duckEnabled && !this.dictationActive) {
      this._stopChild();
    }
    return this.getStatus();
  }

  async _applyForward() {
    this._clearRetry();
    if (!this.config.callMicGateEnabled) {
      if (this.forwarding) await this._command("UNFORWARD", "UNFORWARDED");
      this.forwarding = false;
      this.forwardTargetName = null;
      this.forwardError = null;
      return;
    }
    if (this.platform !== "win32") return;

    let targetId = this.config.callMicTargetId;
    let targetName = null;
    const devices = await this.listDevices();
    if (targetId) {
      targetName = devices.render.find((device) => device.id === targetId)?.name ?? null;
    } else {
      const virtual = pickVirtualTarget(devices.render);
      targetId = virtual?.id ?? "";
      targetName = virtual?.name ?? null;
    }
    if (!targetId || !targetName) {
      this.forwarding = false;
      this.forwardError = "no-virtual-device";
      this.logger.warn("Call mic gate: no virtual device found", {}, "audio-guard");
      return;
    }

    const result = await this._command(
      `FORWARD ${this.config.callMicSourceId} ${targetId}`,
      "FORWARDING"
    );
    this.forwarding = result.ok;
    this.forwardTargetName = result.ok ? targetName : null;
    this.forwardError = result.ok ? null : result.error;
    if (result.ok) {
      this.logger.info("Call mic forward started", { target: targetName }, "audio-guard");
      // A dictation that began while the forward was down starts out silent.
      if (this.dictationActive) await this._command("GATE 1", "GATED");
    } else {
      this.logger.warn("Call mic forward failed", { error: result.error }, "audio-guard");
      this._scheduleForwardRetry();
    }
  }

  _scheduleForwardRetry() {
    if (this.retryTimer || this.stopped || !this.config.callMicGateEnabled) return;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (!this.forwarding && this.config.callMicGateEnabled) void this._applyForward();
    }, FORWARD_RETRY_MS);
  }

  _clearRetry() {
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // ---- dictation lifecycle ----

  // Called when a dictation's recording starts. Idempotent.
  async beginDictation() {
    if (this.dictationActive || this.platform !== "win32") return false;
    this.dictationActive = true;
    const { callMicGateEnabled, duckEnabled, duckPercent } = this.config;
    if (callMicGateEnabled && this.forwarding) await this._command("GATE 1", "GATED");
    if (duckEnabled) await this._command(`DUCK ${duckPercent} ${this.rootPid}`, "DUCKED");
    return true;
  }

  // Called when the recording ends (stop, cancel, error, teardown). Idempotent.
  async endDictation() {
    if (!this.dictationActive) return false;
    this.dictationActive = false;
    if (!this.child) return true;
    await this._command("GATE 0", "GATED");
    await this._command("UNDUCK", "UNDUCKED");
    if (!this.config.callMicGateEnabled && !this.config.duckEnabled) this._stopChild();
    return true;
  }

  _stopChild() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.forwarding = false;
    try {
      child.stdin.end("QUIT\n");
    } catch {
      child.kill();
    }
  }

  // App shutdown: the helper restores volumes and stops the forward on QUIT.
  stop() {
    this.stopped = true;
    this._clearRetry();
    this._stopChild();
  }
}

module.exports = {
  DictationAudioGuard,
  normalizeConfig,
  parseDeviceLine,
  pickVirtualTarget,
  isEndpointId,
  DEFAULT_CONFIG,
};

let sharedInstance = null;

// The main process's one guard, created on first use.
function getDictationAudioGuard() {
  if (!sharedInstance) sharedInstance = new DictationAudioGuard();
  return sharedInstance;
}

// For will-quit: stops the guard only if something ever started it.
function stopDictationAudioGuard() {
  sharedInstance?.stop();
}

module.exports.getDictationAudioGuard = getDictationAudioGuard;
module.exports.stopDictationAudioGuard = stopDictationAudioGuard;
