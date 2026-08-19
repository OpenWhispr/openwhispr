const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const detectorModulePath = require.resolve("../../src/helpers/audioActivityDetector");
const originalLoad = Module._load;
const originalPlatform = process.platform;

// The detector reads process.platform both at load time (poll interval) and at
// start() time (listener selection), so it stays pinned for the whole test.
function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => setPlatform(originalPlatform));

function loadDetector(platform, spawn, exec) {
  delete require.cache[detectorModulePath];
  setPlatform(platform);

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {} };
    }
    if (request === "child_process") {
      return { ...childProcess, exec, spawn };
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

// `ownPids` is the #1392 spelling of the same injection: outside Electron the
// real provider can only see the main pid, so child-process PIDs are supplied
// here. Both spellings feed the detector's excluded-pid provider.
function createDetector(
  platform,
  { excludedProcessIds, ownPids, execResponses = [], spawnError } = {}
) {
  const getExcludedProcessIds =
    excludedProcessIds ?? (ownPids ? () => [...ownPids] : () => [process.pid]);
  const children = [];
  const calls = [];
  const execCalls = [];
  const fakeExec = () => {};
  fakeExec[Symbol.for("nodejs.util.promisify.custom")] = async (command, options) => {
    execCalls.push({ command, options });
    const response = execResponses.shift();
    if (!response || response.error) {
      throw response?.error || new Error("exec unavailable in test");
    }
    if (response.promise) {
      return response.promise;
    }
    return { stdout: response.stdout, stderr: response.stderr || "" };
  };
  const AudioActivityDetector = loadDetector(
    platform,
    (command, args, options) => {
      calls.push({ command, args, options });
      const child = createFakeChild(spawnError);
      children.push(child);
      return child;
    },
    fakeExec
  );

  const detector = new AudioActivityDetector(getExcludedProcessIds);
  detector._isMicActive = async () => false;
  return { detector, children, calls, execCalls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};
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

test("win32: mic-listener spawns hidden, keeps stdin piped, and emits every pid", async () => {
  const { detector, calls } = createDetector("win32");

  await detector.start();

  assert.deepEqual(calls[0].args, []);
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

test("darwin: PID events exclude current OpenWhispr processes and continue during recording", async () => {
  let excludedProcessIds = [101, 102];
  const { detector, children } = createDetector("darwin", {
    excludedProcessIds: () => excludedProcessIds,
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  detector.setUserRecording(true);
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 101\nMIC_START 201\n");
  children[0].stdout.emit("data", "MIC_START 202\nMIC_STOP 201\n");

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: true,
  });
  assert.deepEqual(externalStates, [
    { reliable: true, externalMicActive: false },
    { reliable: true, externalMicActive: true },
  ]);
  assert.equal(detector._sustainedTimer, null, "recording must still suppress meeting prompts");
  assert.deepEqual([...detector._activeMicPids], [202], "own pids never enter the set");

  // The exclusion list is read live: a helper that spawned after start() is
  // excluded from its first MIC_START.
  excludedProcessIds = [101, 102, 103];
  children[0].stdout.emit("data", "MIC_START 103\nMIC_STOP 202\n");

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: false,
  });
  assert.deepEqual([...detector._activeMicPids], []);
  assert.deepEqual(externalStates, [
    { reliable: true, externalMicActive: false },
    { reliable: true, externalMicActive: true },
    { reliable: true, externalMicActive: false },
  ]);
  detector.stop();
});

test("darwin: aggregate fallback remains prompt-only and unreliable", async () => {
  const { detector, children } = createDetector("darwin");
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\nMIC_ACTIVE\n");

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(externalStates, []);
  assert.notEqual(detector._sustainedTimer, null, "aggregate activity must still drive prompts");
  detector.stop();
});

test("darwin: losing PID capability emits an unreliable external-mic snapshot", async () => {
  const { detector, children } = createDetector("darwin");
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\nCAPABILITY AGGREGATE\n");

  assert.deepEqual(externalStates.at(-1), {
    reliable: false,
    externalMicActive: false,
  });
  detector.stop();
});

test("darwin: listener exit emits reliability loss before polling fallback", async () => {
  const { detector, children } = createDetector("darwin");
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  children[0].emit("exit", 1);

  assert.deepEqual(externalStates.at(-1), {
    reliable: false,
    externalMicActive: false,
  });
  assert.notEqual(detector.checkInterval, null);
  detector.stop();
});

test("darwin: exclusion-provider failure emits reliability loss", async () => {
  let providerFails = false;
  const { detector, children } = createDetector("darwin", {
    excludedProcessIds: () => {
      if (providerFails) throw new Error("metrics unavailable");
      return [process.pid];
    },
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  providerFails = true;
  children[0].stdout.emit("data", "MIC_START 901\n");

  assert.deepEqual(externalStates.at(-1), {
    reliable: false,
    externalMicActive: false,
  });
  detector.stop();
});

test("win32: current OpenWhispr PIDs are filtered dynamically in JavaScript", async () => {
  let excludedProcessIds = [process.pid, 404];
  const { detector, children, calls } = createDetector("win32", {
    excludedProcessIds: () => excludedProcessIds,
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  assert.deepEqual(calls[0].args, [], "the native listener must report excluded pids too");

  children[0].stdout.emit("data", "READY\nCAPABILITY PID\nMIC_START 404\n");
  assert.deepEqual(externalStates, [{ reliable: true, externalMicActive: false }]);

  excludedProcessIds = [process.pid];
  children[0].stdout.emit("data", "MIC_START 501\n");
  children[0].stdout.emit("data", "MIC_STOP 501\nMIC_STOP 404\n");

  assert.deepEqual(externalStates, [
    { reliable: true, externalMicActive: false },
    { reliable: true, externalMicActive: true },
    { reliable: true, externalMicActive: false },
  ]);
  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: false,
  });
  detector.stop();
});

test("win32: own microphone activity never starts or sustains the legacy prompt", async () => {
  const { detector, children } = createDetector("win32", {
    excludedProcessIds: () => [process.pid],
  });

  await detector.start();
  children[0].stdout.emit("data", `READY\nCAPABILITY PID\nMIC_START ${process.pid}\n`);
  assert.equal(detector._sustainedTimer, null, "an excluded pid must not start a prompt");

  children[0].stdout.emit("data", "MIC_START 900\n");
  assert.notEqual(detector._sustainedTimer, null, "an external pid must start a prompt");

  children[0].stdout.emit("data", "MIC_STOP 900\n");
  assert.equal(
    detector._sustainedTimer,
    null,
    "an excluded pid must not keep the external prompt active"
  );
  detector.stop();
});

test("win32: a legacy binary without CAPABILITY PID stays unreliable but still prompts", async () => {
  const { detector, children } = createDetector("win32", {
    excludedProcessIds: () => [process.pid],
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  // Pre-refcounting builds print READY and un-refcounted MIC events; trusting
  // them for auto-end could stop a live meeting recording.
  children[0].stdout.emit("data", "READY\nMIC_START 900\n");

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(externalStates, []);
  assert.notEqual(detector._sustainedTimer, null, "legacy events must still drive prompts");
  detector.stop();
});

test("win32: a mid-run coverage downgrade emits an unreliable snapshot but keeps prompting", async () => {
  const { detector, children } = createDetector("win32", {
    excludedProcessIds: () => [process.pid],
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "READY\nCAPABILITY PID\nMIC_START 900\n");
  assert.deepEqual(externalStates.at(-1), { reliable: true, externalMicActive: true });

  // The helper announces CAPABILITY AGGREGATE instead of exiting when it can
  // no longer guarantee per-PID coverage.
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\n");
  assert.deepEqual(externalStates.at(-1), {
    reliable: false,
    externalMicActive: false,
  });

  children[0].stdout.emit("data", "MIC_START 901\n");
  assert.notEqual(detector._sustainedTimer, null, "degraded events must still drive prompts");
  assert.equal(detector.getExternalMicState().reliable, false);
  detector.stop();
});

test("win32: unattributable sessions (pid 0) count as external capture", async () => {
  const { detector, children } = createDetector("win32", {
    excludedProcessIds: () => [process.pid],
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "READY\nCAPABILITY PID\nMIC_START 0\n");
  assert.deepEqual(externalStates.at(-1), { reliable: true, externalMicActive: true });

  children[0].stdout.emit("data", "MIC_STOP 0\n");
  assert.deepEqual(externalStates.at(-1), { reliable: true, externalMicActive: false });
  detector.stop();
});

test("linux: reconciles source-output ownership at startup and on events", async () => {
  const { detector, children, execCalls } = createDetector("linux", {
    excludedProcessIds: () => [700],
    execResponses: [
      {
        stdout: JSON.stringify([
          { index: 1, properties: { "application.process.id": "700" } },
          { index: 2, properties: { "application.process.id": "800" } },
          { index: 3, properties: { "application.process.id": "800" } },
        ]),
      },
      {
        stdout: JSON.stringify([{ index: 1, properties: { "application.process.id": "700" } }]),
      },
    ],
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: true,
  });

  children[0].stdout.emit("data", "Event 'change' on source-output #1\n");
  await flush();

  assert.deepEqual(
    execCalls.map(({ command }) => command),
    ["pactl --format=json list source-outputs", "pactl --format=json list source-outputs"]
  );
  assert.deepEqual(externalStates, [
    { reliable: true, externalMicActive: true },
    { reliable: true, externalMicActive: false },
  ]);
  detector.stop();
});

test("linux: a burst of subscribe events coalesces into at most two reconciles", async () => {
  const { detector, children, execCalls } = createDetector("linux", {
    excludedProcessIds: () => [700],
    execResponses: [
      { stdout: "[]" },
      { stdout: JSON.stringify([{ index: 1, properties: { "application.process.id": "800" } }]) },
      { stdout: JSON.stringify([{ index: 1, properties: { "application.process.id": "800" } }]) },
    ],
  });

  await detector.start();
  children[0].stdout.emit(
    "data",
    [
      "Event 'new' on source-output #1",
      "Event 'new' on source-output #2",
      "Event 'change' on source-output #1",
      "Event 'remove' on source-output #2",
      "",
    ].join("\n")
  );
  await flush();

  assert.equal(
    execCalls.filter(({ command }) => command === "pactl --format=json list source-outputs").length,
    3,
    "startup reconcile plus one running and one trailing reconcile"
  );
  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: true,
  });
  detector.stop();
});

test("linux: module streams without a process id stay excluded without costing reliability", async () => {
  const { detector, children } = createDetector("linux", {
    excludedProcessIds: () => [700],
    execResponses: [
      { stdout: "[]" },
      {
        // module-echo-cancel/loopback streams carry no application.process.id.
        stdout: JSON.stringify([
          { index: 1, properties: { "media.name": "Echo-Cancel Source Stream" } },
          { index: 2, properties: { "application.process.id": "900" } },
        ]),
      },
      {
        stdout: JSON.stringify([
          { index: 1, properties: { "media.name": "Echo-Cancel Source Stream" } },
        ]),
      },
    ],
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "Event 'new' on source-output #2\n");
  await flush();

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: true,
  });

  children[0].stdout.emit("data", "Event 'remove' on source-output #2\n");
  await flush();

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: false,
  });
  detector.stop();
});

test("linux: ownership query failure is unreliable while aggregate events still prompt", async () => {
  const { detector, children } = createDetector("linux", {
    execResponses: [{ stdout: "[]" }, { stdout: "not-json" }],
  });
  const externalStates = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: false,
  });

  children[0].stdout.emit("data", "Event 'new' on source-output #7\n");
  await flush();

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(externalStates, [
    { reliable: true, externalMicActive: false },
    { reliable: false, externalMicActive: false },
  ]);
  assert.notEqual(detector._sustainedTimer, null, "aggregate activity must still drive prompts");
  detector.stop();
});

test("linux: a stale startup reconciliation cannot restore reliability after listener exit", async () => {
  const ownershipQuery = createDeferred();
  const { detector, children } = createDetector("linux", {
    execResponses: [{ promise: ownershipQuery.promise }],
  });

  const starting = detector.start();
  await flush();
  children[0].emit("exit", 1);
  ownershipQuery.resolve({
    stdout: JSON.stringify([{ index: 7, properties: { "application.process.id": "900" } }]),
    stderr: "",
  });
  await starting;
  await flush();

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual([...detector._activeMicPids], []);
  assert.notEqual(detector.checkInterval, null, "polling must take over after listener exit");
  detector.stop();
});

test("win32: portable native state seam handles reference counts and failures", (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-mic-listener-"));
  const executablePath = path.join(temporaryDirectory, "mic-listener-state-test");
  t.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));

  const compileResult = childProcess.spawnSync(
    process.env.CC || "cc",
    [
      "-DMIC_LISTENER_STATE_TEST",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      path.resolve(__dirname, "../../resources/windows-mic-listener.c"),
      "-o",
      executablePath,
    ],
    { encoding: "utf8" }
  );

  if (compileResult.error?.code === "ENOENT") {
    t.skip("no C compiler is available for the portable native-state seam");
    return;
  }

  assert.equal(compileResult.status, 0, compileResult.stderr);
  const scenarios = [
    { argument: "state", output: /native state tests passed/ },
    { argument: "ownership", output: /invalid process ownership rejected/ },
    { argument: "lifecycle", output: /session lifecycle fully released/ },
    { argument: "expired-state", output: /expired state queued cleanup once/ },
    { argument: "coverage", output: /unhealthy setup rejected/ },
  ];

  for (const scenario of scenarios) {
    const runResult = childProcess.spawnSync(executablePath, [scenario.argument], {
      encoding: "utf8",
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, scenario.output);
  }
});

