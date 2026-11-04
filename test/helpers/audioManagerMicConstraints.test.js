const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");
const {
  createSystemDefaultMicrophoneResolver,
} = require("../../src/helpers/systemDefaultMicrophone");

// Starting a dictation must never sit behind the default-mic lookup, which on
// Windows is a PowerShell process compiling C# (#2765). The real resolver runs
// here with a lookup the test controls. A regression waits forever on a lookup
// that never ends, so every test has a timeout: fail, don't hang.

const TIMEOUT = { timeout: 30000 };
const NATIVE_ANSWER = '{"name":"Desk Microphone","id":"1"}';

const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Default - Desk Microphone" },
  { kind: "audioinput", deviceId: "communications", label: "Communications - Desk Microphone" },
  { kind: "audioinput", deviceId: "desk-id", label: "Desk Microphone" },
];

const never = () => new Promise(() => {});

function controlledLookup() {
  const lookup = {
    release: null,
    run: () =>
      new Promise((done) => {
        lookup.release = () => done(NATIVE_ANSWER);
      }),
  };
  return lookup;
}

async function setup(t, run) {
  const { window, AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-mic-constraints-test-",
    settingsKey: "__micConstraintsSettings",
    settings: { microphoneSelectionMode: "system" },
  });
  const resolve = createSystemDefaultMicrophoneResolver({ platform: "win32", run });
  window.electronAPI = { getSystemDefaultMicrophone: (options) => resolve(options) };
  const opened = [];
  installMicCaptureGlobals(t);
  navigator.mediaDevices.enumerateDevices = async () => DEVICES;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    opened.push(constraints);
    return {};
  };
  return { AudioManager, opened };
}

const deviceId = (constraints) => constraints.audio.deviceId?.exact;

test("no way of starting a dictation waits for the lookup", TIMEOUT, async (t) => {
  const { AudioManager, opened } = await setup(t, never);
  // Refusing the open ends each path right there, so nothing after it needs a stub.
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    opened.push(constraints);
    throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
  };
  const manager = new AudioManager();

  await manager.prepareMicCapture();
  await manager.startRecording();
  await manager.startStreamingRecording();

  assert.deepEqual(opened.map(deviceId), ["default", "default", "default"]);
});

test("the stale-device retry doesn't wait for its forced lookup", TIMEOUT, async (t) => {
  const { AudioManager, opened } = await setup(t, never);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    opened.push(constraints);
    throw Object.assign(new Error("gone"), {
      name: "OverconstrainedError",
      constraint: "deviceId",
    });
  };

  for (const start of ["startRecording", "startStreamingRecording"]) {
    opened.length = 0;
    const manager = new AudioManager();
    manager.cachedMicDeviceId = "desk-id";

    await manager[start]();

    assert.deepEqual(opened.map(deviceId), ["desk-id", "default"], start);
  }
});

test("the silent-device hop doesn't wait for its forced lookup", TIMEOUT, async (t) => {
  let lookups = 0;
  const { AudioManager, opened } = await setup(t, () => {
    lookups += 1;
    return lookups === 1 ? Promise.resolve(NATIVE_ANSWER) : never();
  });
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    opened.push(constraints);
    const track = {
      readyState: deviceId(constraints) === "default" ? "live" : "ended",
      stop() {},
    };
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  };
  const manager = new AudioManager();
  await manager.cacheMicrophoneDeviceId();

  await manager.prepareMicCapture();
  manager.cancelPreparedMicCapture();

  assert.deepEqual(opened.map(deviceId), ["desk-id", "desk-id", "default"]);
  assert.equal(manager.rejectedMicDeviceId, "desk-id");
  assert.equal(lookups, 2, "the valid cache doesn't stand in for the forced lookup");
});

test("the press after the lookup finishes pins the physical device", TIMEOUT, async (t) => {
  const lookup = controlledLookup();
  const { AudioManager } = await setup(t, lookup.run);
  const manager = new AudioManager();

  assert.equal(deviceId(await manager.getAudioConstraints()), "default");

  lookup.release();
  await new Promise((done) => setImmediate(done));

  assert.equal(deviceId(await manager.getAudioConstraints()), "desk-id");
  assert.equal(manager.cachedMicDeviceId, "desk-id");
});

test("a press during a device-change refresh never opens the old mic", TIMEOUT, async (t) => {
  let lookups = 0;
  const { AudioManager } = await setup(t, () => {
    lookups += 1;
    return lookups === 1 ? Promise.resolve(NATIVE_ANSWER) : never();
  });
  const manager = new AudioManager();
  await manager.cacheMicrophoneDeviceId();
  assert.equal(manager.cachedMicDeviceId, "desk-id");

  manager._onDeviceChange();

  assert.equal(deviceId(await manager.getAudioConstraints()), "default");
});

test("the startup pre-cache waits for the lookup a press doesn't", TIMEOUT, async (t) => {
  const lookup = controlledLookup();
  const { AudioManager } = await setup(t, lookup.run);
  const manager = new AudioManager();

  const preCache = manager.cacheMicrophoneDeviceId();
  assert.equal(deviceId(await manager.getAudioConstraints()), "default");

  lookup.release();
  await preCache;

  assert.equal(manager.cachedMicDeviceId, "desk-id");
});

test("mid-recording recovery waits for the lookup a press doesn't", TIMEOUT, async (t) => {
  const lookup = controlledLookup();
  const { AudioManager, opened } = await setup(t, lookup.run);
  const manager = new AudioManager();

  const acquiring = manager.micRecovery.acquire("devicechange");
  assert.equal(deviceId(await manager.getAudioConstraints()), "default");
  await new Promise((done) => setImmediate(done));
  assert.equal(opened.length, 0, "recovery hasn't opened a device yet");

  lookup.release();
  await acquiring;

  assert.equal(deviceId(opened[0]), "desk-id");
});

test("recovery's fallback waits for the lookup a start's fallback doesn't", TIMEOUT, async (t) => {
  const refresh = controlledLookup();
  let lookups = 0;
  const { AudioManager, opened } = await setup(t, () => {
    lookups += 1;
    return lookups === 1 ? Promise.resolve(NATIVE_ANSWER) : refresh.run();
  });
  const manager = new AudioManager();
  const open = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    navigator.mediaDevices.getUserMedia = open;
    opened.push(constraints);
    throw new Error("the preferred mic is gone");
  };

  const acquiring = manager.micRecovery.acquire("ended");
  await new Promise((done) => setImmediate(done));

  assert.equal(deviceId(await manager.getAudioConstraints(true)), "default");
  await new Promise((done) => setImmediate(done));
  assert.equal(opened.length, 1, "recovery's fallback hasn't opened a device yet");

  refresh.release();
  await acquiring;

  assert.equal(deviceId(opened[1]), "desk-id");
});
