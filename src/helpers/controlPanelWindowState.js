// Control panel window-state policy.
//
// Pure logic for persisting and restoring the control panel's bounds:
// (de)serialization for the .env-backed settings store and resolution of a
// saved state against the currently attached displays. Electron touchpoints
// stay thin in windowManager.js so this module is testable without a window.

// Below this the panel is unusable, so a broken store falls back to the default size.
const MIN_RESTORABLE_SIZE = { width: 320, height: 240 };

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Overlap/clamp math stays local for now; fold into the shared display
// resolver once the widget display-selection work lands.
function rectsOverlap(a, b) {
  const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapWidth > 0 && overlapHeight > 0;
}

function fitSizeToWorkArea(rect, workArea) {
  return {
    width: Math.min(rect.width, workArea.width),
    height: Math.min(rect.height, workArea.height),
  };
}

function clampIntoWorkArea(rect, workArea) {
  const { width, height } = fitSizeToWorkArea(rect, workArea);
  return {
    x: clampNumber(rect.x, workArea.x, workArea.x + workArea.width - width),
    y: clampNumber(rect.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function centerInWorkArea(rect, workArea) {
  const { width, height } = fitSizeToWorkArea(rect, workArea);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

function hasWorkArea(display) {
  return Boolean(
    display &&
    display.workArea &&
    isFiniteNumber(display.workArea.x) &&
    isFiniteNumber(display.workArea.y) &&
    isFiniteNumber(display.workArea.width) &&
    isFiniteNumber(display.workArea.height)
  );
}

export function normalizeControlPanelWindowState(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const { x, y, width, height } = candidate;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  if (roundedWidth < MIN_RESTORABLE_SIZE.width || roundedHeight < MIN_RESTORABLE_SIZE.height) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: roundedWidth,
    height: roundedHeight,
    isMaximized: candidate.isMaximized === true,
    displayId: isFiniteNumber(candidate.displayId) ? candidate.displayId : null,
  };
}

export function parseControlPanelWindowState(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeControlPanelWindowState(candidate);
}

export function serializeControlPanelWindowState(state) {
  const normalized = normalizeControlPanelWindowState(state);
  return normalized ? JSON.stringify(normalized) : "";
}

export function resolveControlPanelWindowState(saved, displays, primaryDisplay) {
  const state = normalizeControlPanelWindowState(saved);
  if (!state) return { bounds: null, maximize: false };

  const maximize = state.isMaximized;
  const usable = Array.isArray(displays) ? displays.filter(hasWorkArea) : [];
  if (usable.length === 0) return { bounds: null, maximize };

  const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };
  // Partial overlap with any work area counts as visible; fully off-screen does not.
  if (usable.some((display) => rectsOverlap(bounds, display.workArea))) {
    return { bounds, maximize };
  }

  const savedDisplay =
    state.displayId === null ? undefined : usable.find((display) => display.id === state.displayId);
  if (savedDisplay) {
    return { bounds: clampIntoWorkArea(bounds, savedDisplay.workArea), maximize };
  }

  // Saved display is gone: keep the size, fall back to centering on the primary.
  const fallback = hasWorkArea(primaryDisplay) ? primaryDisplay : usable[0];
  return { bounds: centerInWorkArea(bounds, fallback.workArea), maximize };
}
