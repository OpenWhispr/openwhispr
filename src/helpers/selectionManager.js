const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const debugLogger = require("./debugLogger");

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SELECTION_EDIT_CODE_POINTS = 6000;
// Ceiling for one synthetic-copy round trip. A no-selection agent command
// pays this in full, and replaceSelectedText spends a second round trip
// re-verifying — the accepted cost of failing closed rather than pasting blind.
const COPY_TIMEOUT_MS = 1200;
const CLIPBOARD_POLL_MS = 20;
const ATSPI_TARGET_TIMEOUT_MS = 2000;

// Editors that copy the whole current line when Ctrl+C (⌘C on macOS) lands with
// an empty selection (VS Code's editor.emptySelectionClipboard, Scintilla,
// JetBrains, Visual Studio), making a bare caret look like a selection to the
// synthetic-copy capture. Matched against exe name and window class on
// Windows/Linux and against the localized app name on macOS, so the JetBrains
// IDEs need both spellings.
const LINE_COPY_EDITOR_SIGNATURES = [
  "code", // VS Code and forks (VSCodium, code-oss)
  "cursor",
  "windsurf",
  "notepad++",
  "sublime",
  "jetbrains",
  "idea64",
  "intellij", // macOS app name for idea64
  "pycharm",
  "webstorm",
  "phpstorm",
  "rider64",
  "rider", // macOS app name for rider64
  "android studio", // macOS app name for studio64
  "clion",
  "goland",
  "rubymine",
  "datagrip",
  "dataspell",
  "studio64", // Android Studio
  "devenv", // Visual Studio
];

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
    this._captureTargetPromise = null;
  }

  async captureTarget() {
    if (this.platform === "darwin") return;
    this.lastTarget = null;
    const probe = this._probeTarget();
    this._captureTargetPromise = probe;
    const target = await probe;
    // A newer toggle press may have started its own probe while this one ran;
    // only the latest probe's result may land in lastTarget.
    if (this._captureTargetPromise === probe) {
      this.lastTarget = target;
      this._captureTargetPromise = null;
    }
  }

  async _probeTarget() {
    if (this.platform === "win32") {
      const binary = this.clipboardManager.resolveWindowsFastPasteBinary();
      if (!binary) return null;
      const result = await runSpawn(binary, ["--detect-only"], { timeout: 700 });
      const match = result.stdout.match(/TARGET\s+(\S+)/);
      return result.success && match
        ? {
            kind: "win-hwnd",
            id: match[1],
            windowClass: result.stdout.match(/^WINDOW_CLASS (.+)$/m)?.[1]?.trim() || null,
            exeName: result.stdout.match(/^EXE_NAME (.+)$/m)?.[1]?.trim() || null,
            isTerminal: /^IS_TERMINAL true$/m.test(result.stdout),
          }
        : null;
    }
    if (this.platform === "linux") {
      return this._getLinuxTarget();
    }
    return null;
  }

  // The Windows foreground window captured at record start, for the paste path
  // to restore before Ctrl+V lands (#859). Waits out an in-flight probe for the
  // same reason captureSelectedText does: the stop-press probe can still be
  // running when fast transcription reaches the paste.
  async getWinTargetHwnd() {
    while (this._captureTargetPromise) {
      await this._captureTargetPromise;
    }
    return this.lastTarget?.kind === "win-hwnd" ? this.lastTarget.id : null;
  }

  async captureSelectedText(options = {}) {
    // The caller knows whether a caret capture could ever be used (auto-paste
    // on); without it the probe's binary spawn would be pure waste.
    const probeEditable = options.probeEditable === true;
    return this.clipboardManager.runClipboardOperation(async () => {
      // captureTarget() fires on every toggle press, including stop. Fast
      // cloud transcription can get here before the stop-press probe lands
      // (~1s on Wayland AT-SPI), when lastTarget is still nulled from the
      // probe's start — so wait for the latest probe instead of failing with
      // target_unavailable while the answer is in flight.
      while (this._captureTargetPromise) {
        await this._captureTargetPromise;
      }
      this._pruneSessions();
      const expectedTarget =
        this.platform === "darwin" && this.textEditMonitor?.lastTargetPid
          ? { kind: "mac-pid", pid: this.textEditMonitor.lastTargetPid }
          : this.lastTarget;
      if (!expectedTarget) {
        return { status: "unavailable", code: "target_unavailable" };
      }
      const capture = await this._readCurrentSelection(expectedTarget, { probeEditable });
      if (capture.status === "editable") {
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, {
          kind: "caret",
          target: capture.target,
          expiresAt: this.now() + SESSION_TTL_MS,
        });
        return { status: "editable", sessionId };
      }
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
        kind: "selection",
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
      if (!session || session.kind !== "selection") {
        return { success: false, code: "session_expired" };
      }

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
        if (pasteResult?.pasted === false) {
          return { success: false, code: "paste_failed" };
        }
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

  async pasteAtCapturedTarget(sessionId, text, options = {}) {
    if (typeof text !== "string" || text.length === 0) {
      return { success: false, code: "invalid_replacement" };
    }

    return this.clipboardManager.runClipboardOperation(async () => {
      this._pruneSessions();
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      if (!session || session.kind !== "caret") {
        return { success: false, code: "session_expired" };
      }

      const current = await this._readCurrentSelection(session.target, { probeEditable: true });
      if (current.status !== "editable") {
        return { success: false, code: "target_changed" };
      }

      try {
        const pasteResult = await this.clipboardManager._pasteText(text, {
          ...options,
          restoreClipboard: options.restoreClipboard !== false,
          ...(session.target?.kind === "win-hwnd" ? { targetWindow: session.target.id } : {}),
        });
        await pasteResult?.restoreComplete;
        if (pasteResult?.pasted === false) {
          return { success: false, code: "paste_failed" };
        }
        return { success: true };
      } catch (error) {
        debugLogger.warn("Assistant response paste failed", { error: error.message }, "clipboard");
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
      return this._readWindowsSelection(expectedTarget, options);
    }
    if (this.platform === "linux") {
      return this._readLinuxSelection(expectedTarget, options);
    }
    return { status: "unavailable", code: "unsupported_platform" };
  }

  async _readMacSelection(expectedTarget, { activate = false, probeEditable = false } = {}) {
    const pid = expectedTarget?.pid || this.textEditMonitor?.lastTargetPid;
    if (!pid || !this.textEditMonitor?.getSelectedText) {
      return { status: "unavailable", code: "target_unavailable" };
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
      const editable = probeEditable && result.editable && !(await this._isTerminalPid(pid));
      return {
        status: editable ? "editable" : "none",
        target: { kind: "mac-pid", pid },
      };
    }
    // Chromium browsers (and any app whose accessibility tree stays dormant)
    // never resolve a focused element, so the read above cannot tell a selection
    // from an empty field. A synthetic copy still can — the same route Windows
    // and Linux take by default.
    return this._readMacSelectionViaClipboard(pid, expectedTarget, probeEditable);
  }

  async _readMacSelectionViaClipboard(pid, expectedTarget, probeEditable) {
    const binary = this.clipboardManager.resolveFastPasteBinary?.();
    if (!binary) return { status: "unavailable", code: "accessibility_unavailable" };

    const capture = await this._captureViaClipboard(
      async () => {
        const result = await this._runCopyHelper(binary, ["--copy"]);
        const match = result.stdout.match(/COPY_OK\s+(\d+)\s*(.*)/);
        if (!result.success || !match) return { success: false };
        return {
          success: true,
          target: { kind: "mac-pid", pid: Number(match[1]), appName: match[2].trim() || null },
        };
      },
      expectedTarget || { kind: "mac-pid", pid }
    );

    // A copy that never landed leaves the selection as unknown as the
    // accessibility read did, so it gets the same non-fatal treatment.
    if (capture.status === "unavailable" && capture.code === "copy_failed") {
      return { status: "unavailable", code: "accessibility_unavailable" };
    }
    // Replacement text typed into a shell executes on its embedded newlines, so
    // terminal selections are declined exactly as on Linux. GPU-rendered
    // terminals (Ghostty, Alacritty, kitty) have no accessibility tree, so this
    // path is the only way they reach selection editing at all.
    if (
      capture.status === "selected" &&
      this.clipboardManager.isTerminalSignature?.(capture.target?.appName)
    ) {
      return { status: "none", target: capture.target };
    }
    return this._markEditableCaret(capture, capture.target || expectedTarget, probeEditable);
  }

  _runCopyHelper(binary, args) {
    return runSpawn(binary, args, { timeout: COPY_TIMEOUT_MS });
  }

  async _readWindowsSelection(expectedTarget, { probeEditable = false } = {}) {
    const binary = this.clipboardManager.resolveWindowsFastPasteBinary();
    if (!binary) return { status: "unavailable", code: "copy_helper_unavailable" };

    const capture = await this._captureViaClipboard(async () => {
      const result = await runSpawn(binary, ["--copy"], { timeout: COPY_TIMEOUT_MS });
      if (!result.success) return { success: false };
      const match = result.stdout.match(/COPY_OK\s+(\S+)/);
      return { success: !!match, target: match ? { kind: "win-hwnd", id: match[1] } : null };
    }, expectedTarget);
    // The copy reports only the HWND; a same-window expectedTarget (verified by
    // _captureViaClipboard) carries the exe/class identity the terminal and
    // line-copy checks need, so keep it on the target a caret session stores.
    const target =
      capture.target && expectedTarget
        ? { ...expectedTarget, ...capture.target }
        : capture.target || expectedTarget;
    return this._markEditableCaret(capture, target, probeEditable);
  }

  async _readLinuxSelection(expectedTarget, { probeEditable = false } = {}) {
    const target = await this._getLinuxTarget();
    if (!target) return { status: "unavailable", code: "target_unavailable" };
    if (expectedTarget && !this._sameTarget(target, expectedTarget)) {
      return { status: "target_changed" };
    }
    if (this.clipboardManager.isLinuxTerminalWindowClass?.(target.windowClass)) {
      return { status: "none", target };
    }

    const binary = this.clipboardManager.resolveLinuxFastPasteBinary();
    if (target.kind === "atspi-pid") {
      const capture = await this._readLinuxAtspiSelection(binary, expectedTarget || target);
      return this._markEditableCaret(
        capture,
        capture.target || expectedTarget || target,
        probeEditable
      );
    }

    const capture = await this._captureViaClipboard(async () => {
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
        if (
          this.clipboardManager._runPortalPaste &&
          !this.clipboardManager.portalDenied &&
          !this.clipboardManager.portalUnavailable &&
          !this.clipboardManager.portalFailed
        ) {
          try {
            await this.clipboardManager._runPortalPaste(binary, {
              copy: true,
              terminal: isTerminal,
            });
            return { success: true, target };
          } catch (err) {
            // Same session-level memory as the paste path (#1614): a stale
            // portal session would otherwise stall every selection capture.
            if (err?.message !== "portal-denied" && err?.message !== "portal-dismissed") {
              this.clipboardManager.portalFailed = true;
            }
            return { success: false };
          }
        }
        return { success: false };
      }

      if (target.kind === "x11-window" && this.clipboardManager.commandExists("xdotool")) {
        const chord = this.clipboardManager.isLinuxTerminalWindowClass(target.windowClass)
          ? "ctrl+shift+c"
          : "ctrl+c";
        const result = await runFile(
          "xdotool",
          ["windowactivate", "--sync", target.id, "key", chord],
          { timeout: COPY_TIMEOUT_MS }
        );
        return { success: result.success, target };
      }
      return { success: false };
    }, expectedTarget || target);
    return this._markEditableCaret(
      capture,
      capture.target || expectedTarget || target,
      probeEditable
    );
  }

  async _markEditableCaret(capture, target, probeEditable) {
    if (!probeEditable || capture.status !== "none" || !target) return capture;
    // Generated text pasted into a shell executes on its embedded newlines, so
    // a terminal target never becomes a caret destination — the same rule the
    // selection paths apply.
    if (this._isTerminalTarget(capture.target, target)) return capture;
    // AT-SPI targets carry only a pid — nothing for the signature check above
    // to match — so resolve the executable name before a Wayland terminal's
    // empty prompt can read as a writable caret.
    if (target.kind === "atspi-pid" && (await this._isTerminalPid(target.id))) return capture;
    const editable = await this.textEditMonitor?.isFocusedEditable?.(target);
    return editable ? { status: "editable", target } : capture;
  }

  _isTerminalTarget(...targets) {
    return targets.some(
      (target) =>
        target?.isTerminal === true ||
        this.clipboardManager.isTerminalSignature?.(this._targetSignature(target))
    );
  }

  // macOS AX and Linux AT-SPI targets carry only a pid; resolve the executable
  // so terminal apps can be recognized before their empty prompt reads as a
  // writable caret. macOS `ps` reports a full path, Linux the bare comm name —
  // the parsing below degrades to the bare name unchanged.
  async _isTerminalPid(pid) {
    if (!this.clipboardManager.isTerminalSignature) return false;
    const executablePath = await this._readExecutablePath(pid);
    if (!executablePath) return false;
    // Match the bundle and executable names, not the whole path — segments
    // like "/System/" would collide with short signatures such as "st".
    const bundleName = executablePath.match(/\/([^/]+)\.app\//)?.[1] ?? "";
    const executableName = executablePath.split("/").pop() ?? "";
    return this.clipboardManager.isTerminalSignature(`${bundleName} ${executableName}`);
  }

  async _readExecutablePath(pid) {
    const result = await runSpawn("ps", ["-p", String(pid), "-o", "comm="], { timeout: 500 });
    return result.success ? result.stdout.trim() : "";
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
      if (result.success && id) {
        const classResult = await runFile("xdotool", ["getwindowclassname", id], { timeout: 500 });
        return {
          kind: "x11-window",
          id,
          windowClass: classResult.success ? classResult.stdout.trim().toLowerCase() : null,
        };
      }
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
    const result = await runSpawn(binary, ["--atspi-target"], {
      timeout: ATSPI_TARGET_TIMEOUT_MS,
    });
    const match = result.stdout.match(/^TARGET\s+ATSPI\s+(\d+)$/m);
    return result.success && match ? { kind: "atspi-pid", id: match[1] } : null;
  }

  async _captureViaClipboard(sendCopy, expectedTarget) {
    const original = this.clipboardManager._saveClipboard();
    const beforeWrite = this.clipboardManager._readClipboardTextAll();
    const sentinel = `__OPENWHISPR_SELECTION_${crypto.randomUUID()}__`;
    this.clipboardManager._writeClipboardTextAll(sentinel);
    // A clipboard side the sentinel write didn't reach (KDE desyncs X11 from
    // Wayland) still holds pre-copy content; snapshot it so stale text can't
    // be mistaken for the copied selection. Known limitation: a clipboard that
    // already held exactly the selected text reads as "no selection". The
    // command then falls back to the Assistant panel — never to a caret paste,
    // because the editable probe reads the focused element's own selection
    // state and refuses a field with a live selection.
    const baseline = new Set([...beforeWrite, ...this.clipboardManager._readClipboardTextAll()]);

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
    // A line copy from an empty-selection Ctrl+C is exactly one line with a
    // trailing terminator; treat that shape from a known line-copy editor as
    // "no selection" so a bare caret never gets its line rewritten. Proper
    // fix: a real selection read (UIA TextPattern), like --atspi-selection.
    if (
      /^[^\n]*\r?\n$/.test(copiedText) &&
      this._isLineCopyEditor(expectedTarget, copyResult.target)
    ) {
      return { status: "none", target: copyResult.target };
    }
    return { status: "selected", text: copiedText, target: copyResult.target };
  }

  _targetSignature(target) {
    return `${target?.exeName || ""} ${target?.windowClass || ""} ${target?.appName || ""}`.trim();
  }

  // Windows and Linux name the app in the target captured before the copy;
  // macOS learns it from the copy helper's own report, so both are checked.
  _isLineCopyEditor(...targets) {
    const signature = targets
      .map((target) => this._targetSignature(target))
      .join(" ")
      .toLowerCase();
    if (!signature.trim()) return false;
    return LINE_COPY_EDITOR_SIGNATURES.some((editor) => signature.includes(editor));
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
