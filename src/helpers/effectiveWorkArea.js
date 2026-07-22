// Corrects display.workArea on KDE/Linux: Chromium's X11 backend derives work areas from the
// single root _NET_WORKAREA, so at most one display gets clipped (possibly by another
// monitor's panel strut) and the rest keep workArea == bounds. We ask Plasma over D-Bus for
// per-screen geometry + panel struts and recompute the real per-monitor work areas.

const FETCH_TIMEOUT_MS = 400;
const CACHE_TTL_MS = 10000;
// Reject a computed inset that eats more than this share of the display dimension.
const MAX_INSET_RATIO = 0.45;
// Geometry match thresholds on rects normalized by each space's own bounding box.
const MATCH_TOLERANCE = 0.05;
const MATCH_AMBIGUITY_MARGIN = 0.02;

// Plasma scripting snapshot: screen geometry + panels. Pure ASCII, string-concatenated
// (no template literals inside the script), ends with a single JSON print.
const PLASMA_SCRIPT = [
  "var out={screens:[],panels:[]};",
  "for(var i=0;i<screenCount;i++){var g=screenGeometry(i);",
  "out.screens.push({i:i,x:g.x,y:g.y,w:g.width,h:g.height});}",
  "var ps=panels();",
  "for(var j=0;j<ps.length;j++){var p=ps[j];",
  "out.panels.push({screen:p.screen,location:p.location,height:p.height,width:p.width,hiding:p.hiding});}",
  "print(JSON.stringify(out));",
].join("");

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

const isValidBounds = (bounds) =>
  bounds !== null &&
  typeof bounds === "object" &&
  isFiniteNumber(bounds.x) &&
  isFiniteNumber(bounds.y) &&
  isFiniteNumber(bounds.width) &&
  isFiniteNumber(bounds.height);

// Parse the Plasma snapshot JSON into per-screen rects with reserved-edge insets.
// Only always-visible panels (hiding === "none") reserve space; side-by-side panels on
// one edge reserve a single band, so we keep the MAX thickness per edge, not the sum.
// Any malformed/empty/garbage reply yields [].
function parsePlasmaScreens(replyString) {
  if (typeof replyString !== "string") return [];

  let data;
  try {
    data = JSON.parse(replyString);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  if (!Array.isArray(data.screens)) return [];
  const rawPanels = Array.isArray(data.panels) ? data.panels : [];

  const insetsByScreen = new Map();
  const bumpEdge = (screenIndex, edge, thickness) => {
    if (!isFiniteNumber(thickness) || thickness <= 0) return;
    let entry = insetsByScreen.get(screenIndex);
    if (!entry) {
      entry = { top: 0, right: 0, bottom: 0, left: 0 };
      insetsByScreen.set(screenIndex, entry);
    }
    if (thickness > entry[edge]) entry[edge] = thickness;
  };

  for (const panel of rawPanels) {
    if (!panel || typeof panel !== "object") continue;
    if (panel.hiding !== "none") continue;
    if (!isFiniteNumber(panel.screen)) continue;
    const location = panel.location;
    if (location === "top" || location === "bottom") {
      bumpEdge(panel.screen, location, panel.height);
    } else if (location === "left" || location === "right") {
      // Vertical panels reserve width; fall back to height if width is absent.
      const thickness = isFiniteNumber(panel.width) && panel.width > 0 ? panel.width : panel.height;
      bumpEdge(panel.screen, location, thickness);
    }
  }

  const screens = [];
  for (const screen of data.screens) {
    if (!screen || typeof screen !== "object") continue;
    const { x, y, w, h } = screen;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) {
      continue;
    }
    if (w <= 0 || h <= 0) continue;
    const insets = (isFiniteNumber(screen.i) && insetsByScreen.get(screen.i)) || {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    };
    screens.push({
      x,
      y,
      w,
      h,
      insets: {
        top: insets.top,
        right: insets.right,
        bottom: insets.bottom,
        left: insets.left,
      },
    });
  }
  return screens;
}

// Bounding box (union) of a list of {x,y,w,h} rects, or null when none are usable.
function boundingBox(rects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y) || !isFiniteNumber(r.w) || !isFiniteNumber(r.h)) {
      continue;
    }
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { x: minX, y: minY, width, height };
}

