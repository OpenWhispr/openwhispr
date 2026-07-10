const { spawn, execFile } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const POLL_INTERVAL_MS = 500;
const INITIAL_QUERY_DELAY_MS = 500; // Wait for paste to settle in target app
const INITIAL_QUERY_RETRIES = 4; // Retry if AXValue is empty (paste not yet processed)
const INITIAL_QUERY_RETRY_DELAY_MS = 300;
const ACTIVATE_CONFIRM_RETRIES = 6; // Poll the frontmost app until activation lands
const ACTIVATE_CONFIRM_DELAY_MS = 25;

// Monitoring is strictly read-only: never write AXEnhancedUserInterface (or any
// AX attribute) on the target app to force its accessibility tree. Flipping that
// flag switches the whole process into screen-reader mode for its lifetime and
// blurs the focused editor in some Chromium apps (Claude Desktop, claude.ai),
// so every dictation after the first pasted into a field that no longer had
// keyboard focus. Modern Chromium builds the tree on demand when our
// reads arrive; where it doesn't, we skip auto-learn for that paste instead.

// Returns the character before the cursor for smart-spacing. Output protocol:
//   "OK:X"   — preceding char is X
//   "START:" — cursor at field start, no preceding char
//   ""       — unknown / read failed (caller falls back to append-mode spacing)
// AppleScript `character N` is 1-indexed; AXSelectedTextRange.location is
// 0-indexed, so the char at offset (loc-1) is `character loc`.
const MACOS_AX_PRECEDING_CHAR_SCRIPT = (pid) =>
  `tell application "System Events"\n` +
  `\tset targetProc to first application process whose unix id is ${pid}\n` +
  `\tset focAttr to value of attribute "AXFocusedUIElement" of targetProc\n` +
  `\tif focAttr is missing value then return ""\n` +
  `\tset theVal to ""\n` +
  `\ttry\n` +
  `\t\tset theVal to value of attribute "AXValue" of focAttr\n` +
  `\t\tif theVal is missing value then set theVal to ""\n` +
  `\tend try\n` +
  `\tset loc to -1\n` +
  `\ttry\n` +
  `\t\tset sel to value of attribute "AXSelectedTextRange" of focAttr\n` +
  `\t\ttry\n` +
  `\t\t\tset loc to item 1 of sel\n` +
  `\t\tend try\n` +
  `\tend try\n` +
  `\tif loc is -1 then return ""\n` +
  `\tif loc < 1 then return "START:"\n` +
  `\tif (length of theVal) is 0 then return "START:"\n` +
  `\tif loc > (length of theVal) then set loc to length of theVal\n` +
  `\tif loc < 1 then return "START:"\n` +
  `\treturn "OK:" & (character loc of theVal)\n` +
  `end tell`;

// AppleScript to read the focused text field value from a specific app by PID.
// Using PID avoids the problem where the Electron overlay is "frontmost".
// Tries AXValue first, then falls back to AXStringForRange for apps that
// implement parameterized text attributes but not AXValue directly.
const MACOS_AX_SCRIPT_BY_PID = (pid) =>
  `tell application "System Events"\n` +
  `\tset targetProc to first application process whose unix id is ${pid}\n` +
  `\tset focAttr to value of attribute "AXFocusedUIElement" of targetProc\n` +
  `\tif focAttr is missing value then return ""\n` +
  `\ttry\n` +
  `\t\tset val to value of attribute "AXValue" of focAttr\n` +
  `\t\tif val is not missing value and val is not "" then return val\n` +
  `\tend try\n` +
  `\ttry\n` +
  `\t\tset charCount to value of attribute "AXNumberOfCharacters" of focAttr\n` +
  `\t\tif charCount is greater than 0 then\n` +
  `\t\t\treturn value of attribute "AXSelectedText" of focAttr\n` +
  `\t\tend if\n` +
  `\tend try\n` +
  `\treturn ""\n` +
  `end tell`;

