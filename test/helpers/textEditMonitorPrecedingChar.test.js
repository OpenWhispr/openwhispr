const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

test("getPrecedingChar resolves to unknown for missing pid", async () => {
  const m = new TextEditMonitor();
  for (const pid of [null, undefined, 0]) {
    assert.deepEqual(await m.getPrecedingChar(pid), { state: "unknown" });
  }
});

test("getPrecedingChar returns unknown when the AX read fails or hangs", async () => {
  const m = new TextEditMonitor();
  // Non-darwin short-circuits without shelling out; darwin errors out on an
  // unmapped PID. Both paths must resolve quickly with state "unknown".
  const start = Date.now();
  const result = await m.getPrecedingChar(99999999, 1500);
  assert.equal(result.state, "unknown");
  assert.ok(Date.now() - start < 3000);
});

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