// Match an Electron display to the Plasma screen for the same physical monitor. The two
// spaces can differ by a uniform scale (Qt logical vs Electron DIP), so each rect is
// normalized by its own space's bounding box before comparing position and size; a tie or
// no clear winner (mirrored screens, missing counterpart) returns null rather than guess.
function matchDisplayToPlasmaScreen(display, screens, allDisplayBounds) {
  if (!display || !isValidBounds(display.bounds)) return null;
  if (!Array.isArray(screens) || screens.length === 0) return null;

  const boundsList =
    Array.isArray(allDisplayBounds) && allDisplayBounds.length > 0
      ? allDisplayBounds.filter(isValidBounds)
      : [display.bounds];
  const displayRects = boundsList.map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height }));
  const electronBox = boundingBox(displayRects);
  const plasmaBox = boundingBox(screens);
  if (!electronBox || !plasmaBox) return null;

  const normalize = (r, box) => ({
    x: (r.x - box.x) / box.width,
    y: (r.y - box.y) / box.height,
    w: r.w / box.width,
    h: r.h / box.height,
  });
  const target = normalize(
    {
      x: display.bounds.x,
      y: display.bounds.y,
      w: display.bounds.width,
      h: display.bounds.height,
    },
    electronBox
  );

  let best = null;
  let bestDist = Infinity;
  let secondDist = Infinity;
  for (const s of screens) {
    const c = normalize(s, plasmaBox);
    const dist = Math.max(
      Math.abs(c.x - target.x),
      Math.abs(c.y - target.y),
      Math.abs(c.w - target.w),
      Math.abs(c.h - target.h)
    );
    if (dist < bestDist) {
      secondDist = bestDist;
      bestDist = dist;
      best = s;
    } else if (dist < secondDist) {
      secondDist = dist;
    }
  }

  if (!best || bestDist > MATCH_TOLERANCE) return null;
  // Ambiguous when the runner-up is not clearly farther (e.g. mirrored displays).
  if (secondDist - bestDist < MATCH_AMBIGUITY_MARGIN) return null;
  return best;
}

// Shrink the display's own bounds by the matched screen's insets. Plasma insets are logical
// pixels; scale them to the display's DIP bounds via the per-axis ratio (near 1 at same DPI).
// Negative origins are preserved; an inset over MAX_INSET_RATIO or a degenerate result -> null.
function computeEffectiveWorkArea(display, screen) {
  if (!display || !isValidBounds(display.bounds)) return null;
  if (!screen || typeof screen !== "object" || !screen.insets) return null;
  if (!isFiniteNumber(screen.w) || !isFiniteNumber(screen.h) || screen.w <= 0 || screen.h <= 0) {
    return null;
  }

  const { x: bx, y: by, width: bw, height: bh } = display.bounds;
  if (bw <= 0 || bh <= 0) return null;

  const ratioX = bw / screen.w;
  const ratioY = bh / screen.h;

  const top = Math.round((screen.insets.top || 0) * ratioY);
  const bottom = Math.round((screen.insets.bottom || 0) * ratioY);
  const left = Math.round((screen.insets.left || 0) * ratioX);
  const right = Math.round((screen.insets.right || 0) * ratioX);

  const maxV = bh * MAX_INSET_RATIO;
  const maxH = bw * MAX_INSET_RATIO;
  if (top > maxV || bottom > maxV || left > maxH || right > maxH) return null;

  const x = bx + left;
  const y = by + top;
  const width = bw - left - right;
  const height = bh - top - bottom;
  if (width <= 0 || height <= 0) return null;

  return { x, y, width, height };
}

// ---- Impure layer: synchronous, best-effort, stale-while-revalidate ------------------

let cache = { byDisplayId: new Map() };
let lastAttemptAt = 0;
let fetchInFlight = false;
let initialized = false;

