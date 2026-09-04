const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const selectionManagerPath = require.resolve("../../src/helpers/selectionManager");
const originalLoad = Module._load;

function loadSelectionManager({ spawn } = {}) {
  delete require.cache[selectionManagerPath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { clipboard: { readText: () => "", writeText: () => {} } };
    }
    if (request === "child_process" && spawn) {
      return { ...childProcess, spawn };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../src/helpers/selectionManager");
  } finally {
    Module._load = originalLoad;
  }
}

const SelectionManager = loadSelectionManager();

function makeHarness({
  selections = ["original"],
  now = () => 1000,
  pasteResult = { restoreComplete: Promise.resolve() },
} = {}) {
  const reads = [...selections];
  const pastes = [];
  const textEditMonitor = {
    lastTargetPid: 42,
    activatePid: async (pid) => pid === 42,
    getSelectedText: async () => {
      const value = reads.shift();
      if (value === undefined) return { state: "unavailable" };
      if (value === null) return { state: "none" };
      if (typeof value === "object") return value;
      return { state: "selected", text: value };
    },
  };
  const clipboardManager = {
    runClipboardOperation: (operation) => operation(),
    _pasteText: async (text, options) => {
      pastes.push({ text, options });
      return pasteResult;
    },
  };
  const manager = new SelectionManager({
    clipboardManager,
    textEditMonitor,
    platform: "darwin",
    now,
  });
  return { manager, pastes };
}

test("captures an exact selection in an opaque session", async () => {
  const { manager } = makeHarness({ selections: ["first\nsecond 😀"] });
  const result = await manager.captureSelectedText();

  assert.equal(result.status, "selected");
  assert.equal(result.text, "first\nsecond 😀");
  assert.equal(result.characterCount, 14);
  assert.ok(result.sessionId);
});

test("captures a verified writable caret in an opaque delivery session", async () => {
  const { manager } = makeHarness({ selections: [{ state: "none", editable: true }] });
  const result = await manager.captureSelectedText({ probeEditable: true });

  assert.equal(result.status, "editable");
  assert.ok(result.sessionId);
});

test("the editable probe only runs when the capture requests it", async () => {
  const { manager } = makeHarness({ selections: [{ state: "none", editable: true }] });
  manager._isTerminalPid = async () => {
    throw new Error("must not resolve terminal identity without probeEditable");
  };

  assert.equal((await manager.captureSelectedText()).status, "none");
});

test("pastes an assistant response only while the captured caret target is still editable", async () => {
  const { manager, pastes } = makeHarness({
    selections: [
      { state: "none", editable: true },
      { state: "none", editable: true },
    ],
  });
  const capture = await manager.captureSelectedText({ probeEditable: true });
  const result = await manager.pasteAtCapturedTarget(capture.sessionId, "Agent response", {
    restoreClipboard: true,
  });

  assert.deepEqual(result, { success: true });
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0].text, "Agent response");
  assert.equal(pastes[0].options.restoreClipboard, true);
});

test("does not paste an assistant response after the captured caret target changes", async () => {
  const { manager, pastes } = makeHarness({
    selections: [
      { state: "none", editable: true },
      { state: "selected", text: "new selection" },
    ],
  });
  const capture = await manager.captureSelectedText({ probeEditable: true });

  assert.deepEqual(await manager.pasteAtCapturedTarget(capture.sessionId, "Agent response"), {
    success: false,
    code: "target_changed",
  });
  assert.equal(pastes.length, 0);
});

// Generated text pasted into a shell executes on its embedded newlines, so a
// terminal's empty prompt must never read as a writable caret.
test("a macOS terminal's empty prompt never becomes a caret delivery target", async () => {
  const { manager } = makeHarness({ selections: [{ state: "none", editable: true }] });
  manager.clipboardManager.isTerminalSignature = (signature) =>
    signature.toLowerCase().includes("iterm");
  manager._readExecutablePath = async () => "/Applications/iTerm.app/Contents/MacOS/iTerm2";

  assert.equal((await manager.captureSelectedText({ probeEditable: true })).status, "none");
});

