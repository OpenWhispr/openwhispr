const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const debugLogger = require("./debugLogger");

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SELECTION_EDIT_CODE_POINTS = 6000;
const COPY_TIMEOUT_MS = 1200;
const CLIPBOARD_POLL_MS = 20;

function runFile(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: options.timeout || COPY_TIMEOUT_MS },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout?.toString?.() || "",
          stderr: stderr?.toString?.() || error?.message || "",
        });
      }
    );
  });
}

function runSpawn(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      stderr += error.message;
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, options.timeout || COPY_TIMEOUT_MS);
  });
}

class SelectionManager {
  constructor({
    clipboardManager,
    textEditMonitor,
    platform = process.platform,
    now = Date.now,
  } = {}) {
    this.clipboardManager = clipboardManager;
    this.textEditMonitor = textEditMonitor;
    this.platform = platform;
    this.now = now;
    this.sessions = new Map();
    this.lastTarget = null;
  }

  async captureTarget() {
    if (this.platform === "darwin") return;
    this.lastTarget = null;
    if (this.platform === "win32") {
      const binary = this.clipboardManager.resolveWindowsFastPasteBinary();
      if (!binary) {
        this.lastTarget = null;
        return;
      }
      const result = await runSpawn(binary, ["--detect-only"], { timeout: 700 });
      const match = result.stdout.match(/TARGET\s+(\S+)/);
      this.lastTarget = result.success && match ? { kind: "win-hwnd", id: match[1] } : null;
      return;
    }
    if (this.platform === "linux") {
      this.lastTarget = await this._getLinuxTarget();
    }
  }

  async captureSelectedText() {
    return this.clipboardManager.runClipboardOperation(async () => {
      this._pruneSessions();
      const expectedTarget =
        this.platform === "darwin" && this.textEditMonitor?.lastTargetPid
          ? { kind: "mac-pid", pid: this.textEditMonitor.lastTargetPid }
          : this.lastTarget;
      if (!expectedTarget) {
        return { status: "unavailable", code: "target_unavailable" };
      }
      const capture = await this._readCurrentSelection(expectedTarget);
      if (capture.status !== "selected") return capture;

      const characterCount = [...capture.text].length;
      if (characterCount > MAX_SELECTION_EDIT_CODE_POINTS) {
        return {
          status: "too_large",
          characterCount,
          maxCharacters: MAX_SELECTION_EDIT_CODE_POINTS,
        };
      }

      const sessionId = crypto.randomUUID();
      this.sessions.set(sessionId, {
        text: capture.text,
        target: capture.target,
        expiresAt: this.now() + SESSION_TTL_MS,
      });
      return {
        status: "selected",
        sessionId,
        text: capture.text,
        characterCount,
      };
    });
  }

  async replaceSelectedText(sessionId, replacement, options = {}) {
    if (typeof replacement !== "string" || replacement.length === 0) {
      return { success: false, code: "invalid_replacement" };
    }

    return this.clipboardManager.runClipboardOperation(async () => {
      this._pruneSessions();
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      if (!session) return { success: false, code: "session_expired" };

      const current = await this._readCurrentSelection(session.target, { activate: true });
      if (current.status === "target_changed") {
        return { success: false, code: "target_changed" };
      }
      if (current.status === "unavailable") {
        return { success: false, code: "selection_unavailable" };
      }
      if (current.status !== "selected" || current.text !== session.text) {
        return { success: false, code: "selection_changed" };
      }

      try {
        const pasteResult = await this.clipboardManager._pasteText(replacement, {
          ...options,
          restoreClipboard: options.restoreClipboard !== false,
        });
        await pasteResult?.restoreComplete;
        return { success: true };
      } catch (error) {
        debugLogger.warn(
          "Selection replacement paste failed",
          { error: error.message },
          "clipboard"
        );
        return { success: false, code: "paste_failed", error: error.message };
      }
    });
  }

  _pruneSessions() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  async _readCurrentSelection(expectedTarget = null, options = {}) {
    if (this.platform === "darwin") {
      return this._readMacSelection(expectedTarget, options);
    }
    if (this.platform === "win32") {
      return this._readWindowsSelection(expectedTarget);
    }
    if (this.platform === "linux") {
      return this._readLinuxSelection(expectedTarget);
    }
    return { status: "unavailable", code: "unsupported_platform" };
  }

  async _readMacSelection(expectedTarget, { activate = false } = {}) {
    const pid = expectedTarget?.pid || this.textEditMonitor?.lastTargetPid;
    if (!pid || !this.textEditMonitor?.getSelectedText) {
      return { status: "unavailable", code: "target_unavailable" };
    }
    if (expectedTarget && expectedTarget.pid !== pid) {
      return { status: "target_changed" };
    }
    const frontmostPid = await this.textEditMonitor._readFrontmostPid?.();
    if (frontmostPid && frontmostPid !== pid) {
      return { status: "target_changed" };
    }
    if (activate && !(await this.textEditMonitor.activatePid(pid))) {
      return { status: "unavailable", code: "activation_failed" };
    }

    const result = await this.textEditMonitor.getSelectedText(pid);
    if (result.state === "selected") {
      return { status: "selected", text: result.text, target: { kind: "mac-pid", pid } };
    }
    if (result.state === "none") {
      return { status: "none", target: { kind: "mac-pid", pid } };
    }
    return { status: "unavailable", code: "accessibility_unavailable" };
  }

