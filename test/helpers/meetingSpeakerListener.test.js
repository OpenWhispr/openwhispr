const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { StringDecoder } = require("node:string_decoder");

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
  // Like a real stream after setEncoding: Buffer chunks arrive as text, a
  // character split across two chunks held until it's whole.
  child.stdout.setEncoding = (encoding) => {
    const decoder = new StringDecoder(encoding);
    const emit = child.stdout.emit.bind(child.stdout);
    child.stdout.emit = (event, chunk, ...rest) =>
      emit(
        event,
        event === "data" && Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk,
        ...rest
      );
  };
  child.stderr = new EventEmitter();
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal;
    setImmediate(() => child.emit("exit", null, signal));
  };
  return child;
}

function createListener(platform = "darwin", arch = "arm64") {
  const spawned = [];
  const listener = new MeetingSpeakerListener({
    platform,
    arch,
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
  windows: [
    {
      bundleId: "us.zoom.xos",
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
    "^Meet [–-] ",
    "--page-marker",
    "^Meet [–-] ",
    "--page-title",
    "\\| Microsoft Teams\\b",
    "--page-marker",
    "(?:Context menu is available|Has context menu)$",
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

test("is only offered on Apple silicon Macs", async () => {
  const { listener } = createListener("win32");
  assert.equal(listener.isAvailable(), false);
  await assert.rejects(listener.start({}), /Apple silicon/);
  // Intel Macs have no onnxruntime binding for live speaker identification.
  assert.equal(createListener("darwin", "x64").listener.isAvailable(), false);
});

test("a name split across two reads arrives whole", async () => {
  const { listener, child, states } = await startListener();
  const snapshot = structuredClone(SPEAKER_VIEW_SNAPSHOT);
  snapshot.windows[0].nodes[0].description = "José Núñez";
  const payload = line(snapshot);
  const cut = payload.indexOf(Buffer.from("é")) + 1;
  child.stdout.emit("data", payload.subarray(0, cut));
  child.stdout.emit("data", payload.subarray(cut));

  assert.deepEqual(states[0].speakingIds, ["josé núñez"]);
  await listener.stop();
});

test("a snapshot no adapter can read clears speaking instead of throwing", async () => {
  const { listener, child, states } = await startListener();
  child.stdout.emit("data", line(SPEAKER_VIEW_SNAPSHOT));
  const broken = {
    type: "snapshot",
    at: AT + 1_000,
    windows: [
      {
        bundleId: "com.google.Chrome",
        title: "Meet – abc-defg-hij - Google Chrome",
        nodes: [{ role: "AXStaticText", value: 42, frame: [0, 0, 10, 10] }],
      },
    ],
  };
  assert.doesNotThrow(() => child.stdout.emit("data", line(broken)));
  assert.deepEqual(states.at(-1).speakingIds, []);
  await listener.stop();
});

test("a caption names someone whose tile has left the screen", async () => {
  const { listener, child, states } = await startListener();
  const teamsWindow = (nodes) => ({
    bundleId: "com.google.Chrome",
    title: "Weekly sync | Microsoft Teams - Google Chrome",
    frame: [0, 0, 1200, 900],
    nodes,
  });
  const tile = (label, frame) => ({ role: "AXMenuItem", description: label, frame });
  child.stdout.emit(
    "data",
    line({
      type: "snapshot",
      at: AT,
      windows: [
        teamsWindow([tile("Ann Lee (Guest), muted, Context menu is available", [0, 0, 400, 225])]),
      ],
    })
  );
  child.stdout.emit(
    "data",
    line({
      type: "snapshot",
      at: AT + 5_000,
      windows: [
        teamsWindow([
          tile("Jane Doe (Guest), Context menu is available", [0, 0, 400, 225]),
          { role: "AXGroup", description: "Live Captions", frame: [0, 600, 800, 200] },
          { role: "AXStaticText", value: "Ann Lee", frame: [40, 610, 60, 15] },
          { role: "AXStaticText", value: "Short reply.", frame: [40, 626, 90, 20] },
        ]),
      ],
    })
  );

  assert.deepEqual(states.at(-1).speakingIds, ["ann lee"]);
  await listener.stop();
});

test("stop while starting rejects the start without an error callback", async () => {
  const { listener, spawned } = createListener();
  const errors = [];
  const started = listener.start({ onError: (error) => errors.push(error) });
  await listener.stop();

  await assert.rejects(started);
  assert.equal(spawned[0].child.killedWith, "SIGTERM");
  assert.equal(errors.length, 0);
});

test("a helper that never starts is stopped after the start timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { listener, spawned } = createListener();
  const started = listener.start({});
  t.mock.timers.tick(3_000);

  await assert.rejects(started, /Timed out/);
  assert.equal(spawned[0].child.killedWith, "SIGTERM");
});

test("main reads the meeting app only for a recording that asked, outside 1:1s", () => {
  const { shouldReadMeetingApp } = MeetingSpeakerListener;
  const asked = { appSpeakerLabelsEnabled: true };
  assert.equal(
    shouldReadMeetingApp({ options: asked, oneOnOneAttendee: null, available: true }),
    true
  );
  assert.equal(
    shouldReadMeetingApp({ options: {}, oneOnOneAttendee: null, available: true }),
    false
  );
  assert.equal(
    shouldReadMeetingApp({ options: null, oneOnOneAttendee: null, available: true }),
    false
  );
  assert.equal(
    shouldReadMeetingApp({
      options: asked,
      oneOnOneAttendee: { displayName: "Jane Doe" },
      available: true,
    }),
    false
  );
  assert.equal(
    shouldReadMeetingApp({ options: asked, oneOnOneAttendee: null, available: false }),
    false
  );
});

test("someone the meeting app later marks as the user is never a remote name", async () => {
  const { listener, child, states } = await startListener();
  const teamsWindow = (nodes) => ({
    bundleId: "com.google.Chrome",
    title: "Weekly sync | Microsoft Teams - Google Chrome",
    frame: [0, 0, 1200, 900],
    nodes,
  });
  const tile = (label, frame) => ({ role: "AXMenuItem", description: label, frame });
  const snapshot = (at, nodes) => line({ type: "snapshot", at, windows: [teamsWindow(nodes)] });
  // Seen first in the participants panel, then as the user's own tile.
  child.stdout.emit(
    "data",
    snapshot(AT, [
      tile("Jane Doe (Guest), Context menu is available", [0, 0, 400, 225]),
      { role: "AXRow", subrole: "AXOutlineRow", description: "Priya Shah, Organizer, Unmuted" },
    ])
  );
  child.stdout.emit(
    "data",
    snapshot(AT + 1_000, [
      tile("Jane Doe (Guest), Context menu is available", [0, 0, 400, 225]),
      tile("Myself video, Priya Shah, Muted, Has context menu", [400, 0, 160, 90]),
    ])
  );
  // Her tile hidden again, her own words in the captions.
  child.stdout.emit(
    "data",
    snapshot(AT + 2_000, [
      tile("Jane Doe (Guest), Context menu is available", [0, 0, 400, 225]),
      { role: "AXGroup", description: "Live Captions", frame: [0, 600, 800, 200] },
      { role: "AXStaticText", value: "Priya Shah", frame: [40, 610, 60, 15] },
      { role: "AXStaticText", value: "Short reply.", frame: [40, 626, 90, 20] },
    ])
  );

  assert.deepEqual(states.at(-1).speakingIds, []);
  await listener.stop();
});

test("a start still waiting on the old helper is cancelled by a stop", async () => {
  const { listener, spawned } = await startListener();
  const oldChild = spawned[0].child;
  // The old helper takes its time to exit.
  oldChild.kill = (signal) => {
    oldChild.killedWith = signal;
  };
  const restarted = listener.start({});
  const stopped = listener.stop();
  oldChild.emit("exit", null, "SIGTERM");

  await assert.rejects(restarted, /cancelled/);
  await stopped;
  assert.equal(spawned.length, 1, "no new helper may be spawned after the stop");
});

test("output from a helper being stopped is ignored", async () => {
  const { listener, child, states } = await startListener();
  child.kill = (signal) => {
    child.killedWith = signal;
  };
  const stopped = listener.stop();
  // Written just before the helper saw SIGTERM.
  child.stdout.emit("data", line(SPEAKER_VIEW_SNAPSHOT));
  assert.equal(states.length, 0);
  child.emit("exit", null, "SIGTERM");
  await stopped;
});
