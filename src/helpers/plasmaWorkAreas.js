const { screen } = require("electron");
const debugLogger = require("./debugLogger");
const KDEShortcutManager = require("./kdeShortcut");
const { getLinuxSessionInfo } = require("./linuxSession");

// On X11, and on XWayland where the app runs in a KDE Wayland session, Chromium
// builds every display's workArea from the single root _NET_WORKAREA: only the
// primary display gets clipped, and KWin computes that one rectangle from every
// monitor's panels at once. So one monitor's panel is ignored while another's
// cuts into the primary (#1110). Plasma knows each screen's panels, so the
// work areas the pill is placed against are rebuilt from what it reports.

const SNAPSHOT_TIMEOUT_MS = 400;
// plasmashell can still be starting at login, or answer a display change with
// its previous layout.
const RETRY_DELAYS_MS = [1000, 5000, 15000];
// Plasma reports logical pixels and Electron DIPs, which round differently.
const GEOMETRY_TOLERANCE = 0.02;
const EDGES = ["top", "right", "bottom", "left"];

// Runs in plasmashell's script engine. A panel's height is its thickness on
// every edge, and only an always-visible panel reserves space.
const SNAPSHOT_SCRIPT = [
  "var screens = [];",
  "for (var i = 0; i < screenCount; i++) {",
  "  var g = screenGeometry(i);",
  "  screens.push({ x: g.x, y: g.y, width: g.width, height: g.height });",
  "}",
  "print(JSON.stringify({ screens: screens, panels: panels().map(function (p) {",
  "  return { screen: p.screen, location: p.location, thickness: p.height, hiding: p.hiding };",
  "}) }));",
].join("\n");

function unionOf(rects) {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  return { x: left, y: top, width: Math.max(...rects.map((rect) => rect.x + rect.width)) - left };
}

function withinTolerance(value, expected, size) {
  return Math.abs(value - expected) <= size * GEOMETRY_TOLERANCE;
}

// Plasma's logical layout and Electron's DIP layout differ by one factor:
// XWayland scales every output alike and Chromium uses one scale on X11. Each
// display is matched to the Plasma screen at the same scaled place and size;
// anything that doesn't match one-to-one yields no corrections at all.
function computeWorkAreas(snapshot, displays, { x11 = false } = {}) {
  const workAreas = new Map();
  if (
    !Array.isArray(snapshot?.screens) ||
    !snapshot.screens.length ||
    snapshot.screens.length !== displays.length
  ) {
    return workAreas;
  }
  // On X11, Qt keeps each screen's origin in device pixels and scales only its
  // size (QHighDpi::fromNativeScreenGeometry), while Chromium scales both.
  const originScale = x11 ? displays[0].scaleFactor : 1;
  const screens = snapshot.screens.map((rect) => ({
    ...rect,
    x: rect.x / originScale,
    y: rect.y / originScale,
  }));

  const insets = screens.map(() => ({ top: 0, right: 0, bottom: 0, left: 0 }));
  for (const panel of Array.isArray(snapshot.panels) ? snapshot.panels : []) {
    const screenInsets = insets[panel?.screen];
    if (!screenInsets || panel.hiding !== "none" || !EDGES.includes(panel.location)) continue;
    screenInsets[panel.location] = Math.max(screenInsets[panel.location], panel.thickness);
  }

  const displayUnion = unionOf(displays.map((display) => display.bounds));
  const screenUnion = unionOf(screens);
  const scale = displayUnion.width / screenUnion.width;
  const matched = new Set();
  for (const { id, bounds } of displays) {
    const index = screens.findIndex(
      (rect, i) =>
        !matched.has(i) &&
        withinTolerance(
          (rect.x - screenUnion.x) * scale + displayUnion.x,
          bounds.x,
          bounds.width
        ) &&
        withinTolerance(
          (rect.y - screenUnion.y) * scale + displayUnion.y,
          bounds.y,
          bounds.height
        ) &&
        withinTolerance(rect.width * scale, bounds.width, bounds.width) &&
        withinTolerance(rect.height * scale, bounds.height, bounds.height)
    );
    if (index === -1) return new Map();
    matched.add(index);
    const [top, right, bottom, left] = EDGES.map((edge) => Math.round(insets[index][edge] * scale));
    const workArea = {
      x: bounds.x + left,
      y: bounds.y + top,
      width: bounds.width - left - right,
      height: bounds.height - top - bottom,
    };
    if (!(workArea.width > 0 && workArea.height > 0)) return new Map();
    workAreas.set(id, workArea);
  }
  return workAreas;
}