test("a terminal-flagged target is refused as a caret destination without probing", async () => {
  const probes = [];
  const manager = new SelectionManager({
    clipboardManager: {
      isTerminalSignature: (signature) => signature.toLowerCase().includes("terminal"),
    },
    textEditMonitor: {
      isFocusedEditable: async (target) => {
        probes.push(target);
        return true;
      },
    },
    platform: "win32",
    now: () => 1000,
  });
  const flagged = { kind: "win-hwnd", id: "1A", isTerminal: true };
  const byExeName = { kind: "win-hwnd", id: "2B", exeName: "WindowsTerminal.exe" };
  const editor = { kind: "win-hwnd", id: "3C", exeName: "notepad.exe" };

  assert.equal(
    (await manager._markEditableCaret({ status: "none", target: flagged }, flagged, true)).status,
    "none"
  );
  assert.equal(
    (await manager._markEditableCaret({ status: "none", target: byExeName }, byExeName, true))
      .status,
    "none"
  );
  assert.equal(probes.length, 0);
  assert.equal(
    (await manager._markEditableCaret({ status: "none", target: editor }, editor, true)).status,
    "editable"
  );
  assert.equal(probes.length, 1);
});

// AT-SPI targets carry only a pid — no window class or exe name for the
// signature check — so the executable name must be resolved before a Wayland
// terminal's empty prompt can read as a writable caret.
test("a Linux AT-SPI terminal pid never becomes a caret delivery target", async () => {
  const probes = [];
  const executableByPid = { 4321: "gnome-terminal-", 8765: "gedit" };
  const manager = new SelectionManager({
    clipboardManager: {
      isTerminalSignature: (signature) => signature.toLowerCase().includes("gnome-terminal"),
    },
    textEditMonitor: {
      isFocusedEditable: async (target) => {
        probes.push(target);
        return true;
      },
    },
    platform: "linux",
    now: () => 1000,
  });
  manager._readExecutablePath = async (pid) => executableByPid[pid] ?? "";
  const terminal = { kind: "atspi-pid", id: "4321" };
  const editor = { kind: "atspi-pid", id: "8765" };

  assert.equal(
    (await manager._markEditableCaret({ status: "none", target: terminal }, terminal, true))
      .status,
    "none"
  );
  assert.equal(probes.length, 0, "a terminal pid must be refused without probing");
  assert.equal(
    (await manager._markEditableCaret({ status: "none", target: editor }, editor, true)).status,
    "editable"
  );
  assert.equal(probes.length, 1);
});

test("treats a clipboard-only fallback as a failed targeted paste", async () => {
  const { manager, pastes } = makeHarness({
    selections: [
      { state: "none", editable: true },
      { state: "none", editable: true },
    ],
    pasteResult: { restoreComplete: Promise.resolve(), pasted: false },
  });
  const capture = await manager.captureSelectedText({ probeEditable: true });

  assert.deepEqual(await manager.pasteAtCapturedTarget(capture.sessionId, "Agent response"), {
    success: false,
    code: "paste_failed",
  });
  assert.equal(pastes.length, 1);
});

test("replaces only when target and exact selection still match", async () => {
  const { manager, pastes } = makeHarness({ selections: ["original", "original"] });
  const capture = await manager.captureSelectedText();
  const result = await manager.replaceSelectedText(capture.sessionId, "improved", {
    restoreClipboard: true,
  });

  assert.deepEqual(result, { success: true });
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0].text, "improved");
  assert.equal(pastes[0].options.restoreClipboard, true);
});

test("does not paste when the selection changed", async () => {
  const { manager, pastes } = makeHarness({ selections: ["original", "different"] });
  const capture = await manager.captureSelectedText();
  const result = await manager.replaceSelectedText(capture.sessionId, "improved");

  assert.deepEqual(result, { success: false, code: "selection_changed" });
  assert.equal(pastes.length, 0);
});