// The native listeners are edge-triggered: they emit only on state transitions,
// so an edge swallowed by a gate is never re-delivered. The detector must
// remember the last known state and re-evaluate it when the gate lifts.
// Mirrors SUSTAINED_EVENT_DRIVEN_MS and COOLDOWN_MS in audioActivityDetector.js.
const SUSTAINED_MS = 2 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;

test("darwin: a mic edge swallowed by the recording gate is re-evaluated when recording stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setUserRecording(true);
  children[0].stdout.emit("data", "MIC_ACTIVE\n");
  assert.equal(detector._sustainedTimer, null, "a gated edge must not arm the sustained timer");

  detector.setUserRecording(false);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 1, "the ongoing call must be detected once the gate lifts");
  detector.stop();
});

test("darwin: a mic edge swallowed by the dismissal cooldown is re-evaluated when it expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.dismiss();
  children[0].stdout.emit("data", "MIC_ACTIVE\n");
  assert.equal(detector._sustainedTimer, null, "the cooldown must still swallow the prompt");

  // Split ticks: mocked timers do not cascade timers armed inside a callback.
  t.mock.timers.tick(COOLDOWN_MS);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 1, "a call outlasting the cooldown must still be detected");
  detector.stop();
});

test("darwin: a dismissed call that keeps running re-prompts after the cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  children[0].stdout.emit("data", "MIC_ACTIVE\n");
  t.mock.timers.tick(SUSTAINED_MS);
  assert.equal(emitted.length, 1);

  detector.dismiss();
  t.mock.timers.tick(COOLDOWN_MS);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 2, "polling parity: an ongoing call re-prompts after the cooldown");
  detector.stop();
});