class TextEditMonitor extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.currentOriginalText = null;
    this.timeout = null;
    this._pollInterval = null;
    this._lastValue = null;
    this._stdoutBuffer = "";
    this.lastTargetPid = null;
  }

  /**
   * macOS: capture the active app's PID via NSWorkspace before the overlay steals focus.
   * Must be called at hotkey press time, BEFORE showDictationPanel()/mainWindow.show().
   * NSWorkspace.frontmostApplication correctly identifies the key window owner,
   * ignoring panel-type windows like the OpenWhispr overlay.
   */
  captureTargetPid() {
    if (process.platform !== "darwin") return;
    this._readFrontmostPid().then((pid) => {
      this.lastTargetPid = pid;
      debugLogger.debug("[TextEditMonitor] Captured target PID", { pid });
    });
  }

  /**
   * macOS: resolve the frontmost app's PID, or null if it can't be read.
   */
  _readFrontmostPid() {
    return new Promise((resolve) => {
      if (process.platform !== "darwin") {
        resolve(null);
        return;
      }
      const script =
        'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier';
      execFile(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        { timeout: 2000 },
        (err, stdout) => {
          const pid = err ? NaN : parseInt(stdout.trim(), 10);
          resolve(isNaN(pid) ? null : pid);
        }
      );
    });
  }

  /**
   * macOS: request activation of the app with the given PID, bringing all its
   * windows forward (AllWindows|IgnoringOtherApps) so one becomes key. Scans
   * runningApplications because NSRunningApplication's PID lookup returns nil under JXA.
   */
  _activateApp(pid) {
    return new Promise((resolve) => {
      const script = `
        ObjC.import("AppKit");
        const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
        for (let i = 0; i < apps.count; i++) {
          const a = apps.objectAtIndex(i);
          if (a.processIdentifier === ${pid}) { a.activateWithOptions(3); break; }
        }
      `;
      execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 2000 }, () => resolve());
    });
  }

  /**
   * macOS: make the captured target app frontmost before pasting, so the global
   * Cmd+V lands in its focused field (#668). Resolves true once the target is
   * confirmed frontmost. If it is already frontmost we do nothing: re-activating
   * an already-active Chromium app (e.g. Claude Desktop) drops its field's first
   * responder — the focus loss this fixes — and skipping also avoids a needless
   * activation round-trip. Otherwise we activate and poll until the OS reports the
   * target frontmost, the macOS analogue of Linux's `xdotool windowactivate --sync`.
   */
  async activateTargetPid() {
    if (process.platform !== "darwin" || !this.lastTargetPid) return false;
    const pid = this.lastTargetPid;
    if ((await this._readFrontmostPid()) === pid) return true;

    await this._activateApp(pid);
    for (let i = 0; i < ACTIVATE_CONFIRM_RETRIES; i++) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVATE_CONFIRM_DELAY_MS));
      if ((await this._readFrontmostPid()) === pid) {
        debugLogger.debug("[TextEditMonitor] Activated target PID", { pid });
        return true;
      }
    }
    debugLogger.debug("[TextEditMonitor] Target did not become frontmost", { pid });
    return false;
  }

  /**
   * macOS: read the char before the cursor in the focused text field, used by
   * paste-time smart spacing. Resolves to { state: "ok", char } | { state:
   * "start" } | { state: "unknown" }. Tight timeout so paste latency is
   * unaffected; on "unknown" the caller falls back to append-mode spacing.
   */
  getPrecedingChar(pid, timeoutMs = 400) {
    return new Promise((resolve) => {
      if (process.platform !== "darwin" || !pid) {
        resolve({ state: "unknown" });
        return;
      }
      const script = MACOS_AX_PRECEDING_CHAR_SCRIPT(pid);
      execFile("osascript", ["-e", script], { timeout: timeoutMs }, (err, stdout) => {
        if (err) {
          resolve({ state: "unknown" });
          return;
        }
        const out = stdout.replace(/\n$/, "");
        if (out === "START:") {
          resolve({ state: "start" });
          return;
        }
        if (out.startsWith("OK:")) {
          resolve({ state: "ok", char: out.slice(3) });
          return;
        }
        resolve({ state: "unknown" });
      });
    });
  }

  /**
   * Start monitoring the focused text field for edits after a paste.
   * Kills any existing monitor before starting a new one.
   * @param {string} originalText - The transcribed text that was pasted
   * @param {number} timeoutMs - How long to monitor (default 30s)
   */
  startMonitoring(originalText, timeoutMs = 30000, options = {}) {
    this.stopMonitoring();
    this.currentOriginalText = originalText;

    if (process.platform === "darwin") {
      const resolved = this.resolveBinary();
      if (resolved) {
        this._startMacOSNative(originalText, timeoutMs, options.targetPid, resolved);
        return;
      }
      this._startMacOSPolling(originalText, timeoutMs, options.targetPid);
      return;
    }

    const resolved = this.resolveBinary();
    if (!resolved) {
      debugLogger.debug("[TextEditMonitor] No binary found for platform", {
        platform: process.platform,
      });
      this.currentOriginalText = null;
      return;
    }

    const { command, args } = resolved;
    debugLogger.debug("[TextEditMonitor] Resolved binary", { command, args });

    // For native binaries, verify executable permission
    if (command !== "python3") {
      try {
        fs.accessSync(command, fs.constants.X_OK);
      } catch {
        debugLogger.debug("[TextEditMonitor] Binary not executable", { command });
        this.currentOriginalText = null;
        return;
      }
    }

    debugLogger.debug("[TextEditMonitor] Spawning monitor", {
      textPreview: originalText.substring(0, 80),
    });

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send original text via stdin
    this.process.stdin.write(originalText + "\n");
    this.process.stdin.end();

    this._stdoutBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      debugLogger.debug("[TextEditMonitor] stdout", { data: chunk.trim() });
      this._handleProcessStdoutChunk(chunk);
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      debugLogger.debug("[TextEditMonitor] stderr", { data: data.trim() });
    });

    this.process.on("error", (err) => {
      debugLogger.debug("[TextEditMonitor] Process error", { error: err.message });
      this.process = null;
    });

    this.process.on("exit", (code, signal) => {
      debugLogger.debug("[TextEditMonitor] Process exited", { code, signal });
      this.process = null;
    });

    // Safety net timeout (binary also self-exits after its own timeout)
    this.timeout = setTimeout(() => this.stopMonitoring(), timeoutMs);
  }

  stopMonitoring() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    this._lastValue = null;
    this._stdoutBuffer = "";
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // ignore
      }
      this.process = null;
    }
    this.currentOriginalText = null;
  }

  _handleProcessStdoutChunk(chunk) {
    this._stdoutBuffer += chunk;
    const lines = this._stdoutBuffer.split(/\r?\n/);
    this._stdoutBuffer = lines.pop() || "";

    for (const rawLine of lines) {
      if (!rawLine) continue;
      this._handleProcessLine(rawLine);
    }
  }

  _decodeBase64Payload(encoded) {
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch (error) {
      debugLogger.debug("[TextEditMonitor] Failed to decode base64 payload", {
        error: error.message,
      });
      return null;
    }
  }

  _emitTextEdited(newFieldValue) {
    if (typeof newFieldValue !== "string" || this.currentOriginalText === null) {
      return;
    }

    debugLogger.debug("[TextEditMonitor] Text changed", {
      newFieldValue: newFieldValue.substring(0, 80),
    });
    this.emit("text-edited", {
      originalText: this.currentOriginalText,
      newFieldValue,
    });
  }

  _handleProcessLine(line) {
    if (line.startsWith("CHANGED_B64:")) {
      const decoded = this._decodeBase64Payload(line.slice("CHANGED_B64:".length));
      if (decoded !== null) {
        this._emitTextEdited(decoded);
      }
      return;
    }

    if (line.startsWith("CHANGED:")) {
      this._emitTextEdited(line.slice("CHANGED:".length));
      return;
    }

    if (line === "NO_ELEMENT" || line === "NO_VALUE") {
      debugLogger.debug("[TextEditMonitor] No target element", { status: line });
      this.stopMonitoring();
    }
  }

  /**
   * macOS: use the native Swift AXObserver binary for event-based text monitoring.
   * Falls back to osascript polling if the binary fails to start.
   */
  async _startMacOSNative(originalText, timeoutMs, targetPid, resolved) {
    if (!targetPid) {
      debugLogger.debug("[TextEditMonitor] macOS native: no target PID");
      this.stopMonitoring();
      return;
    }

    debugLogger.debug("[TextEditMonitor] macOS native: starting", {
      targetPid,
      textPreview: originalText.substring(0, 80),
    });

    await new Promise((r) => setTimeout(r, INITIAL_QUERY_DELAY_MS));
    if (this.currentOriginalText === null) return;

    const { command, args } = resolved;

    try {
      fs.accessSync(command, fs.constants.X_OK);
    } catch {
      debugLogger.debug(
        "[TextEditMonitor] macOS native: binary not executable, falling back to polling",
        { command }
      );
      this._startMacOSPolling(originalText, timeoutMs, targetPid);
      return;
    }

    this.process = spawn(command, [...args, String(targetPid)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdin.write(originalText + "\n");
    this.process.stdin.end();

    this._stdoutBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      debugLogger.debug("[TextEditMonitor] stdout", { data: chunk.trim() });
      this._handleProcessStdoutChunk(chunk);
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      debugLogger.debug("[TextEditMonitor] stderr", { data: data.trim() });
    });

    this.process.on("error", (err) => {
      debugLogger.debug("[TextEditMonitor] macOS native: process error, falling back to polling", {
        error: err.message,
      });
      this.process = null;
      if (this.currentOriginalText === null) return;
      this._startMacOSPolling(originalText, timeoutMs, targetPid);
    });

    this.process.on("exit", (code, signal) => {
      debugLogger.debug("[TextEditMonitor] Process exited", { code, signal });
      this.process = null;
    });

    this.timeout = setTimeout(() => this.stopMonitoring(), timeoutMs);
  }

  /**
   * macOS: query the focused text field value via osascript for a specific app PID.
   * Returns the field value string, or null on error.
   */
  _queryMacOSValue(pid) {
    return new Promise((resolve) => {
      const script = MACOS_AX_SCRIPT_BY_PID(pid);
      execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          resolve(stdout.replace(/\n$/, ""));
        }
      });
    });
  }

  /**
   * macOS: poll the focused text field for changes using osascript.
   * Uses Apple-signed osascript binary which inherits accessibility trust.
   * @param {string} originalText - The pasted text
   * @param {number} timeoutMs - Monitoring timeout
   * @param {number|null} targetPid - PID of the app that received the paste
   */
  _startMacOSPolling(originalText, timeoutMs, targetPid) {
    if (!targetPid) {
      debugLogger.debug("[TextEditMonitor] macOS: no target PID");
      this.stopMonitoring();
      return;
    }

    debugLogger.debug("[TextEditMonitor] macOS: starting osascript polling", {
      targetPid,
      textPreview: originalText.substring(0, 80),
    });

    // Delay before querying to let the paste keystroke be processed.
    setTimeout(
      () => this._queryInitialValue(targetPid, originalText, timeoutMs),
      INITIAL_QUERY_DELAY_MS
    );
  }

  /**
   * Query the initial AXValue with retries. The target app may not have processed
   * the pasted text yet, so an empty value is retried a few times before giving up.
   */
  async _queryInitialValue(targetPid, originalText, timeoutMs, attempt = 1) {
    // Guard against stopMonitoring() being called while we waited
    if (this.currentOriginalText === null) return;

    const initialValue = await this._queryMacOSValue(targetPid);
    if (this.currentOriginalText === null) return;

    if (initialValue === null) {
      debugLogger.debug("[TextEditMonitor] macOS: no focused element");
      this.stopMonitoring();
      return;
    }

    if (!initialValue) {
      if (attempt < INITIAL_QUERY_RETRIES) {
        debugLogger.debug("[TextEditMonitor] macOS: AXValue empty, retrying", {
          attempt,
          maxRetries: INITIAL_QUERY_RETRIES,
        });
        setTimeout(
          () => this._queryInitialValue(targetPid, originalText, timeoutMs, attempt + 1),
          INITIAL_QUERY_RETRY_DELAY_MS
        );
        return;
      }
      debugLogger.debug("[TextEditMonitor] macOS: no text value after retries");
      this.stopMonitoring();
      return;
    }

    this._lastValue = initialValue;
    debugLogger.debug("[TextEditMonitor] macOS: initial value", {
      valuePreview: initialValue.substring(0, 80),
      attempt,
    });

    this._pollInterval = setInterval(async () => {
      const currentValue = await this._queryMacOSValue(targetPid);
      // Guard against stopMonitoring() being called during the query
      if (this.currentOriginalText === null) return;

      if (currentValue === null) {
        debugLogger.debug("[TextEditMonitor] macOS: lost focused element");
        this.stopMonitoring();
        return;
      }

      if (currentValue !== this._lastValue) {
        this._lastValue = currentValue;
        debugLogger.debug("[TextEditMonitor] macOS: text changed", {
          newValuePreview: currentValue.substring(0, 80),
        });
        this.emit("text-edited", {
          originalText: this.currentOriginalText,
          newFieldValue: currentValue,
        });
      }
    }, POLL_INTERVAL_MS);

    this.timeout = setTimeout(() => this.stopMonitoring(), timeoutMs);
  }

  /**
   * Resolve the platform-specific binary.
   * Returns { command, args } or null if unavailable.
   */
  resolveBinary() {
    const platform = process.platform;

    if (platform === "linux") {
      const nativePath = this._findFile("linux-text-monitor");
      if (nativePath) return { command: nativePath, args: [] };
      const scriptPath = this._findFile("linux-text-monitor.py");
      return scriptPath ? { command: "python3", args: [scriptPath] } : null;
    }

    if (platform === "win32") {
      const binaryPath = this._findFile("windows-text-monitor.exe");
      return binaryPath ? { command: binaryPath, args: [] } : null;
    }

    if (platform === "darwin") {
      const nativePath = this._findFile("macos-text-monitor");
      if (nativePath) return { command: nativePath, args: [] }; // PID added at spawn time
      return null;
    }

    return null;
  }

  _findFile(fileName) {
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", fileName),
      path.join(__dirname, "..", "..", "resources", fileName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, fileName),
        path.join(process.resourcesPath, "bin", fileName),
        path.join(process.resourcesPath, "resources", fileName),
        path.join(process.resourcesPath, "resources", "bin", fileName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", fileName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", fileName),
      ].forEach((c) => candidates.add(c));
    }

    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = TextEditMonitor;
