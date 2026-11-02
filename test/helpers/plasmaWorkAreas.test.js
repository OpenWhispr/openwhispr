const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const {
  computeWorkAreas,
  createPlasmaWorkAreas,
  fetchPlasmaSnapshot,
} = require("../../src/helpers/plasmaWorkAreas");
const { WindowPositionUtil } = require("../../src/helpers/windowConfig");

// #1110, measured on KWin 6.7.5 + Xwayland: a 1080p at 100% on the left and a 4K
// at 170% (primary) on the right, each with a 46 px bottom panel. Chromium clips
// only the primary with the single _NET_WORKAREA, and KWin built that rectangle
// from the 1080p's panel, so the 4K lost 236 DIP and the 1080p none.
const ELECTRON_DISPLAYS = [
  {
    id: 33,
    bounds: { x: -1, y: 0, width: 1918, height: 1079 },
    workArea: { x: -1, y: 0, width: 1918, height: 1079 },
  },
  {
    id: 35,
    bounds: { x: 1916, y: 0, width: 2256, height: 1269 },
    workArea: { x: 1916, y: 0, width: 2256, height: 1033 },
  },
];
const PLASMA_SNAPSHOT = {
  screens: [
    { x: 1920, y: 0, width: 2259, height: 1271 },
    { x: 0, y: 0, width: 1920, height: 1080 },
  ],
  panels: [
    { screen: 0, location: "bottom", thickness: 46, hiding: "none" },
    { screen: 1, location: "bottom", thickness: 46, hiding: "none" },
  ],
};
const PILL = { width: 211, height: 123 };

function singleScreen(panels) {
  return {
    snapshot: { screens: [{ x: 0, y: 0, width: 1920, height: 1080 }], panels },
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  };
}

test("each monitor's work area excludes its own panel, so the pill rests above it (#1110)", () => {
  const workAreas = computeWorkAreas(PLASMA_SNAPSHOT, ELECTRON_DISPLAYS);

  assert.deepEqual(workAreas.get(33), { x: -1, y: 0, width: 1918, height: 1033 });
  assert.deepEqual(workAreas.get(35), { x: 1916, y: 0, width: 2256, height: 1223 });
  for (const display of ELECTRON_DISPLAYS) {
    const pill = WindowPositionUtil.getMainWindowPosition(
      { ...display, workArea: workAreas.get(display.id) },
      PILL,
      "bottom-right"
    );
    const gapToScreenBottom = display.bounds.y + display.bounds.height - (pill.y + pill.height);
    assert.equal(gapToScreenBottom, 46 + 4, `display ${display.id}`);
  }
});

test("only always-visible panels reserve space, and panels sharing an edge take the thickest", () => {
  const { snapshot, displays } = singleScreen([
    { screen: 0, location: "bottom", thickness: 30, hiding: "none" },
    { screen: 0, location: "bottom", thickness: 46, hiding: "none" },
    { screen: 0, location: "left", thickness: 60, hiding: "none" },
    { screen: 0, location: "top", thickness: 24, hiding: "none" },
    { screen: 0, location: "top", thickness: 30, hiding: "autohide" },
    { screen: 0, location: "right", thickness: 40, hiding: "dodgewindows" },
  ]);

  assert.deepEqual(computeWorkAreas(snapshot, displays).get(1), {
    x: 60,
    y: 24,
    width: 1860,
    height: 1010,
  });
});

// A Plasma X11 session at 200% with two 4K monitors: Qt keeps each screen's
// origin in device pixels and scales only its size, while Chromium scales both.
const X11_DISPLAYS = [
  { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, scaleFactor: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
];
const X11_SNAPSHOT = {
  screens: [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 3840, y: 0, width: 1920, height: 1080 },
  ],
  panels: [{ screen: 1, location: "bottom", thickness: 44, hiding: "none" }],
};

