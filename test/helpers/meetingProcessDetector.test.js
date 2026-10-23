const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const detectorPath = require.resolve("../../src/helpers/meetingProcessDetector");
const originalLoad = Module._load;
const originalPlatform = process.platform;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

// Every scan awaits a process list the test releases by hand, so a stop() or a
// second start() can be interleaved while a scan is still in flight. The
// detector requires electron lazily, so the stubs stay installed for the file.
let current = null;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (parent?.filename === detectorPath) {
    if (request === "electron") {
      return {
        systemPreferences: {
          subscribeWorkspaceNotification: (name, callback) => {
            current.notifications.set(name, callback);
            return name;
          },
          unsubscribeWorkspaceNotification: () => {},
        },
      };
    }
    if (request === "./debugLogger") {
      return {
        info: (message) => current.infoLogs.push(message),
        warn() {},
        debug() {},
        error() {},
      };
    }
    if (request === "./processListCache") {
      return {
        getProcessList: () =>
          new Promise((resolve) => {
            current.pendingScans.push(resolve);
          }),
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadDetector(platform) {
  setPlatform(platform);
  current = { infoLogs: [], pendingScans: [], notifications: new Map() };
  delete require.cache[detectorPath];
  const MeetingProcessDetector = require(detectorPath);
  const { infoLogs, pendingScans } = current;
  return {
    detector: new MeetingProcessDetector(),
    infoLogs,
    pendingScans,
    notify: (name, bundleId) =>
      current.notifications.get(name)(null, { NSApplicationBundleIdentifier: bundleId }),
    releaseScan: (processes) => pendingScans.shift()(processes),
  };
}

test.after(() => {
  Module._load = originalLoad;
});

test.afterEach(() => {
  setPlatform(originalPlatform);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("stop() on a never-started detector is a silent no-op", () => {
  const { detector, infoLogs } = loadDetector("darwin");
  detector.stop();
  assert.deepEqual(infoLogs, []);
});

test("stop() after start() still reports the shutdown", () => {
  const { detector, infoLogs } = loadDetector("darwin");
  detector.start();
  detector.stop();
  assert.ok(infoLogs.includes("Stopped meeting process detector"));
});

test("a macOS initial scan that completes after stop() cannot revive a stopped detector", async () => {
  const { detector, releaseScan } = loadDetector("darwin");
  const detected = [];
  detector.on("meeting-process-detected", (event) => detected.push(event.processKey));

  detector.start();
  detector.stop();
  releaseScan(["zoom.us"]);
  await settle();

  assert.deepEqual(detector.getDetectedProcesses(), []);
  assert.deepEqual(detected, []);
});

test("a macOS initial scan superseded by a newer start() is discarded", async () => {
  const { detector, releaseScan, pendingScans } = loadDetector("darwin");
  const detected = [];
  detector.on("meeting-process-detected", (event) => detected.push(event.processKey));

  detector.start();
  detector.stop();
  detector.start();
  assert.equal(pendingScans.length, 2);
  // The stale scan reports Zoom; the live one reports nothing running.
  releaseScan(["zoom.us"]);
  releaseScan([]);
  await settle();

  assert.deepEqual(detector.getDetectedProcesses(), []);
  assert.deepEqual(detected, []);
});

test("a live macOS initial scan still reports already-running meeting apps", async () => {
  const { detector, releaseScan } = loadDetector("darwin");
  detector.start();
  releaseScan(["zoom.us"]);
  await settle();

  assert.deepEqual(
    detector.getDetectedProcesses().map((entry) => entry.processKey),
    ["zoom"]
  );
  detector.stop();
});

test("a polling scan that completes after stop() cannot revive a stopped detector", async (t) => {
  const { detector, releaseScan } = loadDetector("linux");
  t.after(() => detector.stop());
  const detected = [];
  detector.on("meeting-process-detected", (event) => detected.push(event.processKey));

  detector.start();
  detector.stop();
  releaseScan(["zoom"]);
  await settle();

  assert.deepEqual(detector.getDetectedProcesses(), []);
  assert.deepEqual(detected, []);
});

// A workspace event is newer evidence than the process snapshot requested at start.
test("an app terminated during the initial macOS scan stays ended", async (t) => {
  const { detector, releaseScan, notify } = loadDetector("darwin");
  t.after(() => detector.stop());
  const detected = [];
  detector.on("meeting-process-detected", (event) => detected.push(event.processKey));
  detector.start();
  notify("NSWorkspaceDidTerminateApplicationNotification", "us.zoom.xos");
  releaseScan(["zoom.us", "facetime"]);
  await settle();
  assert.deepEqual(
    detector.getDetectedProcesses().map((event) => event.processKey),
    ["facetime"]
  );
  assert.deepEqual(detected, ["facetime"]);
});

test("launch and termination events keep their order while the startup scan waits", async (t) => {
  const { detector, releaseScan, notify } = loadDetector("darwin");
  t.after(() => detector.stop());
  const detected = [];
  const ended = [];
  detector.on("meeting-process-detected", (event) => detected.push(event.processKey));
  detector.on("meeting-process-ended", (event) => ended.push(event.processKey));
  detector.start();
  notify("NSWorkspaceDidLaunchApplicationNotification", "us.zoom.xos");
  notify("NSWorkspaceDidTerminateApplicationNotification", "us.zoom.xos");
  notify("NSWorkspaceDidLaunchApplicationNotification", "com.microsoft.teams2");
  releaseScan(["zoom.us"]);
  await settle();
  assert.deepEqual(
    detector.getDetectedProcesses().map((event) => event.processKey),
    ["teams"]
  );
  assert.deepEqual(detected, ["zoom", "teams"]);
  assert.deepEqual(ended, ["zoom"]);
});
