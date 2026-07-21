const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const detectorModulePath = require.resolve("../../src/helpers/audioActivityDetector");
const originalLoad = Module._load;
const originalPlatform = process.platform;

// The detector reads process.platform both at load time (poll interval) and at
// start() time (listener selection), so it stays pinned for the whole test.
function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => setPlatform(originalPlatform));

function loadDetector(platform, spawn) {
  delete require.cache[detectorModulePath];
  setPlatform(platform);

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {} };
    }
    if (request === "child_process") {
      return { ...childProcess, spawn };
    }
    // Binary resolution hits the real filesystem, so without this the platform
    // under test would be decided by which listener binaries happen to be built
    // on the host rather than by setPlatform().
    if (request === "./binaryResolver") {
      return { resolveBundledBinary: (name) => `/fake/bin/${name}` };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(detectorModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

// Mirrors child_process: "spawn" and "error" are both delivered on the nextTick
// queue, which drains before the promise microtasks awaiting start().
function createFakeChild(spawnError) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    process.nextTick(() => child.emit("exit", null));
    return true;
  };
  process.nextTick(() => {
    if (spawnError) child.emit("error", new Error(spawnError));
    else child.emit("spawn");
  });
  return child;
}

function createDetector(platform, { spawnError } = {}) {
  const children = [];
  const calls = [];
  const AudioActivityDetector = loadDetector(platform, (command, args, options) => {
    calls.push({ command, args, options });
    const child = createFakeChild(spawnError);
    children.push(child);
    return child;
  });

  const detector = new AudioActivityDetector();
  detector._isMicActive = async () => false;
  return { detector, children, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PLATFORMS = ["darwin", "win32", "linux"];

for (const platform of PLATFORMS) {
  test(`${platform}: a listener that fails to launch falls back to polling`, async () => {
    const { detector } = createDetector(platform, { spawnError: "spawn ENOENT" });

    await detector.start();

    assert.equal(detector._eventDriven, false);
    assert.notEqual(detector.checkInterval, null, "polling must take over");
    detector.stop();
  });

  test(`${platform}: a listener that launches stays event-driven`, async () => {
    const { detector, children } = createDetector(platform);

    await detector.start();

    assert.equal(detector._eventDriven, true);
    assert.equal(detector.checkInterval, null, "polling must not run alongside a listener");
    detector.stop();
    assert.equal(children[0].killed, true, "stop() must kill the listener");
  });

  test(`${platform}: stop() during launch kills the listener and starts nothing`, async () => {
    const { detector, children } = createDetector(platform);

    const starting = detector.start();
    detector.stop();
    await starting;
    await flush();

    assert.equal(detector._eventDriven, false);
    assert.equal(detector.checkInterval, null);
    assert.equal(children[0].killed, true, "the orphaned listener must be killed");
  });

  test(`${platform}: restarting does not orphan the previous listener`, async () => {
    const { detector, children } = createDetector(platform);

    await detector.start();
    detector.stop();
    await detector.start();
    await flush();

    assert.equal(children.length, 2);
    assert.equal(children[0].killed, true, "the first listener must be killed");
    assert.equal(detector._listenerProcess, children[1], "the live listener must be tracked");
    assert.equal(detector.checkInterval, null, "a dead listener must not trigger polling");

    detector.stop();
    assert.equal(children[1].killed, true, "the second listener must be killed");
  });

  test(`${platform}: listener output after stop() cannot emit a detection`, async () => {
    const { detector, children } = createDetector(platform);
    let emitted = false;
    detector.on("sustained-audio-detected", () => (emitted = true));

    await detector.start();
    detector.stop();
    children[0].stdout.emit("data", "MIC_ACTIVE\nEvent 'new' on source-output #1\nMIC_START 42\n");
    await flush();

    assert.equal(emitted, false);
    assert.equal(detector._sustainedTimer, null);
  });
}

test("darwin: MIC_ACTIVE then MIC_INACTIVE drives the sustained timer", async () => {
  const { detector, children } = createDetector("darwin");

  await detector.start();
  children[0].stdout.emit("data", "MIC_ACTIVE\n");
  assert.notEqual(detector._sustainedTimer, null);

  children[0].stdout.emit("data", "MIC_INACTIVE\n");
  assert.equal(detector._sustainedTimer, null);
  detector.stop();
});

test("win32: mic-listener spawns hidden, keeps stdin piped, and excludes its own pid", async () => {
  const { detector, calls } = createDetector("win32");

  await detector.start();

  assert.deepEqual(calls[0].args, ["--exclude-pid", String(process.pid)]);
  assert.equal(calls[0].options.windowsHide, true, "no console window may flash");
  assert.deepEqual(
    calls[0].options.stdio,
    ["pipe", "pipe", "pipe"],
    "stdin must stay piped so the binary can detect parent death"
  );
  detector.stop();
});

test("win32: MIC_START/MIC_STOP pids are tracked across partial chunks", async () => {
  const { detector, children } = createDetector("win32");

  await detector.start();
  children[0].stdout.emit("data", "MIC_START 11\nMIC_STA");
  children[0].stdout.emit("data", "RT 22\n");
  assert.deepEqual([...detector._activeMicPids], [11, 22]);

  children[0].stdout.emit("data", "MIC_STOP 11\n");
  assert.notEqual(detector._sustainedTimer, null, "one mic is still active");

  children[0].stdout.emit("data", "MIC_STOP 22\n");
  assert.equal(detector._sustainedTimer, null);
  detector.stop();
});

test("linux: pactl source-output events drive the sustained timer", async () => {
  const { detector, children, calls } = createDetector("linux");

  await detector.start();
  assert.equal(calls[0].command, "pactl");
  assert.deepEqual(calls[0].args, ["subscribe"]);

  children[0].stdout.emit("data", "Event 'new' on source-output #7\n");
  assert.notEqual(detector._sustainedTimer, null);

  children[0].stdout.emit("data", "Event 'remove' on source-output #7\n");
  assert.equal(detector._sustainedTimer, null);
  detector.stop();
});

test("a listener that dies while running falls back to polling", async () => {
  const { detector, children } = createDetector("linux");

  await detector.start();
  assert.equal(detector.checkInterval, null);

  children[0].emit("exit", 1);
  await flush();

  assert.equal(detector._eventDriven, false);
  assert.notEqual(detector.checkInterval, null);
  detector.stop();
});

test("unsupported platforms poll without spawning a listener", async () => {
  const { detector, calls } = createDetector("freebsd");

  await detector.start();

  assert.equal(calls.length, 0);
  assert.notEqual(detector.checkInterval, null);
  detector.stop();
});
