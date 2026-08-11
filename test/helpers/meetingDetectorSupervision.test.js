const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const EventEmitter = require("node:events");

const health = require("../../src/helpers/meetingDetectionHealth");
const AudioActivityDetector = require("../../src/helpers/audioActivityDetector");
const CallStateDetector = require("../../src/helpers/callStateDetector");
const urlChecker = require("../../src/helpers/browserMeetingUrlChecker");

// Both native children could die without anything restarting them, and on macOS
// the polling fallback greps a key that does not exist on modern hardware — so a
// dead listener meant detection was off, permanently and silently.

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.kill = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test.beforeEach(() => health.reset());

// The restart callback awaits the spawn, so a tick alone does not finish it.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a dead mic listener is restarted with growing backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());

  const detector = new AudioActivityDetector();
  const attempts = [];
  detector._tryEventDriven = async () => {
    attempts.push(Date.now());
    return false;
  };
  detector._running = true;
  detector._eventDriven = true;

  const child = fakeChild();
  detector._attachFallbackHandlers(child, "macos-mic-listener");
  child.emit("exit", 1);

  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  t.mock.timers.tick(4000);
  await settle();

  const audio = health.getSnapshot().detectors.find((d) => d.name === "audio");
  assert.ok(audio.restartCount >= 2, `expected retries, got ${audio.restartCount}`);
  const delays = audio.restarts.map((r) => r.delayMs);
  assert.ok(delays[1] > delays[0], `backoff must grow, got ${delays.join(",")}`);
});

test("restarts stop after the attempt cap", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());

  const detector = new AudioActivityDetector();
  detector._tryEventDriven = async () => false;
  detector._running = true;
  detector._eventDriven = true;

  const child = fakeChild();
  detector._attachFallbackHandlers(child, "macos-mic-listener");
  child.emit("exit", 1);

  for (let i = 0; i < 12; i += 1) t.mock.timers.tick(120000);

  const audio = health.getSnapshot().detectors.find((d) => d.name === "audio");
  assert.ok(audio.restartCount <= 6, `expected a cap, got ${audio.restartCount}`);
  assert.ok(["polling", "unavailable"].includes(audio.mode));
  assert.ok(audio.reason, "the give-up state must name a reason");
});

test("a recovered listener resets the backoff and reports event-driven", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());

  const detector = new AudioActivityDetector();
  detector._tryEventDriven = async () => {
    detector._listenerProcess = fakeChild();
    return true;
  };
  detector._running = true;
  detector._eventDriven = true;

  const child = fakeChild();
  detector._attachFallbackHandlers(child, "macos-mic-listener");
  child.emit("exit", 1);
  t.mock.timers.tick(1000);
  await settle();

  const audio = health.getSnapshot().detectors.find((d) => d.name === "audio");
  assert.equal(audio.mode, "event-driven");
  assert.equal(audio.childAlive, true);
  assert.equal(detector._restartAttempts, 0);
});

test("polling twice does not leak an interval", () => {
  const detector = new AudioActivityDetector();
  detector._check = () => {};
  detector._pollingSupported = () => true;

  detector._startPolling();
  const first = detector.checkInterval;
  detector._startPolling();

  assert.notEqual(detector.checkInterval, first);
  clearInterval(detector.checkInterval);
});

test("macOS reports unavailable rather than pretending to poll", () => {
  const detector = new AudioActivityDetector();
  detector._pollingSupported = () => false;

  detector._startPolling();

  assert.equal(detector.checkInterval, null, "there is no mic signal to poll for");
  const audio = health.getSnapshot().detectors.find((d) => d.name === "audio");
  assert.equal(audio.mode, "unavailable");
  assert.equal(health.getStatus(), "unavailable");
});

test("hasPrompted expires even when the mic never goes idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const detector = new AudioActivityDetector();
  detector._markPrompted();
  assert.equal(detector.hasPrompted, true);

  t.mock.timers.tick(31 * 60 * 1000);

  assert.equal(detector.hasPrompted, false, "a stuck prompt latch blocks every later meeting");
});

test("a dead call detector resets its state and is restarted", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const detector = new CallStateDetector();
  let spawns = 0;
  detector._spawnDetector = () => {
    spawns += 1;
    return null;
  };
  detector._binaryPath = () => "/fake/macos-call-detector";
  detector.start();
  spawns = 0;

  detector.state = { camera: true, microphone: true };
  detector._callActive = true;
  detector._onChildGone("close", 3);

  assert.deepEqual(detector.state, { camera: false, microphone: false });
  assert.equal(detector._callActive, false, "stale state would defeat the next call's start");

  t.mock.timers.tick(1000);
  assert.equal(spawns, 1, "the child must be respawned");

  const call = health.getSnapshot().detectors.find((d) => d.name === "call");
  assert.equal(call.lastExitCode, 3);
  assert.ok(call.restartCount >= 1);
});

test("revalidate restarts a child that died while the machine slept", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const detector = new CallStateDetector();
  let spawns = 0;
  detector._spawnDetector = () => {
    spawns += 1;
    return null;
  };
  detector._binaryPath = () => "/fake/macos-call-detector";
  detector.start();
  detector.proc = null;
  spawns = 0;

  detector.revalidate("resume");

  assert.equal(spawns, 1);
});

test("revalidate re-arms the mic listener when its child is gone", async () => {
  const detector = new AudioActivityDetector();
  let started = 0;
  detector._tryEventDriven = async () => {
    started += 1;
    return true;
  };
  detector._running = true;
  detector._listenerProcess = null;

  await detector.revalidate("resume");

  assert.equal(started, 1);
});

test("the Automation denial can be re-checked after a wake", () => {
  assert.equal(typeof urlChecker.resetAutomationDenied, "function");
  assert.doesNotThrow(() => urlChecker.resetAutomationDenied());
});