function sameBounds(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function createPlasmaWorkAreas({ screen, fetchSnapshot, isActive, isX11 = () => false }) {
  let corrections = new Map();
  let onChange = null;
  let started = false;
  let inFlight = null;
  let rerun = false;
  let retryTimer = null;
  let retries = 0;

  function resetRetries() {
    clearTimeout(retryTimer);
    retryTimer = null;
    retries = 0;
  }

  function retryLater() {
    if (retryTimer || retries >= RETRY_DELAYS_MS.length) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void refresh();
    }, RETRY_DELAYS_MS[retries++]);
    retryTimer.unref?.();
  }

  function apply(next) {
    if (JSON.stringify([...next]) === JSON.stringify([...corrections])) return;
    corrections = next;
    debugLogger.debug(
      "[PlasmaWorkAreas] Work areas changed",
      { workAreas: Object.fromEntries([...next].map(([id, { workArea }]) => [id, workArea])) },
      "window"
    );
    onChange?.();
  }

  async function load() {
    // With one display Chromium's work area is already right: the root work
    // area lies inside it, and it also counts docks Plasma doesn't know about.
    if (screen.getAllDisplays().length < 2) {
      apply(new Map());
      return;
    }
    // A failed or mismatched snapshot keeps the last good corrections:
    // plasmashell restarting, busy or answering with its previous layout says
    // nothing about the panels having changed.
    let snapshot;
    try {
      snapshot = await fetchSnapshot();
    } catch (error) {
      debugLogger.debug(
        "[PlasmaWorkAreas] plasmashell unavailable",
        { error: error?.message || String(error) },
        "window"
      );
      retryLater();
      return;
    }
    const displays = screen.getAllDisplays();
    const workAreas = computeWorkAreas(snapshot, displays, { x11: isX11() });
    if (!workAreas.size) {
      debugLogger.debug(
        "[PlasmaWorkAreas] Plasma's answer doesn't fit the displays",
        { screens: snapshot?.screens, displays: displays.map((display) => display.bounds) },
        "window"
      );
      retryLater();
      return;
    }
    resetRetries();
    apply(
      new Map(
        displays
          .filter((display) => workAreas.has(display.id))
          .map((display) => [
            display.id,
            { bounds: display.bounds, workArea: workAreas.get(display.id) },
          ])
      )
    );
  }

  // A display event can land while a snapshot is in flight; that snapshot may
  // predate it, so one more runs afterwards.
  function refresh() {
    if (!started) return Promise.resolve();
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = load().finally(() => {
      inFlight = null;
      if (rerun) {
        rerun = false;
        void refresh();
      }
    });
    return inFlight;
  }

  function start(handleChange) {
    if (started || !isActive()) return Promise.resolve();
    started = true;
    onChange = handleChange;
    // A display change is a new layout to retry for, even after an earlier
    // layout used up its retries. Shows don't reset them, so a plasmashell
    // that never answers isn't asked three more times per dictation.
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
      screen.on(event, () => {
        resetRetries();
        void refresh();
      });
    }
    return refresh();
  }

  function resolve(display) {
    const correction = corrections.get(display.id);
    if (!correction || !sameBounds(correction.bounds, display.bounds)) return display;
    return { ...display, workArea: { ...correction.workArea } };
  }

  return { start, refresh, resolve };
}

function fetchPlasmaSnapshot() {
  let bus;
  try {
    bus = require("@homebridge/dbus-native").sessionBus();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      bus.connection.end();
      if (error) reject(error);
      else resolve(reply);
    };
    const timeoutId = setTimeout(
      () => finish(new Error("plasmashell did not answer")),
      SNAPSHOT_TIMEOUT_MS
    );
    timeoutId.unref?.();
    // sessionBus() returns before connecting, so a stale bus address only
    // surfaces as an "error" event, which would otherwise crash the process.
    bus.connection.on("error", finish);
    bus.invoke(
      {
        destination: "org.kde.plasmashell",
        path: "/PlasmaShell",
        interface: "org.kde.PlasmaShell",
        member: "evaluateScript",
        signature: "s",
        body: [SNAPSHOT_SCRIPT],
      },
      finish
    );
  }).then((reply) => JSON.parse(reply));
}

const plasmaWorkAreas = createPlasmaWorkAreas({
  screen,
  fetchSnapshot: fetchPlasmaSnapshot,
  isActive: () => process.platform === "linux" && KDEShortcutManager.isKDE(),
  isX11: () => !getLinuxSessionInfo().isWayland,
});

module.exports = { computeWorkAreas, createPlasmaWorkAreas, fetchPlasmaSnapshot, plasmaWorkAreas };