  async _readWindowsSelection(expectedTarget) {
    const binary = this.clipboardManager.resolveWindowsFastPasteBinary();
    if (!binary) return { status: "unavailable", code: "copy_helper_unavailable" };

    return this._captureViaClipboard(async () => {
      const result = await runSpawn(binary, ["--copy"], { timeout: COPY_TIMEOUT_MS });
      if (!result.success) return { success: false };
      const match = result.stdout.match(/COPY_OK\s+(\S+)/);
      return { success: !!match, target: match ? { kind: "win-hwnd", id: match[1] } : null };
    }, expectedTarget);
  }

  async _readLinuxSelection(expectedTarget) {
    const target = await this._getLinuxTarget();
    if (!target) return { status: "unavailable", code: "target_unavailable" };
    if (expectedTarget && !this._sameTarget(target, expectedTarget)) {
      return { status: "target_changed" };
    }

    const binary = this.clipboardManager.resolveLinuxFastPasteBinary();
    if (target.kind === "atspi-pid") {
      return this._readLinuxAtspiSelection(binary, expectedTarget || target);
    }

    return this._captureViaClipboard(async () => {
      if (binary) {
        if (target.kind === "x11-window") {
          // The binary classifies the window itself via --window and picks
          // Ctrl+C or Ctrl+Shift+C accordingly.
          const result = await runSpawn(binary, ["--copy", "--window", target.id], {
            timeout: COPY_TIMEOUT_MS,
          });
          return { success: result.success, target };
        }

        // Without an X11 window id the binary cannot classify the target,
        // and a plain Ctrl+C in a terminal with no selection sends SIGINT —
        // so only proceed when the compositor reported the window class.
        if (!target.windowClass) return { success: false };
        const isTerminal = this.clipboardManager.isLinuxTerminalWindowClass(target.windowClass);

        if (this.clipboardManager._canAccessUinput?.()) {
          const args = ["--copy", "--uinput"];
          if (isTerminal) args.push("--terminal");
          const result = await runSpawn(binary, args, { timeout: COPY_TIMEOUT_MS });
          return { success: result.success, target };
        }
        if (this.clipboardManager._runPortalPaste && !this.clipboardManager.portalDenied) {
          try {
            await this.clipboardManager._runPortalPaste(binary, {
              copy: true,
              terminal: isTerminal,
            });
            return { success: true, target };
          } catch {
            return { success: false };
          }
        }
        return { success: false };
      }

      if (target.kind === "x11-window" && this.clipboardManager.commandExists("xdotool")) {
        const chord = await this._getLinuxCopyChord(target.id);
        const result = await runFile(
          "xdotool",
          ["windowactivate", "--sync", target.id, "key", chord],
          { timeout: COPY_TIMEOUT_MS }
        );
        return { success: result.success, target };
      }
      return { success: false };
    }, expectedTarget || target);
  }

  async _readLinuxAtspiSelection(binary, expectedTarget) {
    if (!binary) return { status: "unavailable", code: "copy_helper_unavailable" };

    const result = await runSpawn(binary, ["--atspi-selection"], { timeout: COPY_TIMEOUT_MS });
    if (!result.success) return { status: "unavailable", code: "accessibility_unavailable" };

    const selected = result.stdout.match(/^ATSPI_SELECTED\s+(\d+)\s+([A-Za-z0-9+/=]+)$/m);
    const none = result.stdout.match(/^ATSPI_NONE\s+(\d+)$/m);
    const pid = selected?.[1] || none?.[1];
    if (!pid) return { status: "unavailable", code: "accessibility_unavailable" };

    const target = { kind: "atspi-pid", id: pid };
    if (expectedTarget && !this._sameTarget(target, expectedTarget)) {
      return { status: "target_changed" };
    }
    if (none) return { status: "none", target };

    try {
      return {
        status: "selected",
        text: Buffer.from(selected[2], "base64").toString("utf8"),
        target,
      };
    } catch {
      return { status: "unavailable", code: "accessibility_unavailable" };
    }
  }

