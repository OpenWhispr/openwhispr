const { spawn, spawnSync } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const EXACT_MODIFIERS_FLAG = "--exact-modifiers";
const EXACT_MODIFIERS_PROBE = "--supports-exact-modifiers";
const EXACT_MODIFIERS_READY = "EXACT_MODIFIERS_READY";

const INPUT_DIR = "/dev/input";
const INPUT_SYSFS_DIR = "/sys/class/input";
// linux/input-event-codes.h
const EV_KEY = 1n;
const KEY_A = 30n;

// is_keyboard_device() in linux-key-listener.c, read from sysfs, where the kernel
// prints the capability bitmaps its ioctl returns: hex words, most significant
// first, so the bits wanted here sit in the last word (BigInt, since a 64-bit
// word overflows a double). When sysfs cannot say, as in a sandbox without /sys,
// the node counts as a keyboard rather than refuse a hotkey it may serve.
function couldBeKeyboard(device) {
  const capabilities = path.join(INPUT_SYSFS_DIR, device, "device", "capabilities");
  const hasBit = (bitmap, bit) => {
    const words = fs.readFileSync(path.join(capabilities, bitmap), "utf8").trim().split(" ");
    return ((BigInt(`0x${words.at(-1)}`) >> bit) & 1n) === 1n;
  };
  try {
    return hasBit("ev", EV_KEY) && hasBit("key", KEY_A);
  } catch {
    return true;
  }
}