function isKDE() {
  if (process.platform !== "linux") return false;
  return (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase().includes("kde");
}

function logDebug(message, meta) {
  try {
    require("./debugLogger").debug(message, meta, "effectiveWorkArea");
  } catch {
    // Logging must never break placement.
  }
}

function getDBus() {
  try {
    return require("@homebridge/dbus-native");
  } catch (err) {
    logDebug("dbus-native unavailable", { error: err && err.message });
    return null;
  }
}

// One short-lived session-bus connection per fetch. Resolves to the reply string or null.
// A single `finish` guard guarantees the connection is ended exactly once on every path
// (reply, D-Bus error, connection error, timeout) with no dangling promise to leak.
function fetchPlasmaSnapshot() {
  return new Promise((resolve) => {
    const dbus = getDBus();
    if (!dbus) return resolve(null);

    let bus;
    try {
      bus = dbus.sessionBus();
    } catch (err) {
      logDebug("sessionBus failed", { error: err && err.message });
      return resolve(null);
    }

    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        bus.connection.end();
      } catch {
        // connection may already be gone
      }
      resolve(value);
    };

    // Async socket errors surface as an "error" event; without a listener they crash the
    // process (sessionBus returns before connecting). Fold them into "no data".
    bus.connection.on("error", (err) => {
      logDebug("D-Bus connection error", { error: err && err.message });
      finish(null);
    });

    timer = setTimeout(() => finish(null), FETCH_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    try {
      bus.invoke(
        {
          type: dbus.messageType.methodCall,
          destination: "org.kde.plasmashell",
          path: "/PlasmaShell",
          interface: "org.kde.PlasmaShell",
          member: "evaluateScript",
          signature: "s",
          body: [PLASMA_SCRIPT],
        },
        (err, reply) => {
          if (err) {
            logDebug("evaluateScript failed", { error: err && err.message });
            return finish(null);
          }
          finish(typeof reply === "string" ? reply : null);
        }
      );
    } catch (err) {
      logDebug("invoke threw", { error: err && err.message });
      finish(null);
    }
  });
}

function refreshSnapshot() {
  if (fetchInFlight) return;
  fetchInFlight = true;
  lastAttemptAt = Date.now();
  fetchPlasmaSnapshot()
    .then((reply) => {
      if (reply === null) return;
      const screens = parsePlasmaScreens(reply);
      // Only trust snapshots carrying real panel data; then a zero-inset screen means "no
      // panel here" and overriding to bounds strips a foreign _NET_WORKAREA strut.
      const hasInsets = screens.some(
        (s) => s.insets.top > 0 || s.insets.bottom > 0 || s.insets.left > 0 || s.insets.right > 0
      );
      const byDisplayId = new Map();
      if (hasInsets) {
        const { screen } = require("electron");
        const displays = screen.getAllDisplays();
        const allBounds = displays.map((d) => d.bounds);
        for (const display of displays) {
          const matched = matchDisplayToPlasmaScreen(display, screens, allBounds);
          if (!matched) continue;
          const workArea = computeEffectiveWorkArea(display, matched);
          if (workArea) byDisplayId.set(display.id, workArea);
        }
      }
      cache = { byDisplayId };
    })
    .catch((err) => {
      logDebug("refresh failed", { error: err && err.message });
    })
    .finally(() => {
      fetchInFlight = false;
    });
}

function maybeRefresh() {
  if (Date.now() - lastAttemptAt > CACHE_TTL_MS) refreshSnapshot();
}

// Register screen-change invalidation once and kick a first prefetch. Idempotent; no-op off
// KDE/Linux. Must be called after app "ready" (uses electron `screen`), like other managers.
function init() {
  if (initialized) return;
  initialized = true;
  if (!isKDE()) return;

  const { screen } = require("electron");
  const invalidate = () => {
    cache = { byDisplayId: new Map() };
    lastAttemptAt = 0;
  };
  screen.on("display-added", invalidate);
  screen.on("display-removed", invalidate);
  screen.on("display-metrics-changed", invalidate);
  refreshSnapshot();
}

// Return a display whose workArea reflects real KDE panel struts, or the SAME object when we
// can't improve it. On Windows/macOS (correct per-monitor workArea natively) this is identity.
function resolveEffectiveDisplay(display) {
  if (!isKDE()) return display;
  if (!display || !isValidBounds(display.bounds)) return display;

  maybeRefresh();
  const corrected = cache.byDisplayId.get(display.id);
  if (!corrected) return display;
  return { ...display, workArea: { ...corrected } };
}

module.exports = {
  parsePlasmaScreens,
  matchDisplayToPlasmaScreen,
  computeEffectiveWorkArea,
  resolveEffectiveDisplay,
  init,
};
