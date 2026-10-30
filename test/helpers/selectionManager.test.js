const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const selectionManagerPath = require.resolve("../../src/helpers/selectionManager");
// selectionManager requires "./debugLogger" at load; the stub records every
// line so tests can assert what a declined paste leaves in the debug log.
const debugLoggerStub = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  trace: () => {},
  log: () => {},
  error: () => {},
};

const originalLoad = Module._load;

function loadSelectionManager({ spawn, execFile } = {}) {
  delete require.cache[selectionManagerPath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { clipboard: { readText: () => "", writeText: () => {} } };
    }
    if (request === "./debugLogger") {
      return debugLoggerStub;
    }
    if (request === "child_process" && (spawn || execFile)) {
      return { ...childProcess, ...(spawn && { spawn }), ...(execFile && { execFile }) };
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

test("macOS selection capture waits for the press-time PID lookup", async () => {
  const { manager } = makeHarness();
  let resolvePid;
  const monitor = manager.textEditMonitor;
  monitor.lastTargetPid = null;
  monitor._captureTargetPromise = new Promise((resolve) => {
    resolvePid = resolve;
  });
  let settled = false;
  const capture = manager.captureSelectedText().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a pending target is not reported as unavailable");
  monitor.lastTargetPid = 42;
  monitor._captureTargetPromise = null;
  resolvePid(42);
  const result = await capture;
  assert.equal(result.status, "selected");
  assert.equal(result.text, "original");
  assert.ok(result.sessionId);
});

// Answers keyed by the command line; anything else fails like a missing tool.
function loadWithExecFile(outputs) {
  return loadSelectionManager({
    execFile: (command, args, options, callback) => {
      const stdout = outputs[[command, ...args].join(" ")];
      callback(stdout === undefined ? new Error("failed") : null, stdout ?? "", "");
    },
  });
}

test("a Hyprland target carries the pid hyprctl reports", async () => {
  const activeWindow = (fields) => ({
    "hyprctl activewindow -j": JSON.stringify({ address: "0xabc", class: "Gedit", ...fields }),
  });
  const read = (outputs) =>
    new (loadWithExecFile(outputs))({
      clipboardManager: { commandExists: (command) => command === "hyprctl" },
      platform: "linux",
      now: () => 1000,
    })._getLinuxTarget();

  assert.deepEqual(await read(activeWindow({ pid: 444 })), {
    kind: "hyprland-window",
    id: "0xabc",
    windowClass: "gedit",
    pid: 444,
  });
  assert.equal((await read(activeWindow({}))).pid, null);
  assert.equal((await read(activeWindow({ pid: -1 }))).pid, null);
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

test("cancelling a selection edit while native revalidation waits prevents its paste", async () => {
  const { manager, pastes } = makeHarness({ selections: ["original"] });
  const capture = await manager.captureSelectedText();
  let finishRead;
  manager._readCurrentSelection = () => new Promise((resolve) => (finishRead = resolve));
  const replacement = manager.replaceSelectedText(capture.sessionId, "Late edit");
  manager.cancelSelectionEdit(capture.sessionId);
  finishRead({ status: "selected", text: "original", target: { kind: "mac-pid", pid: 42 } });
  assert.deepEqual(await replacement, { success: false, code: "cancelled" });
  assert.deepEqual(pastes, []);
});

// Keys still held past the modifier wait (#2113) block the edit at two points.
// Both must say so: "selection_unavailable" sends the user to permissions
// settings and "paste_failed" hides that the edit is on the clipboard.
test("a replacement blocked by held modifiers at revalidation reports modifiers_held", async () => {
  const { manager, pastes } = makeHarness({ selections: ["original"] });
  const capture = await manager.captureSelectedText();
  manager._readCurrentSelection = async () => ({ status: "unavailable", code: "modifiers_held" });

  assert.deepEqual(await manager.replaceSelectedText(capture.sessionId, "improved"), {
    success: false,
    code: "modifiers_held",
  });
  assert.equal(pastes.length, 0);
});

test("a replacement whose paste was held back for modifiers reports modifiers_held", async () => {
  const { manager, pastes } = makeHarness({
    selections: ["original", "original"],
    pasteResult: { restoreComplete: Promise.resolve(), pasted: false, reason: "modifiers-held" },
  });
  const capture = await manager.captureSelectedText();

  assert.deepEqual(await manager.replaceSelectedText(capture.sessionId, "improved"), {
    success: false,
    code: "modifiers_held",
  });
  assert.equal(pastes.length, 1);
});

// No Wayland clipboard written on wlroots, Hyprland or niri (#2621): the edit says
// why rather than "could not replace".
for (const [reason, code] of [
  ["wl-copy-missing", "wl_copy_missing"],
  ["wl-copy-failed", "wl_copy_failed"],
]) {
  test(`a replacement held back for ${reason} reports ${code}`, async () => {
    const { manager, pastes } = makeHarness({
      selections: ["original", "original"],
      pasteResult: { restoreComplete: Promise.resolve(), pasted: false, reason },
    });
    const capture = await manager.captureSelectedText();

    assert.deepEqual(await manager.replaceSelectedText(capture.sessionId, "improved"), {
      success: false,
      code,
    });
    assert.equal(pastes.length, 1);
  });
}

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
function makeCaptureHarness({ readClipboard, platform = "linux" }) {
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
    platform,
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

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: a selection already on the clipboard is captured after the sentinel`, async () => {
    let copySent = false;
    const { manager, writes } = makeCaptureHarness({
      platform,
      readClipboard: (written) =>
        written.length === 0 || copySent ? ["user clipboard"] : [written[0]],
    });
    const result = await manager._captureViaClipboard(async () => {
      copySent = true;
      return { success: true, target: CAPTURE_TARGET };
    }, null);

    assert.equal(result.status, "selected");
    assert.equal(result.text, "user clipboard");
    assert.equal(writes.at(-1), "user clipboard");
  });

  test(`${platform}: an unobserved sentinel does not turn old clipboard text into a selection`, async () => {
    const { manager } = makeCaptureHarness({
      platform,
      readClipboard: () => ["user clipboard"],
    });
    const result = await manager._captureViaClipboard(
      async () => ({ success: true, target: CAPTURE_TARGET }),
      null
    );

    assert.equal(result.status, "none");
  });
}

test("a Linux clipboard side that reappears after the sentinel remains stale", async () => {
  let copySent = false;
  const { manager } = makeCaptureHarness({
    readClipboard: (written) => {
      if (written.length === 0 || copySent) return ["user clipboard"];
      return [written[0]];
    },
  });
  const result = await manager._captureViaClipboard(async () => {
    copySent = true;
    return { success: true, target: CAPTURE_TARGET };
  }, null);

  assert.equal(result.status, "none");
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

test("start target captures share in-flight and recent work", async () => {
  let now = 1000;
  let calls = 0;
  const resolvers = [];
  const manager = new SelectionManager({
    clipboardManager: {},
    textEditMonitor: {},
    platform: "linux",
    now: () => now,
  });
  manager._probeTarget = () => {
    calls += 1;
    return new Promise((resolve) => resolvers.push(resolve));
  };

  const first = manager.captureTarget();
  const joined = manager.captureTarget();
  assert.equal(calls, 1);
  resolvers[0]({ kind: "atspi-pid", id: "1" });
  await Promise.all([first, joined]);

  const reused = manager.captureTarget();
  assert.equal(calls, 1);
  await reused;

  now += 250;
  const refreshed = manager.captureTarget();
  assert.equal(calls, 2);
  resolvers[1]({ kind: "atspi-pid", id: "2" });
  await refreshed;
});

test("a failed target probe is retried rather than reused", async () => {
  let calls = 0;
  const manager = new SelectionManager({
    clipboardManager: {},
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  manager._probeTarget = async () => {
    calls += 1;
    return null;
  };

  await manager.captureTarget();
  await manager.captureTarget();
  assert.equal(calls, 2);
});

test("a forced probe stays fresh and older work cannot overwrite it", async () => {
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
  const second = manager.captureTarget({ force: true });
  resolvers[1]({ kind: "atspi-pid", id: "2" });
  await second;
  resolvers[0]({ kind: "atspi-pid", id: "1" });
  await first;

  assert.deepEqual(manager.lastTarget, { kind: "atspi-pid", id: "2" });
});

test("Wayland target lookup attempts AT-SPI once", async () => {
  const spawnCalls = [];
  const SpawningSelectionManager = loadSelectionManager({
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => child.emit("close", 1));
      return child;
    },
  });
  const manager = new SpawningSelectionManager({
    clipboardManager: {
      _isWayland: () => true,
      commandExists: () => false,
      resolveLinuxFastPasteBinary: () => "/tmp/linux-fast-paste",
    },
    platform: "linux",
    now: () => 1000,
  });

  assert.equal(await manager._getLinuxTarget(), null);
  assert.equal(await manager._getLinuxTarget(), null);
  assert.deepEqual(spawnCalls, [
    { command: "/tmp/linux-fast-paste", args: ["--atspi-target"] },
    { command: "/tmp/linux-fast-paste", args: ["--atspi-target"] },
  ]);
});

test("an AT-SPI timeout opens a cooldown and retries after it expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1000;
  let spawns = 0;
  let kills = 0;
  const SpawningSelectionManager = loadSelectionManager({
    spawn: () => {
      spawns += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        kills += 1;
      };
      return child;
    },
  });
  const manager = new SpawningSelectionManager({
    clipboardManager: {
      resolveLinuxFastPasteBinary: () => "/tmp/linux-fast-paste",
    },
    platform: "linux",
    now: () => now,
  });

  const first = manager._getLinuxAtspiTarget();
  t.mock.timers.tick(2000);
  assert.equal(await first, null);
  assert.equal(spawns, 1);
  assert.equal(kills, 1);

  const cooledTarget = manager._getLinuxAtspiTarget();
  assert.equal(spawns, 1, "a target probe must not spawn during the cooldown");
  assert.equal(await cooledTarget, null);
  const cooledSelection = manager._readLinuxAtspiSelection("/tmp/linux-fast-paste", {
    kind: "atspi-pid",
    id: "42",
  });
  assert.equal(spawns, 1, "a selection read must not spawn during the cooldown");
  assert.equal((await cooledSelection).code, "accessibility_unavailable");

  now += 2000;
  const retry = manager._getLinuxAtspiTarget();
  t.mock.timers.tick(2000);
  assert.equal(await retry, null);
  assert.equal(spawns, 2);
  assert.equal(kills, 2);

  now += 2000;
  const selection = manager._readLinuxAtspiSelection("/tmp/linux-fast-paste", {
    kind: "atspi-pid",
    id: "42",
  });
  t.mock.timers.tick(1200);
  assert.equal((await selection).status, "unavailable");
  assert.equal(spawns, 3);
  assert.equal(kills, 3);
  const cooledBySelection = manager._getLinuxAtspiTarget();
  assert.equal(spawns, 3, "a selection timeout must cool down target probes too");
  assert.equal(await cooledBySelection, null);
});

test("older AT-SPI timeouts cannot cool down a newer successful probe", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let spawns = 0;
  const SpawningSelectionManager = loadSelectionManager({
    spawn: () => {
      spawns += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      if (spawns >= 3) {
        process.nextTick(() => {
          child.stdout.emit("data", "TARGET ATSPI 42\n");
          child.emit("close", 0);
        });
      }
      return child;
    },
  });
  const manager = new SpawningSelectionManager({
    clipboardManager: {
      resolveLinuxFastPasteBinary: () => "/tmp/linux-fast-paste",
    },
    platform: "linux",
    now: () => 1000,
  });

  const olderTarget = manager._getLinuxAtspiTarget();
  const olderSelection = manager._readLinuxAtspiSelection("/tmp/linux-fast-paste", {
    kind: "atspi-pid",
    id: "42",
  });
  const newer = manager._getLinuxAtspiTarget();
  assert.deepEqual(await newer, { kind: "atspi-pid", id: "42" });
  t.mock.timers.tick(2000);
  assert.equal(await olderTarget, null);
  assert.equal((await olderSelection).status, "unavailable");

  const next = manager._getLinuxAtspiTarget();
  assert.equal(spawns, 4, "neither older timeout may open a cooldown");
  assert.deepEqual(await next, { kind: "atspi-pid", id: "42" });
});

// The Windows paste path restores the window captured at record start (#859).
// getWinTarget hands the paste that HWND exactly as --detect-only printed
// it ("TARGET %p", hex) so the binary's base-16 --restore-window parse round-trips.
test("getWinTarget returns the hex HWND a win32 probe captured (#859)", async () => {
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
  assert.equal((await manager.getWinTarget())?.id, "00001A2B");
});

// The paste helper pastes into whatever is in front when its restore fails, so a paste
// that may only land in one window asks first whether that window came forward.
test("restoreWinTarget is true only when the captured window is in front afterwards", async () => {
  const spawnCalls = [];
  let front = "00001A2B";
  let exitCode = 0;
  const SpawningSelectionManager = loadSelectionManager({
    spawn: (command, args) => {
      spawnCalls.push(args);
      const probe = new EventEmitter();
      probe.stdout = new EventEmitter();
      probe.stderr = new EventEmitter();
      process.nextTick(() => {
        probe.stdout.emit("data", `TARGET ${front}\nIS_TERMINAL false\n`);
        probe.emit("close", exitCode);
      });
      return probe;
    },
  });
  let binary = "/tmp/windows-fast-paste.exe";
  const manager = new SpawningSelectionManager({
    clipboardManager: { resolveWindowsFastPasteBinary: () => binary },
    textEditMonitor: {},
    platform: "win32",
  });
  const terminal = { kind: "win-hwnd", id: "0x1a2b" };

  assert.equal(await manager.restoreWinTarget(terminal), true, "same handle, other spelling");
  assert.deepEqual(spawnCalls[0], ["--restore-window", "0x1a2b", "--detect-only"]);

  front = "00009999";
  assert.equal(await manager.restoreWinTarget(terminal), false, "another window came forward");

  front = "00001A2B";
  exitCode = 2;
  assert.equal(await manager.restoreWinTarget(terminal), false, "the helper failed");

  exitCode = 0;
  assert.equal(await manager.restoreWinTarget({ kind: "win-hwnd", id: "junk" }), false);
  assert.equal(await manager.restoreWinTarget({ kind: "x11-window", id: "7" }), false);

  binary = null;
  assert.equal(await manager.restoreWinTarget(terminal), false, "no helper, no paste");
});

test("the app context of a win32 target carries its exe, class and window title", async () => {
  const SpawningSelectionManager = loadSelectionManager({
    spawn: () => {
      const probe = new EventEmitter();
      probe.stdout = new EventEmitter();
      probe.stderr = new EventEmitter();
      process.nextTick(() => {
        probe.stdout.emit(
          "data",
          "TARGET 00001A2B\nWINDOW_CLASS Chrome_WidgetWin_1\nEXE_NAME chrome.exe\n" +
            "WINDOW_TITLE Inbox - Gmail - Google Chrome\nIS_TERMINAL false\n"
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

  const capture = manager.captureTarget();
  const context = manager.getTargetAppContext();
  await capture;

  assert.deepEqual(await context, {
    appSignature: "chrome.exe Chrome_WidgetWin_1",
    windowTitle: "Inbox - Gmail - Google Chrome",
  });
  // The title stays in the main process: the target itself never carries it.
  assert.equal(JSON.stringify(manager.lastTarget).includes("Inbox"), false);
});

test("the app context of a macOS target names the app from its pid", async () => {
  const manager = new SelectionManager({
    clipboardManager: {},
    textEditMonitor: {
      lastTargetPid: 42,
      getAppContext: async (pid) =>
        pid === 42
          ? { appName: "Google Chrome", bundleId: "com.google.Chrome", urlHost: "mail.google.com" }
          : null,
    },
    platform: "darwin",
    now: () => 1000,
  });

  assert.deepEqual(await manager.getTargetAppContext(), {
    appSignature: "Google Chrome com.google.Chrome",
    windowTitle: undefined,
    urlHost: "mail.google.com",
  });
});

test("an X11 target's window title is read only when the app context is asked for", async () => {
  const calls = [];
  const ExecSelectionManager = loadSelectionManager({
    execFile: (command, args, _options, callback) => {
      calls.push([command, ...args]);
      callback(null, "Inbox - Gmail - Mozilla Firefox\n", "");
    },
  });
  const manager = new ExecSelectionManager({
    clipboardManager: {},
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  manager.lastTarget = { kind: "x11-window", id: "7", windowClass: "firefox" };

  assert.deepEqual(await manager.getTargetAppContext(), {
    appSignature: "firefox",
    windowTitle: "Inbox - Gmail - Mozilla Firefox",
  });
  assert.deepEqual(calls, [["xdotool", "getwindowname", "7"]]);
});

test("an AT-SPI target is named from its pid and titled from its window", async () => {
  let stdout = "";
  const SpawningSelectionManager = loadSelectionManager({
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.emit("data", stdout);
        child.emit("close", 0);
      });
      return child;
    },
  });
  const manager = new SpawningSelectionManager({
    clipboardManager: { resolveLinuxFastPasteBinary: () => "/tmp/linux-fast-paste" },
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  manager._readTargetNames = async (pid) => (pid === "42" ? "chrome" : "");
  const title = "Inbox - Gmail - Google Chrome";

  stdout = `TARGET ATSPI 42\nWINDOW_TITLE_B64 ${Buffer.from(title).toString("base64")}\n`;
  manager.lastTarget = await manager._getLinuxAtspiTarget();
  assert.deepEqual(manager.lastTarget, { kind: "atspi-pid", id: "42" });
  assert.deepEqual(await manager.getTargetAppContext(), {
    appSignature: "chrome",
    windowTitle: title,
  });

  // An older helper prints no title.
  stdout = "TARGET ATSPI 42\n";
  manager.lastTarget = await manager._getLinuxAtspiTarget();
  assert.deepEqual(await manager.getTargetAppContext(), {
    appSignature: "chrome",
    windowTitle: null,
  });
  assert.equal(
    await new SelectionManager({ platform: "linux", textEditMonitor: {} }).getTargetAppContext(),
    null
  );
});

// captureTarget() nulls lastTarget while its probe runs; a paste racing the
// stop-press probe must wait for the answer instead of restoring nothing.
test("getWinTarget waits for an in-flight probe before answering", async () => {
  const manager = new SelectionManager({
    clipboardManager: {},
    textEditMonitor: {},
    platform: "win32",
    now: () => 1000,
  });
  let resolveProbe;
  manager._probeTarget = () => new Promise((resolve) => (resolveProbe = resolve));

  const probe = manager.captureTarget();
  const pending = manager.getWinTarget();
  resolveProbe({ kind: "win-hwnd", id: "0000F00D" });
  await probe;

  assert.equal((await pending)?.id, "0000F00D");
});

test("getWinTarget is null without a capture or with a non-Windows target", async () => {
  const manager = new SelectionManager({
    clipboardManager: {},
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  assert.equal(await manager.getWinTarget(), null);

  manager.lastTarget = { kind: "x11-window", id: "7" };
  assert.equal(await manager.getWinTarget(), null);
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
    platform: "linux",
    now: () => 1000,
  });
  const terminalTarget = { kind: "kde-window", id: "9", windowClass: "konsole" };
  manager._getLinuxTarget = async () => terminalTarget;

  const result = await manager._readLinuxSelection(null);
  assert.equal(result.status, "none");
  assert.deepEqual(result.target, terminalTarget);
});

// Capture runs right after the voice assistant hotkey press, while its keys are
// often still down. A Ctrl+C sent into them copies nothing, so capture waits for
// the release and fails closed when the keys stay held.
for (const [modifiers, expectCopy] of [
  ["held", false],
  ["released", true],
  ["unknown", true],
]) {
  test(`Linux selection capture ${expectCopy ? "copies" : "sends no copy"} when modifiers are ${modifiers}`, async () => {
    let copyAttempts = 0;
    const manager = new SelectionManager({
      clipboardManager: {
        runClipboardOperation: (operation) => operation(),
        isLinuxTerminalWindowClass: () => false,
        resolveLinuxFastPasteBinary: () => "/tmp/linux-fast-paste",
        _awaitModifierRelease: async () => ({ state: modifiers, waitedMs: 0 }),
      },
      textEditMonitor: {},
      platform: "linux",
      now: () => 1000,
    });
    const target = { kind: "x11-window", id: "7", windowClass: "org.gnome.texteditor" };
    manager._getLinuxTarget = async () => target;
    manager._captureViaClipboard = async () => {
      copyAttempts += 1;
      return { status: "none", target };
    };

    const result = await manager._readLinuxSelection(null);

    assert.equal(copyAttempts, expectCopy ? 1 : 0);
    assert.deepEqual(
      result,
      expectCopy ? { status: "none", target } : { status: "unavailable", code: "modifiers_held" }
    );
  });
}

// The target was classified before the wait. If focus moved while the keys were
// held (say, to a terminal), a copy chord would reach a window nobody checked:
// a plain Ctrl+C there interrupts whatever is running.
for (const [waitedMs, focusMoved, expectCopy] of [
  [400, true, false],
  [400, false, true],
  [0, true, true],
]) {
  test(`Linux selection capture ${expectCopy ? "copies" : "sends no copy"} after a ${waitedMs} ms wait when focus ${focusMoved ? "moved" : "stayed"}`, async () => {
    let copyAttempts = 0;
    let targetReads = 0;
    const manager = new SelectionManager({
      clipboardManager: {
        runClipboardOperation: (operation) => operation(),
        isLinuxTerminalWindowClass: (windowClass) => windowClass === "konsole",
        resolveLinuxFastPasteBinary: () => "/tmp/linux-fast-paste",
        _awaitModifierRelease: async () => ({ state: "released", waitedMs }),
      },
      textEditMonitor: {},
      platform: "linux",
      now: () => 1000,
    });
    const target = { kind: "kde-window", id: "7", windowClass: "kate" };
    const terminal = { kind: "kde-window", id: "9", windowClass: "konsole" };
    manager._getLinuxTarget = async () => {
      targetReads += 1;
      return targetReads > 1 && focusMoved ? terminal : target;
    };
    manager._captureViaClipboard = async () => {
      copyAttempts += 1;
      return { status: "none", target };
    };

    const result = await manager._readLinuxSelection(null);

    assert.equal(copyAttempts, expectCopy ? 1 : 0);
    assert.equal(targetReads, waitedMs > 0 ? 2 : 1, "only a real wait pays for a second lookup");
    if (!expectCopy) assert.deepEqual(result, { status: "target_changed", code: "focus_moved" });
  });
}

test("a Linux session revalidation declines when focus moved during the modifier wait", async () => {
  let targetReads = 0;
  let pastes = 0;
  const manager = new SelectionManager({
    clipboardManager: {
      runClipboardOperation: (operation) => operation(),
      isLinuxTerminalWindowClass: () => false,
      resolveLinuxFastPasteBinary: () => "/tmp/linux-fast-paste",
      _awaitModifierRelease: async () => ({ state: "released", waitedMs: 400 }),
      _pasteText: async () => {
        pastes += 1;
        return { pasted: true };
      },
    },
    textEditMonitor: {},
    platform: "linux",
    now: () => 1000,
  });
  const target = { kind: "kde-window", id: "7", windowClass: "kate" };
  const other = { kind: "kde-window", id: "9", windowClass: "konsole" };
  manager._getLinuxTarget = async () => (++targetReads % 2 === 0 ? other : target);
  manager.sessions.set("edit", { text: "old", target, expiresAt: 2000 });

  assert.deepEqual(await manager.replaceSelectedText("edit", "new"), {
    success: false,
    code: "target_changed",
  });
  assert.equal(pastes, 0);
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