// Key state comes from an evdev reader (resources/linux-key-listener.c) that reads
// /dev/input directly, so it observes KEY_UP regardless of which window has focus
// and cannot miss a release. The ceiling for a genuinely stuck key is
// MAX_PUSH_DURATION_MS in windowManager, which owns push state; enforcing one here
// too would end the push by synthesizing a release, making a forced stop
// indistinguishable from the user letting go.
class LinuxKeyManager extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === "linux";
    this.hasReportedError = false;
    this.hasReportedUnavailable = false;
    this.listeners = new Map(); // key string -> { child, exact }
    this.exactModifiersProbe = null;
  }

  /**
   * Reconcile the watched keys to exactly `keys`: spawn a listener for each new
   * key, stop listeners no longer wanted. Idempotent — safe to call repeatedly.
   */
  setKeys(keys, { exactKeys = [] } = {}) {
    if (!this.isSupported) return;
    const desired = new Set(keys.filter(Boolean));
    const strict = new Set(exactKeys);

    for (const [key, listener] of this.listeners) {
      if (!desired.has(key) || listener.exact !== strict.has(key)) this._stopKey(key);
    }

    if (desired.size === 0) return;

    const listenerPath = this.resolveListenerBinary();
    if (!listenerPath) {
      if (!this.hasReportedUnavailable) {
        this.hasReportedUnavailable = true;
        this.emit("unavailable", new Error("Linux key listener binary not found"));
      }
      return;
    }

    for (const key of desired) {
      if (!this.listeners.has(key)) this._startKey(key, listenerPath, strict.has(key));
    }
  }

  _startKey(key, listenerPath, exact) {
    const args = exact ? [key, EXACT_MODIFIERS_FLAG] : [key];
    let child;
    try {
      child = spawn(listenerPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      debugLogger.error("[LinuxKeyManager] Failed to spawn process", { error: error.message });
      this.reportError(error, exact ? key : undefined);
      return;
    }

    this.hasReportedError = false;
    const entry = { child, exact };
    this.listeners.set(key, entry);
    debugLogger.debug("[LinuxKeyManager] Starting key listener", { key, binaryPath: listenerPath });

    let exactReady = false;
    const dispatch = (line) => {
      if (exact && line === EXACT_MODIFIERS_READY) {
        exactReady = true;
        this.handleOutputLine("READY", key);
      } else if (exact && !exactReady && line === "READY") {
        this.exactModifiersProbe = { binary: listenerPath, supported: false };
        this._stopKey(key);
        const error = new Error("Linux key listener does not support exact modifiers");
        error.code = "exact_modifiers_unavailable";
        this.reportError(error, exact ? key : undefined);
      } else if (!exact || exactReady || line === "NO_PERMISSION") {
        this.handleOutputLine(line, key, exactReady ? { exactModifiers: true } : undefined);
      }
    };

    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.listeners.get(key) !== entry) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const raw of lines) {
        if (this.listeners.get(key) !== entry) return;
        const line = raw.trim();
        if (line) dispatch(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (message.length > 0) {
        debugLogger.debug("[LinuxKeyManager] Native stderr", { key, message });
      }
    });

    child.on("error", (error) => {
      if (this.listeners.get(key) !== entry) return;
      this._stopKey(key);
      this.reportError(error, exact ? key : undefined);
    });

    // exit can precede the final KEY_UP on stdout; close waits for the pipe to drain.
    child.on("close", (code, signal) => {
      const trailingLine = lineBuffer.trim();
      if (trailingLine && this.listeners.get(key) === entry) {
        dispatch(trailingLine);
      }

      // Intentional stops untrack the child first. Even a clean exit can leave
      // hands-free dictation without its stop shortcut.
      const wasTracked = this.listeners.get(key) === entry;
      if (wasTracked) this._stopKey(key);
      if (wasTracked && (exact || code || signal)) {
        this.reportError(
          new Error(
            `Linux key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
          ),
          exact ? key : undefined
        );
      }
    });
  }

  _stopKey(key) {
    const entry = this.listeners.get(key);
    if (!entry) return;
    this.listeners.delete(key);
    debugLogger.debug("[LinuxKeyManager] Stopping key listener", { key });
    try {
      entry.child.kill();
    } catch {
      // Already gone
    }
  }

  handleOutputLine(line, key, metadata) {
    if (line === "READY") {
      debugLogger.debug("[LinuxKeyManager] Listener ready", { key });
      this.emit("ready", key);
      return;
    }

    if (line === "NO_PERMISSION") {
      debugLogger.warn("[LinuxKeyManager] No permission to access input devices");
      this.emit("permission-denied");
      return;
    }

    if (line === "KEY_DOWN") {
      this.emit("key-down", key, metadata);
      return;
    }

    if (line === "KEY_UP") {
      this.emit("key-up", key, metadata);
      return;
    }

    if (line === "KEY_INTERRUPTED" && metadata?.exactModifiers) {
      this.emit("key-interrupted", key, metadata);
      return;
    }

    debugLogger.debug("[LinuxKeyManager] Unknown output", { key, line });
  }

  stop() {
    for (const key of [...this.listeners.keys()]) this._stopKey(key);
  }

  /**
   * Whether the listener could actually run right now: binary present and a
   * readable keyboard among the /dev/input/event* nodes. Mirrors the C
   * listener's own rule — it keeps only keyboards and prints NO_PERMISSION only
   * when it kept none AND at least one node returned EACCES, so an event-less
   * /dev/input is not a failure there (it waits for hotplug) and must not be
   * one here. Any other readable node proves nothing: systemd grants the
   * session user every joystick.
   * Callers ask at registration time, because a hotkey only this listener can
   * serve must not report success when the listener cannot run.
   * @returns {{available: true} | {available: false, reason: "binary_missing" | "input_access_denied" | "input_devices_unavailable"}}
   */
  checkAvailability() {
    if (!this.resolveListenerBinary()) return { available: false, reason: "binary_missing" };

    let devices;
    try {
      devices = fs.readdirSync(INPUT_DIR).filter((entry) => entry.startsWith("event"));
    } catch (error) {
      // The listener cannot watch a directory it cannot list, so it never sees a
      // keyboard, and it reports nothing: NO_PERMISSION only covers device nodes.
      const deniedAccess = error.code === "EACCES" || error.code === "EPERM";
      return {
        available: false,
        reason: deniedAccess ? "input_access_denied" : "input_devices_unavailable",
      };
    }

    let denied = false;
    for (const device of devices) {
      try {
        fs.accessSync(path.join(INPUT_DIR, device), fs.constants.R_OK);
      } catch {
        denied = true;
        continue;
      }
      if (couldBeKeyboard(device)) return { available: true };
    }

    return denied ? { available: false, reason: "input_access_denied" } : { available: true };
  }

  reportError(error, exactKey) {
    // Every exact listener loss must reach the recording lifecycle.
    if (this.hasReportedError && !exactKey) return;
    this.hasReportedError = true;
    debugLogger.warn("[LinuxKeyManager] Error occurred", { error: error.message });
    this.emit("error", error, exactKey);
  }

  supportsExactModifiers() {
    const binary = this.resolveListenerBinary();
    if (!binary) return false;
    if (this.exactModifiersProbe?.binary !== binary) {
      // The probe exits before installing a hook or opening input devices.
      const result = spawnSync(binary, [EXACT_MODIFIERS_PROBE], {
        encoding: "utf8",
        timeout: 2000,
      });
      this.exactModifiersProbe = {
        binary,
        supported: result.status === 0 && result.stdout?.trim() === EXACT_MODIFIERS_READY,
      };
    }
    return this.exactModifiersProbe.supported;
  }

  resolveListenerBinary() {
    const arch = process.arch;
    const binaryNameWithArch = `linux-key-listener-${arch}`;
    const binaryNameNoArch = "linux-key-listener";

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryNameWithArch),
      path.join(__dirname, "..", "..", "resources", binaryNameWithArch),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryNameWithArch),
        path.join(process.resourcesPath, "bin", binaryNameWithArch),
        path.join(process.resourcesPath, "resources", binaryNameWithArch),
        path.join(process.resourcesPath, "resources", "bin", binaryNameWithArch),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryNameWithArch),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "resources",
          "bin",
          binaryNameWithArch
        ),
      ].forEach((candidate) => candidates.add(candidate));
    }

    [
      path.join(__dirname, "..", "..", "resources", "bin", binaryNameNoArch),
      path.join(__dirname, "..", "..", "resources", binaryNameNoArch),
    ].forEach((candidate) => candidates.add(candidate));

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryNameNoArch),
        path.join(process.resourcesPath, "bin", binaryNameNoArch),
        path.join(process.resourcesPath, "resources", binaryNameNoArch),
        path.join(process.resourcesPath, "resources", "bin", binaryNameNoArch),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryNameNoArch),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryNameNoArch),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of [...candidates]) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) return candidate;
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = LinuxKeyManager;