test("on X11, Plasma's pixel origins are scaled like Chromium's before matching", () => {
  assert.equal(computeWorkAreas(X11_SNAPSHOT, X11_DISPLAYS).size, 0, "read as logical");

  const workAreas = computeWorkAreas(X11_SNAPSHOT, X11_DISPLAYS, { x11: true });

  assert.deepEqual(workAreas.get(1), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(workAreas.get(2), { x: 1920, y: 0, width: 1920, height: 1036 });
});

test("layouts that don't line up yield no corrections", () => {
  const { snapshot, displays } = singleScreen([]);
  const cases = {
    "a display Plasma doesn't list": [snapshot, ELECTRON_DISPLAYS],
    "a screen of another size": [
      { screens: [{ x: 0, y: 0, width: 1920, height: 1200 }], panels: [] },
      displays,
    ],
    "no screens": [{ panels: [] }, displays],
    "a panel without a usable thickness": [
      {
        ...snapshot,
        panels: [{ screen: 0, location: "bottom", thickness: "tall", hiding: "none" }],
      },
      displays,
    ],
  };
  for (const [name, [input, layout]] of Object.entries(cases)) {
    assert.equal(computeWorkAreas(input, layout).size, 0, name);
  }
});

function fakeScreen(displays) {
  const screen = new EventEmitter();
  screen.getAllDisplays = () => displays;
  return screen;
}

test("corrections apply once Plasma answers, and only to displays that kept their bounds", async () => {
  const screen = fakeScreen(ELECTRON_DISPLAYS);
  let changes = 0;
  const workAreas = createPlasmaWorkAreas({
    screen,
    fetchSnapshot: async () => PLASMA_SNAPSHOT,
    isActive: () => true,
  });

  assert.equal(workAreas.resolve(ELECTRON_DISPLAYS[1]), ELECTRON_DISPLAYS[1]);
  await workAreas.start(() => (changes += 1));

  assert.equal(workAreas.resolve(ELECTRON_DISPLAYS[1]).workArea.height, 1223);
  assert.equal(changes, 1);
  await workAreas.refresh();
  assert.equal(changes, 1, "an unchanged snapshot is not a change");

  const resized = { ...ELECTRON_DISPLAYS[1], bounds: { x: 1916, y: 0, width: 1920, height: 1080 } };
  assert.equal(workAreas.resolve(resized), resized);
});

test("an X11 session matches Plasma's screens by their pixel origins", async () => {
  const workAreas = createPlasmaWorkAreas({
    screen: fakeScreen(X11_DISPLAYS),
    fetchSnapshot: async () => X11_SNAPSHOT,
    isActive: () => true,
    isX11: () => true,
  });

  await workAreas.start(() => undefined);

  assert.equal(workAreas.resolve(X11_DISPLAYS[1]).workArea.height, 1036);
});

test("display events refresh, and a failed or mismatched snapshot keeps the last good corrections", async () => {
  const screen = fakeScreen(ELECTRON_DISPLAYS);
  let snapshots = 0;
  let changes = 0;
  let answer = PLASMA_SNAPSHOT;
  const workAreas = createPlasmaWorkAreas({
    screen,
    fetchSnapshot: async () => {
      snapshots += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    isActive: () => true,
  });
  await workAreas.start(() => (changes += 1));
  assert.equal(snapshots, 1);

  answer = new Error("plasmashell did not answer");
  screen.emit("display-metrics-changed");
  await workAreas.refresh();
  assert.equal(snapshots, 3, "the event's snapshot plus one rerun for the overlapping refresh");
  assert.equal(workAreas.resolve(ELECTRON_DISPLAYS[0]).workArea.height, 1033);

  // plasmashell answering a display change with its previous layout.
  answer = { screens: PLASMA_SNAPSHOT.screens.slice(0, 1), panels: [] };
  await workAreas.refresh();
  assert.equal(workAreas.resolve(ELECTRON_DISPLAYS[0]).workArea.height, 1033);
  assert.equal(changes, 1, "the pill isn't moved off the corrected work area");
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a snapshot that fails or doesn't match is retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answers = [new Error("plasmashell did not answer"), { screens: [], panels: [] }];
  let snapshots = 0;
  const workAreas = createPlasmaWorkAreas({
    screen: fakeScreen(ELECTRON_DISPLAYS),
    fetchSnapshot: async () => {
      const answer = answers[snapshots++] ?? PLASMA_SNAPSHOT;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    isActive: () => true,
  });

  await workAreas.start(() => undefined);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(snapshots, 2);
  assert.equal(workAreas.resolve(ELECTRON_DISPLAYS[1]), ELECTRON_DISPLAYS[1]);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(workAreas.resolve(ELECTRON_DISPLAYS[1]).workArea.height, 1223);
});

test("retries stop after three attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let snapshots = 0;
  const workAreas = createPlasmaWorkAreas({
    screen: fakeScreen(ELECTRON_DISPLAYS),
    fetchSnapshot: async () => {
      snapshots += 1;
      throw new Error("plasmashell did not answer");
    },
    isActive: () => true,
  });

  await workAreas.start(() => undefined);
  for (const delay of [1000, 5000, 15000, 60000]) {
    t.mock.timers.tick(delay);
    await settle();
  }

  assert.equal(snapshots, 4);
});

// plasmashell can still be starting long after login, then answer a later
// hotplug with its previous layout.
test("a display event restarts retries that ran out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const screen = fakeScreen(ELECTRON_DISPLAYS);
  let snapshots = 0;
  const workAreas = createPlasmaWorkAreas({
    screen,
    fetchSnapshot: async () => {
      snapshots += 1;
      throw new Error("plasmashell did not answer");
    },
    isActive: () => true,
  });
  await workAreas.start(() => undefined);
  for (const delay of [1000, 5000, 15000]) {
    t.mock.timers.tick(delay);
    await settle();
  }
  assert.equal(snapshots, 4);

  screen.emit("display-added");
  await settle();
  t.mock.timers.tick(1000);
  await settle();

  assert.equal(snapshots, 6, "the event's snapshot and its first retry");
});

test("a snapshot that succeeds cancels the pending retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let snapshots = 0;
  const workAreas = createPlasmaWorkAreas({
    screen: fakeScreen(ELECTRON_DISPLAYS),
    fetchSnapshot: async () => {
      if (snapshots++ === 0) throw new Error("plasmashell did not answer");
      return PLASMA_SNAPSHOT;
    },
    isActive: () => true,
  });
  await workAreas.start(() => undefined);
  await workAreas.refresh();
  assert.equal(snapshots, 2);

  t.mock.timers.tick(1000);
  await settle();

  assert.equal(snapshots, 2);
});

