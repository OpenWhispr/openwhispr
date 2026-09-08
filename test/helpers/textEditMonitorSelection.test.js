const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

test("activateTargetPid resolves false when no target PID was captured", async () => {
  const m = new TextEditMonitor();
  m.lastTargetPid = null;
  assert.equal(await m.activateTargetPid(), false);
});

test("activateTargetPid resolves false for an unmapped PID", async () => {
  const m = new TextEditMonitor();
  // Non-darwin short-circuits; darwin can't make a non-existent PID frontmost,
  // so the confirm poll times out. Both resolve quickly to false rather than
  // reporting a target that was never frontmost as active.
  m.lastTargetPid = 99999999;
  const start = Date.now();
  const result = await m.activateTargetPid();
  assert.equal(result, false);
  assert.ok(Date.now() - start < 3000);
});

test("getSelectedText fails closed for a missing target", async () => {
  const m = new TextEditMonitor();
  assert.deepEqual(await m.getSelectedText(null), { state: "unavailable" });
});

test("getSelectedText returns unavailable for an inaccessible target", async () => {
  const m = new TextEditMonitor();
  const start = Date.now();
  assert.deepEqual(await m.getSelectedText(99999999, 1500), { state: "unavailable" });
  assert.ok(Date.now() - start < 3000);
});

const darwinOnly = { skip: process.platform !== "darwin" };

test("startMonitoring stops immediately without a target PID", darwinOnly, () => {
  const m = new TextEditMonitor();
  m.startMonitoring("pasted text", 5000, { targetPid: null });
  assert.equal(m.currentOriginalText, null);
  assert.equal(m.process, null);
});

test(
  "startMonitoring self-terminates when the target has no accessible focused element",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    // Auto-learn must degrade by giving up (NO_ELEMENT → stopMonitoring), never by
    // writing AX attributes like AXEnhancedUserInterface onto the target app —
    // that flag blurs the focused editor in some Chromium apps (see module comment).
    m.startMonitoring("pasted text", 4000, { targetPid: 99999999 });
    const deadline = Date.now() + 6000;
    while (m.currentOriginalText !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(m.currentOriginalText, null);
    assert.equal(m.process, null);
    assert.equal(m._pollInterval, null);
  }
);

// AXError -25212 (kAXErrorNoValue) marks apps whose AX tree never yields a
// focused element to us (Chromium/Electron); the native binary's retry loop is
// deterministic dead time there, so one failure routes the PID to AppleScript
// for the rest of the session.
test("getSelectedText caches a -25212 native failure per PID", darwinOnly, async () => {
  const m = new TextEditMonitor();
  m.resolveBinary = () => ({
    command: "/bin/sh",
    args: [
      "-c",
      'echo "Attempt 1/5: Cannot get focused element for PID 42 (error: -25212)" >&2; echo "UNAVAILABLE:"; exit 1',
    ],
  });
  m._getSelectedTextViaAppleScript = (pid, timeoutMs, resolve) => resolve({ state: "none" });

  assert.deepEqual(await m.getSelectedText(42), { state: "none" });
  assert.ok(m._nativeSelectionUnsupportedPids.has(42));
});

test("getSelectedText skips the native binary for a cached PID", darwinOnly, async () => {
  const m = new TextEditMonitor();
  // The trailing --selected-text args land in the -c script's $0/$1.
  m.resolveBinary = () => ({ command: "/bin/sh", args: ["-c", 'echo "SELECTED:native"'] });
  m._getSelectedTextViaAppleScript = (pid, timeoutMs, resolve) => resolve({ state: "none" });

  assert.deepEqual(await m.getSelectedText(42), { state: "selected", text: "native" });

  m._nativeSelectionUnsupportedPids.add(42);
  assert.deepEqual(await m.getSelectedText(42), { state: "none" });
});

test("getSelectedText identifies an empty writable field", darwinOnly, async () => {
  const m = new TextEditMonitor();
  m.resolveBinary = () => ({ command: "/bin/sh", args: ["-c", 'echo "EDITABLE_NONE:"'] });

  assert.deepEqual(await m.getSelectedText(42), { state: "none", editable: true });
});

test("isFocusedEditable accepts only an explicit native editable verdict", darwinOnly, async () => {
  const editable = new TextEditMonitor();
  editable.resolveBinary = () => ({ command: "/bin/sh", args: ["-c", 'echo "EDITABLE"'] });
  const readOnly = new TextEditMonitor();
  readOnly.resolveBinary = () => ({
    command: "/bin/sh",
    args: ["-c", 'echo "NOT_EDITABLE"'],
  });

  assert.equal(await editable.isFocusedEditable({ kind: "mac-pid", pid: 42 }), true);
  assert.equal(await readOnly.isFocusedEditable({ kind: "mac-pid", pid: 42 }), false);
});