  async _getLinuxTarget() {
    // On native Wayland, xdotool can report a stale XWayland window. Prefer
    // AT-SPI when available so the target and selected text come from the
    // compositor's actual focused accessibility object.
    if (this.clipboardManager._isWayland?.()) {
      const atspiTarget = await this._getLinuxAtspiTarget();
      if (atspiTarget) return atspiTarget;
    }

    if (this.clipboardManager.commandExists("xdotool") && process.env.DISPLAY) {
      const result = await runFile("xdotool", ["getactivewindow"], { timeout: 500 });
      const id = result.stdout.trim();
      if (result.success && id) return { kind: "x11-window", id };
    }

    if (this.clipboardManager.commandExists("kdotool")) {
      const result = await runFile("kdotool", ["getactivewindow"], { timeout: 500 });
      const id = result.stdout.trim();
      if (result.success && id) {
        return {
          kind: "kde-window",
          id,
          windowClass: this.clipboardManager._detectKdeWindowClass?.() || null,
        };
      }
    }

    if (this.clipboardManager.commandExists("hyprctl")) {
      const result = await runFile("hyprctl", ["activewindow", "-j"], { timeout: 500 });
      if (result.success) {
        try {
          const active = JSON.parse(result.stdout);
          if (active.address) {
            return {
              kind: "hyprland-window",
              id: active.address,
              windowClass: typeof active.class === "string" ? active.class.toLowerCase() : null,
            };
          }
        } catch {}
      }
    }

    return this._getLinuxAtspiTarget();
  }

  async _getLinuxAtspiTarget() {
    const binary = this.clipboardManager.resolveLinuxFastPasteBinary();
    if (!binary) return null;
    const result = await runSpawn(binary, ["--atspi-target"], { timeout: 700 });
    const match = result.stdout.match(/^TARGET\s+ATSPI\s+(\d+)$/m);
    return result.success && match ? { kind: "atspi-pid", id: match[1] } : null;
  }

  async _getLinuxCopyChord(windowId) {
    const result = await runFile("xdotool", ["getwindowclassname", windowId], { timeout: 500 });
    return this.clipboardManager.isLinuxTerminalWindowClass(result.stdout)
      ? "ctrl+shift+c"
      : "ctrl+c";
  }

  async _captureViaClipboard(sendCopy, expectedTarget) {
    const original = this.clipboardManager._saveClipboard();
    const beforeWrite = this.clipboardManager._readClipboardTextAll();
    const sentinel = `__OPENWHISPR_SELECTION_${crypto.randomUUID()}__`;
    this.clipboardManager._writeClipboardTextAll(sentinel);
    // A clipboard side the sentinel write didn't reach (KDE desyncs X11 from
    // Wayland) still holds pre-copy content; snapshot it so stale text can't
    // be mistaken for the copied selection.
    const baseline = new Set([
      ...beforeWrite,
      ...this.clipboardManager._readClipboardTextAll(),
    ]);

    const copyResult = await sendCopy();
    if (!copyResult?.success || !copyResult.target) {
      this._restoreClipboardIfOurs(original, [sentinel], baseline);
      return { status: "unavailable", code: "copy_failed" };
    }
    if (expectedTarget && !this._sameTarget(copyResult.target, expectedTarget)) {
      this._restoreClipboardIfOurs(original, [sentinel], baseline);
      return { status: "target_changed" };
    }

    const deadline = Date.now() + COPY_TIMEOUT_MS;
    let copiedText = null;
    while (Date.now() < deadline) {
      copiedText =
        this.clipboardManager
          ._readClipboardTextAll()
          .find((text) => text.length > 0 && text !== sentinel && !baseline.has(text)) ?? null;
      if (copiedText !== null) break;
      await new Promise((resolve) => setTimeout(resolve, CLIPBOARD_POLL_MS));
    }

    this._restoreClipboardIfOurs(original, [sentinel, copiedText], baseline);
    if (copiedText === null) {
      return { status: "none", target: copyResult.target };
    }
    return { status: "selected", text: copiedText, target: copyResult.target };
  }

  _restoreClipboardIfOurs(original, writtenTexts, baseline = new Set()) {
    const written = writtenTexts.filter((text) => typeof text === "string" && text.length > 0);
    try {
      const current = this.clipboardManager._readClipboardTextAll();
      const userClipboardText = current.find(
        (text) => text.length > 0 && !written.includes(text) && !baseline.has(text)
      );
      if (userClipboardText) {
        // The user copied something while capture was in flight. Prefer their
        // new clipboard over restoring our snapshot, and clear our sentinel
        // from any desynchronised X11/Wayland side.
        this.clipboardManager._writeClipboardTextAll(userClipboardText);
        return;
      }
      if (!current.some((text) => written.includes(text))) return;
      if (original?.type === "text") {
        // Text restores go through the all-sides writer so a desynced side
        // isn't left holding the sentinel or the copied selection.
        this.clipboardManager._writeClipboardTextAll(original.data);
      } else {
        this.clipboardManager._restoreClipboard(original);
      }
    } catch {}
  }

  _sameTarget(a, b) {
    return !!a && !!b && a.kind === b.kind && String(a.id ?? a.pid) === String(b.id ?? b.pid);
  }
}

module.exports = SelectionManager;
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;