test("a single display keeps Chromium's work area and asks Plasma nothing", async () => {
  const display = ELECTRON_DISPLAYS[1];
  let snapshots = 0;
  const workAreas = createPlasmaWorkAreas({
    screen: fakeScreen([display]),
    fetchSnapshot: async () => {
      snapshots += 1;
      return PLASMA_SNAPSHOT;
    },
    isActive: () => true,
  });

  await workAreas.start(() => undefined);

  assert.equal(snapshots, 0);
  assert.equal(workAreas.resolve(display), display);
});

test("outside KDE nothing is fetched and displays pass through untouched", async () => {
  const screen = fakeScreen(ELECTRON_DISPLAYS);
  let snapshots = 0;
  const workAreas = createPlasmaWorkAreas({
    screen,
    fetchSnapshot: async () => {
      snapshots += 1;
      return PLASMA_SNAPSHOT;
    },
    isActive: () => false,
  });

  await workAreas.start(() => undefined);
  await workAreas.refresh();

  assert.equal(snapshots, 0);
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
  assert.equal(workAreas.resolve(ELECTRON_DISPLAYS[1]), ELECTRON_DISPLAYS[1]);
});

function fakeBus(answer) {
  const connection = Object.assign(new EventEmitter(), {
    ended: false,
    end() {
      this.ended = true;
    },
  });
  return {
    connection,
    messages: [],
    invoke(message, callback) {
      this.messages.push(message);
      answer?.(callback, connection);
    },
  };
}

function withDBus(bus, run) {
  const originalLoad = Module._load;
  Module._load = function loadWithFakeDBus(request, ...rest) {
    if (request === "@homebridge/dbus-native") return { sessionBus: () => bus };
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return run();
  } finally {
    Module._load = originalLoad;
  }
}

test("the snapshot is one evaluateScript call to plasmashell on the session bus", async () => {
  const bus = fakeBus((callback) => callback(null, JSON.stringify(PLASMA_SNAPSHOT)));

  assert.deepEqual(await withDBus(bus, fetchPlasmaSnapshot), PLASMA_SNAPSHOT);
  const [{ body, ...message }] = bus.messages;
  assert.deepEqual(message, {
    destination: "org.kde.plasmashell",
    path: "/PlasmaShell",
    interface: "org.kde.PlasmaShell",
    member: "evaluateScript",
    signature: "s",
  });
  assert.match(body[0], /screenGeometry\(i\)[\s\S]*panels\(\)/);
  assert.equal(bus.connection.ended, true);
});

test("a silent plasmashell or a broken bus fails the snapshot and closes the bus", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const silent = fakeBus();
  const pending = withDBus(silent, fetchPlasmaSnapshot);
  t.mock.timers.tick(400);
  await assert.rejects(pending, /did not answer/);
  assert.equal(silent.connection.ended, true);

  const broken = fakeBus((_callback, connection) =>
    connection.emit("error", new Error("connect ECONNREFUSED"))
  );
  await assert.rejects(withDBus(broken, fetchPlasmaSnapshot), /ECONNREFUSED/);
  assert.equal(broken.connection.ended, true);
});