test("isFocusedEditable answers from a stale binary's first monitor line", darwinOnly, async () => {
  const m = new TextEditMonitor();
  // A binary that predates the probe flag falls into monitor mode: one
  // initial-value line, then it keeps running. The probe must settle on that
  // first line instead of hanging until the timeout.
  m.resolveBinary = () => ({
    command: "/bin/sh",
    args: ["-c", 'echo "INITIAL_VALUE:stale"; sleep 2'],
  });

  const startedAt = Date.now();
  assert.equal(await m.isFocusedEditable({ kind: "mac-pid", pid: 42 }), false);
  assert.ok(Date.now() - startedAt < 900, "must resolve on the first output line");
});

test("a non--25212 native failure is not cached", darwinOnly, async () => {
  const m = new TextEditMonitor();
  m.resolveBinary = () => ({
    command: "/bin/sh",
    args: [
      "-c",
      'echo "Attempt 1/5: Cannot get focused element for PID 42 (error: -25204)" >&2; echo "UNAVAILABLE:"; exit 1',
    ],
  });
  m._getSelectedTextViaAppleScript = (pid, timeoutMs, resolve) => resolve({ state: "none" });

  assert.deepEqual(await m.getSelectedText(42), { state: "none" });
  assert.equal(m._nativeSelectionUnsupportedPids.has(42), false);
});

test("a run where the AX tree woke mid-retry is not cached", darwinOnly, async () => {
  const m = new TextEditMonitor();
  // -25212 on attempt 1 was transient: the element resolved later, so the app
  // must stay eligible for native reads even though this read failed.
  m.resolveBinary = () => ({
    command: "/bin/sh",
    args: [
      "-c",
      'echo "Attempt 1/5: Cannot get focused element for PID 42 (error: -25212)" >&2; echo "Got focused element on attempt 3" >&2; echo "UNAVAILABLE:"; exit 1',
    ],
  });
  m._getSelectedTextViaAppleScript = (pid, timeoutMs, resolve) => resolve({ state: "none" });

  assert.deepEqual(await m.getSelectedText(42), { state: "none" });
  assert.equal(m._nativeSelectionUnsupportedPids.has(42), false);
});

test(
  "a monitor run ending in NO_ELEMENT with uniform -25212 teaches the cache",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    m.resolveBinary = () => ({
      command: "/bin/sh",
      args: [
        "-c",
        'echo "Attempt 5/5: Cannot get focused element for PID 4242 (error: -25212)" >&2; echo "NO_ELEMENT"',
      ],
    });

    m.startMonitoring("pasted text", 4000, { targetPid: 4242 });
    // The verdict lands on the child's "close" event, after monitoring stops.
    const deadline = Date.now() + 6000;
    while (!m._nativeSelectionUnsupportedPids.has(4242) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(m.currentOriginalText, null);
    assert.ok(m._nativeSelectionUnsupportedPids.has(4242));
  }
);

test("a timeout-killed selection read is not cached", darwinOnly, async () => {
  const m = new TextEditMonitor();
  // The child hangs after a -25212 line, so execFile kills it at the deadline
  // — the ladder never completed and a later attempt might have succeeded.
  m.resolveBinary = () => ({
    command: "/bin/sh",
    args: [
      "-c",
      'echo "Attempt 1/5: Cannot get focused element for PID 42 (error: -25212)" >&2; sleep 5',
    ],
  });
  m._getSelectedTextViaAppleScript = (pid, timeoutMs, resolve) => resolve({ state: "none" });

  assert.deepEqual(await m.getSelectedText(42, 400), { state: "none" });
  assert.equal(m._nativeSelectionUnsupportedPids.has(42), false);
});

test("startMonitoring skips the native monitor for a cached PID", darwinOnly, () => {
  const m = new TextEditMonitor();
  m.resolveBinary = () => ({ command: "/bin/echo", args: [] });
  m._nativeSelectionUnsupportedPids.add(42);
  m.startMonitoring("pasted text", 4000, { targetPid: 42 });
  // The cache check runs before the initial settle delay, so monitoring ends
  // synchronously — no doomed child process is ever spawned.
  assert.equal(m.currentOriginalText, null);
  assert.equal(m.process, null);
});