test("selection sessions are single-use", async () => {
  const { manager } = makeHarness({ selections: ["original", "original", "original"] });
  const capture = await manager.captureSelectedText();
  assert.equal((await manager.replaceSelectedText(capture.sessionId, "first")).success, true);
  assert.deepEqual(await manager.replaceSelectedText(capture.sessionId, "second"), {
    success: false,
    code: "session_expired",
  });
});

test("expired sessions fail without reading or replacing the selection", async () => {
  let currentTime = 1000;
  const { manager, pastes } = makeHarness({
    selections: ["original", "original"],
    now: () => currentTime,
  });
  const capture = await manager.captureSelectedText();
  currentTime += 5 * 60 * 1000 + 1;

  assert.deepEqual(await manager.replaceSelectedText(capture.sessionId, "improved"), {
    success: false,
    code: "session_expired",
  });
  assert.equal(pastes.length, 0);
});

test("oversized selections are rejected before creating a session", async () => {
  const { manager } = makeHarness({ selections: ["x".repeat(6001)] });
  assert.deepEqual(await manager.captureSelectedText(), {
    status: "too_large",
    characterCount: 6001,
    maxCharacters: 6000,
  });
  assert.equal(manager.sessions.size, 0);
});

// Exercises the clipboard-sentinel path (Windows/Linux) with injected
// clipboard reads, covering the KDE desync guard: a clipboard side the
// sentinel write never reached must not be mistaken for the copied selection.
function makeCaptureHarness({ readClipboard }) {
  const writes = [];
  const clipboardManager = {
    runClipboardOperation: (operation) => operation(),
    _saveClipboard: () => ({ type: "text", data: "user clipboard" }),
    _restoreClipboard: () => {},
    _writeClipboardTextAll: (text) => writes.push(text),
    _readClipboardTextAll: () => readClipboard(writes),
  };
  const manager = new SelectionManager({
    clipboardManager,
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  return { manager, writes };
}

const CAPTURE_TARGET = { kind: "x11-window", id: "7" };

test("stale text on a desynced clipboard side is never treated as the selection", async () => {
  const { manager, writes } = makeCaptureHarness({
    readClipboard: (written) => ["stale text", written[0]],
  });
  const result = await manager._captureViaClipboard(
    async () => ({ success: true, target: CAPTURE_TARGET }),
    null
  );

  assert.equal(result.status, "none");
  assert.equal(writes.at(-1), "user clipboard");
});

test("a copy that replaces the sentinel is captured and the clipboard restored", async () => {
  let polled = false;
  const { manager, writes } = makeCaptureHarness({
    readClipboard: (written) => {
      if (written.length === 0) return ["user clipboard"];
      if (!polled) {
        polled = true;
        return [written[0]];
      }
      return ["copied selection", written[0]];
    },
  });
  const result = await manager._captureViaClipboard(
    async () => ({ success: true, target: CAPTURE_TARGET }),
    null
  );

  assert.equal(result.status, "selected");
  assert.equal(result.text, "copied selection");
  assert.equal(writes.at(-1), "user clipboard");
});

// A line copy (one line + trailing terminator) from an empty-selection Ctrl+C
// in editors like VS Code must never be mistaken for a real selection.
const VSCODE_TARGET = { kind: "x11-window", id: "7", windowClass: "code" };

function makeLineCopyHarness(copiedText) {
  let polled = false;
  return makeCaptureHarness({
    readClipboard: (written) => {
      if (written.length === 0) return ["user clipboard"];
      if (!polled) {
        polled = true;
        return [written[0]];
      }
      return [copiedText, written[0]];
    },
  });
}

test("a line copy from an empty selection in a line-copy editor reads as no selection", async () => {
  const { manager, writes } = makeLineCopyHarness("const x = 1;\r\n");
  const result = await manager._captureViaClipboard(
    async () => ({ success: true, target: VSCODE_TARGET }),
    VSCODE_TARGET
  );

  assert.equal(result.status, "none");
  assert.equal(writes.at(-1), "user clipboard");
});

test("a multi-line selection in a line-copy editor is still captured", async () => {
  const { manager } = makeLineCopyHarness("first line\nsecond line\n");
  const result = await manager._captureViaClipboard(
    async () => ({ success: true, target: VSCODE_TARGET }),
    VSCODE_TARGET
  );

  assert.equal(result.status, "selected");
  assert.equal(result.text, "first line\nsecond line\n");
});

test("a trailing-newline selection outside line-copy editors is still captured", async () => {
  const { manager } = makeLineCopyHarness("whole line\n");
  const firefoxTarget = { kind: "x11-window", id: "7", windowClass: "org.mozilla.firefox" };
  const result = await manager._captureViaClipboard(
    async () => ({ success: true, target: firefoxTarget }),
    firefoxTarget
  );

  assert.equal(result.status, "selected");
  assert.equal(result.text, "whole line\n");
});

test("does not overwrite a clipboard value copied while capture is in flight", async () => {
  let userCopied = false;
  const { manager, writes } = makeCaptureHarness({
    readClipboard: (written) => {
      if (written.length === 0) return ["user clipboard"];
      return userCopied ? ["new user clipboard", written[0]] : ["user clipboard", written[0]];
    },
  });

  const result = await manager._captureViaClipboard(async () => {
    userCopied = true;
    return { success: false };
  }, null);

  assert.deepEqual(result, { status: "unavailable", code: "copy_failed" });
  assert.equal(writes.at(-1), "new user clipboard");
});

// captureTarget() fires on every toggle press, including stop, and the AT-SPI
// probe can outlive fast cloud transcription. Reading lastTarget before the
// stop-press probe lands must wait for it instead of failing closed.
test("captureSelectedText awaits an in-flight target probe before reading lastTarget", async () => {
  const clipboardManager = { runClipboardOperation: (operation) => operation() };
  const manager = new SelectionManager({
    clipboardManager,
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  let resolveProbe;
  manager._getLinuxTarget = () => new Promise((resolve) => (resolveProbe = resolve));
  manager._readCurrentSelection = async (expectedTarget) =>
    expectedTarget
      ? { status: "selected", text: "picked", target: expectedTarget }
      : { status: "unavailable", code: "target_unavailable" };

  const probe = manager.captureTarget();
  const read = manager.captureSelectedText();
  resolveProbe({ kind: "atspi-pid", id: "2524568" });
  await probe;

  const result = await read;
  assert.equal(result.status, "selected");
  assert.equal(result.text, "picked");
});

test("a superseded probe never overwrites the newer probe's target", async () => {
  const clipboardManager = { runClipboardOperation: (operation) => operation() };
  const manager = new SelectionManager({
    clipboardManager,
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  const resolvers = [];
  manager._getLinuxTarget = () => new Promise((resolve) => resolvers.push(resolve));

  const first = manager.captureTarget();
  const second = manager.captureTarget();
  resolvers[1]({ kind: "atspi-pid", id: "2" });
  await second;
  resolvers[0]({ kind: "atspi-pid", id: "1" });
  await first;

  assert.deepEqual(manager.lastTarget, { kind: "atspi-pid", id: "2" });
});

// The Windows paste path restores the window captured at record start (#859).
// getWinTargetHwnd hands the paste that HWND exactly as --detect-only printed
// it ("TARGET %p", hex) so the binary's base-16 --restore-window parse round-trips.
test("getWinTargetHwnd returns the hex HWND a win32 probe captured (#859)", async () => {
  const spawnCalls = [];
  const SpawningSelectionManager = loadSelectionManager({
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      const probe = new EventEmitter();
      probe.stdout = new EventEmitter();
      probe.stderr = new EventEmitter();
      process.nextTick(() => {
        probe.stdout.emit(
          "data",
          "TARGET 00001A2B\nWINDOW_CLASS Chrome_WidgetWin_1\nIS_TERMINAL false\n"
        );
        probe.emit("close", 0);
      });
      return probe;
    },
  });
  const manager = new SpawningSelectionManager({
    clipboardManager: { resolveWindowsFastPasteBinary: () => "/tmp/windows-fast-paste.exe" },
    textEditMonitor: {},
    platform: "win32",
    now: () => 1000,
  });

  await manager.captureTarget();

  assert.deepEqual(spawnCalls, [
    { command: "/tmp/windows-fast-paste.exe", args: ["--detect-only"] },
  ]);
  assert.equal(await manager.getWinTargetHwnd(), "00001A2B");
});

// captureTarget() nulls lastTarget while its probe runs; a paste racing the
// stop-press probe must wait for the answer instead of restoring nothing.
test("getWinTargetHwnd waits for an in-flight probe before answering", async () => {
  const manager = new SelectionManager({
    clipboardManager: {},
    textEditMonitor: {},
    platform: "win32",
    now: () => 1000,
  });
  let resolveProbe;
  manager._probeTarget = () => new Promise((resolve) => (resolveProbe = resolve));

  const probe = manager.captureTarget();
  const pending = manager.getWinTargetHwnd();
  resolveProbe({ kind: "win-hwnd", id: "0000F00D" });
  await probe;

  assert.equal(await pending, "0000F00D");
});

test("getWinTargetHwnd is null without a capture or with a non-Windows target", async () => {
  const manager = new SelectionManager({
    clipboardManager: {},
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  assert.equal(await manager.getWinTargetHwnd(), null);

  manager.lastTarget = { kind: "x11-window", id: "7" };
  assert.equal(await manager.getWinTargetHwnd(), null);
});

test("caret delivery pins the captured Windows HWND into the paste helper", async () => {
  const pastes = [];
  const manager = new SelectionManager({
    clipboardManager: {
      runClipboardOperation: (operation) => operation(),
      _pasteText: async (text, options) => {
        pastes.push({ text, options });
        return { restoreComplete: Promise.resolve() };
      },
    },
    textEditMonitor: {},
    platform: "win32",
    now: () => 1000,
  });
  manager.sessions.set("caret-session", {
    kind: "caret",
    target: { kind: "win-hwnd", id: "00001A2B" },
    expiresAt: 2000,
  });
  manager._readCurrentSelection = async () => ({ status: "editable" });

  assert.deepEqual(await manager.pasteAtCapturedTarget("caret-session", "Agent response"), {
    success: true,
  });
  assert.equal(pastes[0].options.targetWindow, "00001A2B");
});

// Replacement text typed into a shell executes on its embedded newlines, so a
// terminal target must read as no selection (standalone dictation), not as an
// editable selection.
test("a terminal target reads as no selection", async () => {
  const clipboardManager = {
    runClipboardOperation: (operation) => operation(),
    isLinuxTerminalWindowClass: (windowClass) => windowClass === "konsole",
  };
  const manager = new SelectionManager({
    clipboardManager,
    textEditMonitor: { isFocusedEditable: async () => true },
    platform: "linux",
    now: () => 1000,
  });
  const terminalTarget = { kind: "kde-window", id: "9", windowClass: "konsole" };
  manager._getLinuxTarget = async () => terminalTarget;

  const result = await manager._readLinuxSelection(null);
  assert.equal(result.status, "none");
  assert.deepEqual(result.target, terminalTarget);
});

// macOS accessibility never resolves a focused element in Chromium browsers, so
// a synthetic ⌘C is the only way to tell a real selection from an empty field.
function makeMacClipboardHarness({ copyOutput = "COPY_OK 42 Dia", copied = null } = {}) {
  const writes = [];
  // The copied text only becomes visible after the helper runs; anything on the
  // clipboard beforehand is baselined as stale.
  let copySent = false;
  const clipboardManager = {
    runClipboardOperation: (operation) => operation(),
    resolveFastPasteBinary: () => "/bin/macos-fast-paste",
    isTerminalSignature: (signature) => /ghostty|iterm|terminal/i.test(signature || ""),
    _saveClipboard: () => ({ type: "text", data: "user clipboard" }),
    _restoreClipboard: () => {},
    _writeClipboardTextAll: (text) => writes.push(text),
    _readClipboardTextAll: () => {
      if (writes.length === 0) return ["user clipboard"];
      return copySent && copied !== null ? [copied, writes[0]] : [writes[0]];
    },
  };
  const manager = new SelectionManager({
    clipboardManager,
    textEditMonitor: { lastTargetPid: 42, getSelectedText: async () => ({ state: "unavailable" }) },
    platform: "darwin",
    now: () => 1000,
  });
  manager._runCopyHelper = async () => {
    copySent = true;
    return { success: true, stdout: copyOutput, stderr: "" };
  };
  return { manager, writes };
}

test("an inaccessible macOS target falls back to a synthetic copy", async () => {
  const { manager, writes } = makeMacClipboardHarness({ copied: "the selected paragraph" });
  const result = await manager.captureSelectedText();

  assert.equal(result.status, "selected");
  assert.equal(result.text, "the selected paragraph");
  assert.equal(writes.at(-1), "user clipboard");
});

test("nothing selected in an inaccessible macOS target reads as no selection", async () => {
  const { manager } = makeMacClipboardHarness({ copied: null });
  assert.equal((await manager.captureSelectedText()).status, "none");
});

test("a copy landing in a different app than expected reports the target changed", async () => {
  const { manager } = makeMacClipboardHarness({
    copyOutput: "COPY_OK 99 Some Other App",
    copied: "text from the wrong app",
  });
  assert.equal((await manager.captureSelectedText()).status, "target_changed");
});

// Replacement text typed into a shell executes on its embedded newlines, and
// terminals without an accessibility tree reach editing only via this path.
test("a macOS terminal selection reads as no selection", async () => {
  const { manager } = makeMacClipboardHarness({
    copyOutput: "COPY_OK 42 Ghostty",
    copied: "rm -rf important",
  });
  assert.equal((await manager.captureSelectedText()).status, "none");
});

// A bare caret in VS Code copies the whole line, which must never be mistaken
// for a selection and silently rewritten.
test("a macOS line copy in a line-copy editor reads as no selection", async () => {
  const { manager } = makeMacClipboardHarness({
    copyOutput: "COPY_OK 42 Code",
    copied: "const x = 1;\n",
  });
  assert.equal((await manager.captureSelectedText()).status, "none");
});

test("a failed macOS copy stays non-fatal so the command still runs", async () => {
  const { manager } = makeMacClipboardHarness({ copied: null });
  manager._runCopyHelper = async () => ({ success: false, stdout: "", stderr: "" });

  assert.deepEqual(await manager.captureSelectedText(), {
    status: "unavailable",
    code: "accessibility_unavailable",
  });
});

test("a missing copy helper stays non-fatal so the command still runs", async () => {
  const { manager } = makeMacClipboardHarness();
  manager.clipboardManager.resolveFastPasteBinary = () => null;

  assert.deepEqual(await manager.captureSelectedText(), {
    status: "unavailable",
    code: "accessibility_unavailable",
  });
});

// The clipboard fallback is macOS-only; Windows and Linux keep their own capture
// paths untouched.
test("a win32 read never reaches the macOS clipboard fallback", async () => {
  let macCalled = false;
  const manager = new SelectionManager({
    clipboardManager: {
      runClipboardOperation: (operation) => operation(),
      resolveWindowsFastPasteBinary: () => null,
    },
    textEditMonitor: { lastTargetPid: 42 },
    platform: "win32",
    now: () => 1000,
  });
  manager._readMacSelectionViaClipboard = async () => {
    macCalled = true;
    return { status: "selected", text: "wrong platform" };
  };

  const result = await manager._readCurrentSelection({ kind: "win-hwnd", id: "7" });

  assert.equal(macCalled, false);
  assert.deepEqual(result, { status: "unavailable", code: "copy_helper_unavailable" });
});

test("empty replacement output is rejected without consuming a paste", async () => {
  const { manager, pastes } = makeHarness({ selections: ["original"] });
  const capture = await manager.captureSelectedText();
  assert.deepEqual(await manager.replaceSelectedText(capture.sessionId, ""), {
    success: false,
    code: "invalid_replacement",
  });
  assert.equal(pastes.length, 0);
});
