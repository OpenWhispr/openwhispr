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

test("a voice command adopts the app its recording started over", async () => {
  const target = make("darwin");

  assert.equal(await target.adopt(), false, "no recording, nothing to adopt");
  target.noteRecordingStart();
  assert.equal(await target.adopt(), true);
  assert.deepEqual(await target.current(), { pid: 222 });
});

// A Mac whose frontmost app changes between recordings.
function macWithFront(pids) {
  return new AssistantPasteTarget({
    textEditMonitor: { captureTargetPid: async () => pids.shift() },
    platform: "darwin",
    ownPid: 100,
  });
}

test("a follow-up spoken over another app pastes there", async () => {
  const target = macWithFront([222, 333]);
  target.noteRecordingStart();
  await target.adopt();

  // The user moved to another app and spoke a follow-up there.
  target.noteRecordingStart();
  assert.equal(await target.adopt(), true);

  assert.deepEqual(await target.current(), { pid: 333 });
});

test("a follow-up spoken over the panel, or with no capture, keeps the conversation's app", async () => {
  const target = macWithFront([222, 100]);
  target.noteRecordingStart();
  await target.adopt();

  target.noteRecordingStart(); // OpenWhispr in front
  assert.equal(await target.adopt(), true);
  assert.deepEqual(await target.current(), { pid: 222 });

  assert.equal(await target.adopt(), true, "nothing recorded");
  assert.deepEqual(await target.current(), { pid: 222 });
});

test("a close while a command adopts its app leaves no target behind", async () => {
  let resolveCapture;
  const target = new AssistantPasteTarget({
    textEditMonitor: {
      captureTargetPid: () => new Promise((resolve) => (resolveCapture = resolve)),
    },
    platform: "darwin",
    ownPid: 100,
  });
  target.noteRecordingStart();
  const adopting = target.adopt();

  target.clear();
  resolveCapture(222);
  await adopting;

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
  assert.equal(await linux.isInFront(adopted), true);

  const moved = make("linux", { window: xterm, focused: { kind: "x11-window", id: "8" } });
  moved.noteRecordingStart();
  await moved.adopt();
  assert.equal(await moved.isInFront(await moved.current()), false);
});

test("Windows brings the command's window forward before a paste, and says when it can't", async () => {
  const terminal = { kind: "win-hwnd", id: "0x2", exeName: "WindowsTerminal.exe" };
  const windows = make("win32", { window: terminal });
  const restored = [];
  let comesForward = true;
  windows.selectionManager.restoreWinTarget = async (window) => {
    restored.push(window);
    return comesForward;
  };
  windows.noteRecordingStart();
  await windows.adopt();
  const adopted = await windows.current();

  assert.equal(await windows.isInFront(adopted), true);
  comesForward = false;
  assert.equal(await windows.isInFront(adopted), false, "closed, or Windows refused it");
  windows.selectionManager.restoreWinTarget = async () => Promise.reject(new Error("spawn"));
  assert.equal(await windows.isInFront(adopted), false);
  assert.deepEqual(restored, [terminal, terminal]);
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
