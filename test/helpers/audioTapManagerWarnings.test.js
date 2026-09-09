const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const createMeetingSystemAudioWatchdog = require("../../src/helpers/meetingSystemAudioWatchdog");

// The tap helper reports a stranded device as a stderr warning rather than by
// exiting, so the forwarding path is the only thing that can tell the main
// process capture has stopped (#1990). Warnings must never settle or fail the
// start handshake either, which is what the mid-handshake test pins.

const managerModulePath = require.resolve("../../src/helpers/audioTapManager");
const originalLoad = Module._load;

let lastChild = null;

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit("exit", 0, null));
  };
  return child;
}

function loadManagerClass() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process") {
      return {
        spawn: () => {
          lastChild = createFakeChild();
          return lastChild;
        },
      };
    }
    if (request === "./debugLogger") {
      return { info() {}, debug() {}, error() {}, warn() {} };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const AudioTapManager = loadManagerClass();

// Same instance-seam style as windowsLoopbackAudioManager.test.js: the binary
// lookup and the macOS version gate are not what is under test here.
function createManager() {
  const manager = new AudioTapManager();
  manager.isSupported = () => true;
  manager._prepareBinary = () => "/fake/macos-audio-tap";
  return manager;
}

const emitLine = (child, message) => child.stderr.emit("data", `${JSON.stringify(message)}\n`);

test("a device_invalidated warning reaches onWarning and not onError", async () => {
  const manager = createManager();
  const warnings = [];
  const errors = [];

  const started = manager.start({
    onChunk: () => {},
    onError: (error) => errors.push(error),
    onWarning: (warning) => warnings.push(warning),
  });
  emitLine(lastChild, { type: "start" });
  await started;

  emitLine(lastChild, {
    type: "warning",
    code: "device_invalidated",
    reason: "default_output_changed",
    message: "System audio device changed",
  });

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "device_invalidated");
  assert.equal(warnings[0].reason, "default_output_changed");
  assert.deepEqual(errors, []);
});

test("a warning during the start handshake neither resolves nor rejects it", async () => {
  const manager = createManager();
  const warnings = [];
  let settled = false;

  const started = manager.start({ onWarning: (warning) => warnings.push(warning) }).then(() => {
    settled = true;
  });

  const child = lastChild;
  emitLine(child, { type: "warning", code: "listener_unavailable", message: "no listener" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warnings.length, 1);
  assert.equal(settled, false, "a warning must not be mistaken for the start acknowledgement");

  emitLine(child, { type: "start" });
  await started;
  assert.equal(settled, true);
});

test("restarting an already-running manager re-points the warning handler", async () => {
  const manager = createManager();
  const first = [];
  const second = [];

  const started = manager.start({ onWarning: (warning) => first.push(warning) });
  const child = lastChild;
  emitLine(child, { type: "start" });
  await started;

  // startManagedMeetingSystemAudio calls start() again on the live manager, and
  // the new session's callbacks have to take over from the previous ones.
  await manager.start({ onWarning: (warning) => second.push(warning) });
  emitLine(child, { type: "warning", code: "device_invalidated", message: "changed" });

  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
});

test("stop drops the warning handler along with the rest of the callbacks", async () => {
  const manager = createManager();
  const warnings = [];

  const started = manager.start({ onWarning: (warning) => warnings.push(warning) });
  const child = lastChild;
  emitLine(child, { type: "start" });
  await started;

  await manager.stop();
  assert.equal(manager.onWarning, null);

  emitLine(child, { type: "warning", code: "device_invalidated", message: "changed" });
  assert.deepEqual(warnings, [], "a warning from the dead helper must not reach the new session");
});

test("a device warning beside the replacement start acknowledgement triggers another recovery", async (t) => {
  const manager = createManager();
  const interruptions = [];
  const watchdog = createMeetingSystemAudioWatchdog({
    onInterrupted: (payload) => interruptions.push(payload),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const startCapture = () =>
    manager.start({
      onWarning: (warning) => {
        if (warning.code === "device_invalidated") watchdog.reportDeviceInvalidated();
      },
    });
  watchdog.attachCapture({ stop: () => manager.stop(), start: startCapture });
  t.after(async () => {
    watchdog.stop();
    await manager.stop();
  });

  const started = startCapture();
  emitLine(lastChild, { type: "start" });
  await started;
  watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  emitLine(lastChild, { type: "warning", code: "device_invalidated" });
  await flush();
  await flush();
  const replacement = lastChild;

  // A busy main process can read both native messages in the same pipe chunk.
  replacement.stderr.emit(
    "data",
    '{"type":"start"}\n{"type":"warning","code":"device_invalidated"}\n'
  );
  await flush();
  await flush();

  assert.notEqual(lastChild, replacement, "the invalidated replacement must be replaced too");
  emitLine(lastChild, { type: "start" });
  await flush();
  assert.equal(interruptions.length, 2);
  assert.ok(
    interruptions.every((entry) => entry.reason === "device_invalidated" && entry.recovering)
  );
});
