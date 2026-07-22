const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const selectionManagerPath = require.resolve("../../src/helpers/selectionManager");
const originalLoad = Module._load;

function loadSelectionManager() {
  delete require.cache[selectionManagerPath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { clipboard: { readText: () => "", writeText: () => {} } };
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

function makeHarness({ selections = ["original"], now = () => 1000 } = {}) {
  const reads = [...selections];
  const pastes = [];
  const textEditMonitor = {
    lastTargetPid: 42,
    activatePid: async (pid) => pid === 42,
    getSelectedText: async () => {
      const value = reads.shift();
      if (value === undefined) return { state: "unavailable" };
      if (value === null) return { state: "none" };
      return { state: "selected", text: value };
    },
  };
  const clipboardManager = {
    runClipboardOperation: (operation) => operation(),
    _pasteText: async (text, options) => {
      pastes.push({ text, options });
      return { restoreComplete: Promise.resolve() };
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

test("empty replacement output is rejected without consuming a paste", async () => {
  const { manager, pastes } = makeHarness({ selections: ["original"] });
  const capture = await manager.captureSelectedText();
  assert.deepEqual(await manager.replaceSelectedText(capture.sessionId, ""), {
    success: false,
    code: "invalid_replacement",
  });
  assert.equal(pastes.length, 0);
});
