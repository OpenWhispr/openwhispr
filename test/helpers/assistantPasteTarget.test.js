const test = require("node:test");
const assert = require("node:assert/strict");

const { AssistantPasteTarget } = require("../../src/helpers/assistantPasteTarget");

function make(platform, { pid = 222, window = null, focused = null, windowPid = null } = {}) {
  const selectionManager = {
    lastTarget: window,
    captureTarget: async () => {},
    _linuxTargetPid: async () => windowPid,
    _getLinuxTarget: async () => focused,
    _sameTarget: (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id),
  };
  return new AssistantPasteTarget({
    textEditMonitor: { captureTargetPid: async () => pid },
    selectionManager,
    platform,
    ownPid: 100,
    ownExeName: "OpenWhispr.exe",
  });
}

test("a voice command adopts the app its recording started over, once", async () => {
  const target = make("darwin");

  assert.equal(await target.adopt(), false, "no recording, nothing to adopt");
  target.noteRecordingStart();
  assert.equal(await target.adopt(), true);
  assert.deepEqual(await target.current(), { pid: 222 });

  // A later command without a recording of its own (none happens) adopts nothing.
  assert.equal(await target.adopt(), false);
  assert.equal(await target.current(), null);
});

test("closing the panel forgets the app", async () => {
  const target = make("darwin");
  target.noteRecordingStart();
  await target.adopt();

  target.clear();

  assert.equal(await target.current(), null);
});

test("OpenWhispr itself is never a paste target", async () => {
  const mac = make("darwin", { pid: 100 });
  mac.noteRecordingStart();
  assert.equal(await mac.adopt(), false);

  const ownWindow = { kind: "win-hwnd", id: "0x1", exeName: "openwhispr.exe" };
  const windows = make("win32", { window: ownWindow });
  windows.noteRecordingStart();
  assert.equal(await windows.adopt(), false);

  const linux = make("linux", { window: { kind: "x11-window", id: "9" }, windowPid: "100" });
  linux.noteRecordingStart();
  assert.equal(await linux.adopt(), false);
});

test("another app's window is a target, and Linux checks focus came back to it", async () => {
  const terminal = { kind: "win-hwnd", id: "0x2", exeName: "WindowsTerminal.exe" };
  const windows = make("win32", { window: terminal });
  windows.noteRecordingStart();
  assert.equal(await windows.adopt(), true);
  assert.deepEqual(await windows.current(), { window: terminal });

  const xterm = { kind: "x11-window", id: "7" };
  const linux = make("linux", { window: xterm, windowPid: "4242", focused: { ...xterm } });
  linux.noteRecordingStart();
  assert.equal(await linux.adopt(), true);
  const adopted = await linux.current();
  assert.equal(await linux.isFocused(adopted), true);

  const moved = make("linux", { window: xterm, focused: { kind: "x11-window", id: "8" } });
  moved.noteRecordingStart();
  await moved.adopt();
  assert.equal(await moved.isFocused(await moved.current()), false);
});

test("a capture that fails is no target, not a rejected promise", async () => {
  const target = new AssistantPasteTarget({
    textEditMonitor: { captureTargetPid: async () => Promise.reject(new Error("osascript")) },
    platform: "darwin",
    ownPid: 100,
  });
  target.noteRecordingStart();

  assert.equal(await target.adopt(), false);
});
