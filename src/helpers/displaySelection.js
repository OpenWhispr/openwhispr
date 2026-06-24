// Pure helpers for pinning the dictation widget to a specific monitor.
// CommonJS so windowManager.js (require) can consume it; Electron-free for unit tests.

const AUTO_DISPLAY = "auto";

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

// Validate the { x, y, width, height } shape, all finite numbers.
const isValidBounds = (bounds) =>
  bounds !== null &&
  typeof bounds === "object" &&
  isFiniteNumber(bounds.x) &&
  isFiniteNumber(bounds.y) &&
  isFiniteNumber(bounds.width) &&
  isFiniteNumber(bounds.height);

// Parse + strictly validate a panelDisplay string. Returns null for "auto" or any
// malformed/wrong-shape input. See SHARED CONTRACT value format.
function decodeDisplayChoice(value) {
  if (typeof value !== "string") return null;
  if (value === AUTO_DISPLAY) return null;

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!isFiniteNumber(parsed.id)) return null;
  if (typeof parsed.label !== "string") return null;
  if (!isValidBounds(parsed.bounds)) return null;

  const { x, y, width, height } = parsed.bounds;
  return {
    id: parsed.id,
    label: parsed.label,
    bounds: { x, y, width, height },
  };
}

// Re-encode a valid choice into canonical JSON, or "auto" for anything invalid.
function sanitizePanelDisplayValue(value) {
  const choice = decodeDisplayChoice(value);
  if (!choice) return AUTO_DISPLAY;
  return JSON.stringify({
    id: choice.id,
    label: choice.label,
    bounds: choice.bounds,
  });
}

// Area of the overlap between two { x, y, width, height } rects (0 if they don't overlap).
function intersectionArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

// Resolve a panelDisplay value to one of allDisplays, falling back when unresolvable.
// Match order: id -> unique non-empty label -> largest bounds overlap (>0) -> fallback.
function resolveTargetDisplay(value, allDisplays, fallbackDisplay) {
  const choice = decodeDisplayChoice(value);
  if (!choice) return fallbackDisplay;
  if (!Array.isArray(allDisplays) || allDisplays.length === 0) return fallbackDisplay;

  const byId = allDisplays.find((d) => d.id === choice.id);
  if (byId) return byId;

  if (typeof choice.label === "string" && choice.label !== "") {
    const labelMatches = allDisplays.filter((d) => d.label === choice.label);
    if (labelMatches.length === 1) return labelMatches[0];
  }

  let best = null;
  let bestArea = 0;
  for (const d of allDisplays) {
    if (!d || !isValidBounds(d.bounds)) continue;
    const area = intersectionArea(choice.bounds, d.bounds);
    if (area > bestArea) {
      bestArea = area;
      best = d;
    }
  }
  if (best) return best;

  return fallbackDisplay;
}

module.exports = {
  AUTO_DISPLAY,
  decodeDisplayChoice,
  sanitizePanelDisplayValue,
  resolveTargetDisplay,
};
