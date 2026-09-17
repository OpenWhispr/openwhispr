const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Executes the real degrade closure, the way meetingAudioTimeline.test.js runs
// the dispatch closures, because the handover decision lives inside the
// IPCHandlers registration closure.
const ipcPath = path.join(__dirname, "../../src/helpers/ipcHandlers.js");
const source = fs.readFileSync(ipcPath, "utf8");

function harness({ systemAudioHeard }) {
  const sent = [];
  const stopped = [];
  const detached = [];
  const context = {
    meetingSystemAudioDegraded: false,
    // Inert since #1265, and that is the point: the closure must not read it.
    meetingSystemAudioHeard: systemAudioHeard,
    meetingSystemAudioWatchdog: {
      detachCapture: () => {
        detached.push(true);
      },
    },
    debugLogger: { warn() {}, debug() {}, error() {}, info() {} },
    windowsLoopbackAudioManager: {
      stop: async () => {
        stopped.push(true);
      },
    },
    BrowserWindow: {
      fromWebContents: () => ({
        isDestroyed: () => false,
        webContents: { send: (channel) => sent.push(channel) },
      }),
    },
  };
  // `this.windowsLoopbackAudioManager` inside the closure resolves through the
  // context's global object, which is why the manager is a plain context key.
  const start = source.indexOf("const degradeMeetingSystemAudioToLoopback =");
  const end = source.indexOf("const startManagedMeetingSystemAudio =");
  assert.ok(start >= 0 && end > start, "degrade closure not found in ipcHandlers.js");
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}
    globalThis.degrade = () => degradeMeetingSystemAudioToLoopback({ sender: {} });`,
    context
  );
  return { context, sent, stopped, detached, degrade: context.degrade };
}

test("a silent capture hands over even after the helper delivered audible chunks", async () => {
  // Windows hides some applications' streams from process loopback while
  // passing others through, so a captured notification sound says nothing
  // about whether the call itself is being recorded (#1265).
  const { context, sent, stopped, detached, degrade } = harness({ systemAudioHeard: true });

  await degrade();

  assert.deepEqual(sent, ["meeting-system-audio-degraded"]);
  assert.equal(stopped.length, 1);
  assert.equal(context.meetingSystemAudioDegraded, true);
  // Structural: the watchdog must be told to drop its restart hook rather than
  // be left pointing at the helper this just stopped.
  assert.equal(detached.length, 1);
});

test("the handover runs once per session", async () => {
  const { sent, stopped, degrade } = harness({ systemAudioHeard: false });

  await degrade();
  await degrade();

  assert.deepEqual(sent, ["meeting-system-audio-degraded"]);
  assert.equal(stopped.length, 1);
});