test("darwin: a mic that went quiet while recording does not re-prompt when recording stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setUserRecording(true);
  children[0].stdout.emit("data", "MIC_ACTIVE\n");
  children[0].stdout.emit("data", "MIC_INACTIVE\n");
  detector.setUserRecording(false);
  t.mock.timers.tick(SUSTAINED_MS * 2);

  assert.equal(emitted.length, 0, "a released mic must not produce a stale prompt");
  detector.stop();
});

test("darwin: a call that outlives the mic warm-hold is detected when the hold releases", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setMicWarmHold(true);
  children[0].stdout.emit("data", "MIC_ACTIVE\n");
  assert.equal(
    detector._sustainedTimer,
    null,
    "warm-hold evidence must not arm the sustained timer"
  );

  detector.setMicWarmHold(false);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 1, "a call still holding the mic after our hold ends must prompt");
  detector.stop();
});

test("darwin: a warm-hold that releases cleanly does not produce a stale prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setMicWarmHold(true);
  children[0].stdout.emit("data", "MIC_ACTIVE\n");
  detector.setMicWarmHold(false);
  children[0].stdout.emit("data", "MIC_INACTIVE\n");
  t.mock.timers.tick(SUSTAINED_MS * 2);

  assert.equal(emitted.length, 0, "the release edge must cancel the pending re-evaluation");
  detector.stop();
});

