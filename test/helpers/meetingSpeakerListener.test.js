const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const listenerModulePath = require.resolve("../../src/helpers/meetingSpeakerListener");
const originalLoad = Module._load;

function loadListenerClass() {
  delete require.cache[listenerModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { info() {}, debug() {}, error() {}, warn() {} };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(listenerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const MeetingSpeakerListener = loadListenerClass();

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal;
    setImmediate(() => child.emit("exit", null, signal));
  };
  return child;
}

function createListener(platform = "darwin") {
  const spawned = [];
  const listener = new MeetingSpeakerListener({
    platform,
    binaryPath: "/fake/macos-meeting-speaker-listener",
    spawnProcess: (binary, args) => {
      const child = createFakeChild();
      spawned.push({ binary, args, child });
      return child;
    },
  });
  return { listener, spawned };
}

const line = (message) => Buffer.from(`${JSON.stringify(message)}\n`);

async function startListener() {
  const { listener, spawned } = createListener();
  const states = [];
  const errors = [];
  const started = listener.start({
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });
  spawned[0].child.stdout.emit("data", line({ type: "start", intervalMs: 500 }));
  await started;
  return { listener, child: spawned[0].child, spawned, states, errors };
}

const AT = 1_700_000_000_000;
const SPEAKER_VIEW_SNAPSHOT = {
  type: "snapshot",
  at: AT,
  bundleId: "us.zoom.xos",
  windows: [
    {
      title: "Zoom Meeting",
      frame: [0, 0, 1600, 1000],
      nodes: [
        { role: "AXTabGroup", description: "Jane Doe", frame: [0, 120, 1600, 840], depth: 6 },
        { role: "AXTabGroup", description: "Omar Haddad", frame: [200, 0, 200, 112], depth: 6 },
      ],
    },
  ],
};

test("asks the helper for every adapted app at the poll interval", async () => {
  const { listener, spawned } = await startListener();

  assert.equal(spawned[0].binary, "/fake/macos-meeting-speaker-listener");
  assert.deepEqual(spawned[0].args, [
    "--bundle-id",
    "us.zoom.xos",
    "--bundle-id",
    "com.google.Chrome",
    "--page-title",
    "(?:^Meet [–-] )|(?:\\| Microsoft Teams\\b)",
    "--interval-ms",
    "500",
  ]);
  await listener.stop();
});

test("turns snapshots into speaking states, across split chunks", async () => {
  const { listener, child, states } = await startListener();
  const payload = line(SPEAKER_VIEW_SNAPSHOT);
  child.stdout.emit("data", payload.subarray(0, 40));
  assert.equal(states.length, 0);
  child.stdout.emit("data", payload.subarray(40));

  assert.deepEqual(states, [
    {
      at: AT,
      participants: [
        { id: "jane doe", name: "Jane Doe", isSelf: false },
        { id: "omar haddad", name: "Omar Haddad", isSelf: false },
      ],
      speakingIds: ["jane doe"],
      strategy: "speaker-view",
    },
  ]);
  await listener.stop();
});

test("clears speaking when the meeting app goes away", async () => {
  const { listener, child, states } = await startListener();
  child.stdout.emit(
    "data",
    line({ type: "status", state: "tracking", bundleIds: ["us.zoom.xos"] })
  );
  assert.equal(states.length, 0);

  child.stdout.emit("data", line(SPEAKER_VIEW_SNAPSHOT));
  child.stdout.emit("data", line({ type: "status", state: "waiting_for_app" }));
  assert.equal(states.length, 2);
  assert.deepEqual(states[1].speakingIds, []);
  assert.deepEqual(states[1].participants, []);
  await listener.stop();
});

test("clears speaking while the meeting app's windows can't be read", async () => {
  const { listener, child, states } = await startListener();
  child.stdout.emit("data", line(SPEAKER_VIEW_SNAPSHOT));
  child.stdout.emit(
    "data",
    line({ type: "status", state: "unreadable", bundleIds: ["us.zoom.xos"], axError: -25204 })
  );
  assert.equal(states.length, 2);
  assert.deepEqual(states[1].speakingIds, []);
  await listener.stop();
});

test("start fails when the helper can't read the meeting app", async () => {
  const { listener, spawned } = createListener();
  const started = listener.start({});
  spawned[0].child.stdout.emit(
    "data",
    line({
      type: "error",
      code: "accessibility_denied",
      message: "Accessibility permission is required",
    })
  );

  await assert.rejects(started, { code: "accessibility_denied" });
  assert.equal(spawned[0].child.killedWith, "SIGTERM");
});

test("an unexpected exit clears speaking and reports an error", async () => {
  const { child, states, errors } = await startListener();
  child.stdout.emit("data", line(SPEAKER_VIEW_SNAPSHOT));
  child.emit("exit", 1, null);

  assert.deepEqual(states.at(-1).speakingIds, []);
  assert.equal(errors.length, 1);
});

test("stop ends the helper without reporting an error", async () => {
  const { listener, child, errors } = await startListener();
  await listener.stop();

  assert.equal(child.killedWith, "SIGTERM");
  assert.equal(errors.length, 0);
  assert.equal(listener.process, null);
});

test("ignores output that isn't JSON", async () => {
  const { listener, child, states } = await startListener();
  child.stdout.emit("data", Buffer.from("Jane Doe is not JSON\n"));
  assert.equal(states.length, 0);
  await listener.stop();
});

test("is only offered on macOS", async () => {
  const { listener } = createListener("win32");
  assert.equal(listener.isAvailable(), false);
  await assert.rejects(listener.start({}), /macOS/);
});