test("win32: an unrelated app's mic session ending does not hide an ongoing dismissed call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("win32");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  children[0].stdout.emit("data", "MIC_START 11\n");
  t.mock.timers.tick(SUSTAINED_MS);
  assert.equal(emitted.length, 1);
  detector.dismiss();

  // pid 11 never stopped, so the reference count must still hold it — otherwise
  // pid 22's stop reads as "every mic closed" and cancels the re-evaluation.
  children[0].stdout.emit("data", "MIC_START 22\nMIC_STOP 22\n");
  t.mock.timers.tick(COOLDOWN_MS);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 2, "the still-running call must re-prompt after the cooldown");
  detector.stop();
});

// #1392: the helper is given a single --exclude-pid for the main process, but
// dictation opens the mic from Chromium's audio service, so OpenWhispr's own
// capture is reported back to us under a child PID and read as a meeting.
test("win32: a mic session from one of our own child processes is ignored", async () => {
  const AUDIO_SERVICE_PID = 4242;
  const { detector, children } = createDetector("win32", {
    ownPids: [process.pid, AUDIO_SERVICE_PID],
  });

  await detector.start();
  children[0].stdout.emit("data", `MIC_START ${AUDIO_SERVICE_PID}\n`);

  assert.equal(detector._activeMicPids.size, 0);
  assert.equal(detector._sustainedTimer, null, "our own dictation must not arm detection");
  assert.equal(detector._lastKnownMicState, false, "and must not leave stale state behind");
  detector.stop();
});

test("win32: a mic session from another application is still detected", async () => {
  const { detector, children } = createDetector("win32", {
    ownPids: [process.pid, 4242],
  });

  await detector.start();
  children[0].stdout.emit("data", "MIC_START 9001\n");

  assert.deepEqual([...detector._activeMicPids], [9001]);
  assert.notEqual(detector._sustainedTimer, null);
  detector.stop();
});

test("win32: our own capture cannot cancel a real meeting already in progress", async () => {
  const AUDIO_SERVICE_PID = 4242;
  const { detector, children } = createDetector("win32", {
    ownPids: [process.pid, AUDIO_SERVICE_PID],
  });

  await detector.start();
  children[0].stdout.emit("data", "MIC_START 9001\n");
  children[0].stdout.emit("data", `MIC_START ${AUDIO_SERVICE_PID}\n`);
  children[0].stdout.emit("data", `MIC_STOP ${AUDIO_SERVICE_PID}\n`);

  // Dropping our own stop must not empty the set while the other app holds it.
  assert.deepEqual([...detector._activeMicPids], [9001]);
  assert.notEqual(detector._sustainedTimer, null);
  detector.stop();
});
