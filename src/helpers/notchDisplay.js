// Pure geometry helpers for the notch popup. No Electron imports so node --test can require it.

// Notch Macs report a ~37px menu bar inset; non-notch ~25px. 30px separates them.
const NOTCH_MENU_BAR_THRESHOLD_PX = 30;

// Wings are asymmetric, so bounds center the notch spacer, not the window frame.
const LEFT_WING_WIDTH = 68; // dot 6 + 6 gap + tabular M:SS + 8 inner + 10 outer
const RIGHT_WING_WIDTH = 48; // mic button + 8 inner + 10 outer

// Fallback heuristic (used only when the native probe has not measured this display).
// Notch width scales with logical display width, but the ratio depends on the
// physical panel. When scaleFactor is known, identify the panel by its physical
// pixel width; otherwise fall back to the 14" ratio. Clamp to a sane band.
const NOTCH_WIDTH_RATIO = 0.1228; // 14" MBP, calibrated via NSScreen.auxiliaryTopLeftArea
const NOTCH_PANELS = [
  { physicalWidth: 3024, ratio: 0.1228 }, // 14" MacBook Pro
  { physicalWidth: 3456, ratio: 0.1157 }, // 16" MacBook Pro
];
// 32px: MBA panels are uncalibrated; keeps MBA 15" (physical 3420) from matching 16" MBP (3456).
const PANEL_MATCH_TOLERANCE_PX = 32;
const MIN_NOTCH_WIDTH = 180;
const MAX_NOTCH_WIDTH = 264;

// Measured geometry from the native probe, keyed by logical width/height. Ground truth.
let measuredScreens = [];

function setMeasuredNotchWidths(screens) {
  measuredScreens = Array.isArray(screens) ? screens : [];
}

function clearMeasuredNotchWidths() {
  measuredScreens = [];
}

function measuredNotchWidth(display) {
  const bounds = display && display.bounds;
  if (!bounds) return 0;
  for (const s of measuredScreens) {
    if (s && s.width === bounds.width && s.height === bounds.height && s.notchWidth > 0) {
      return Math.round(s.notchWidth);
    }
  }
  return 0;
}

function estimatedNotchWidth(display) {
  const measured = measuredNotchWidth(display);
  if (measured > 0) return measured; // native probe is ground truth, unclamped
  const width = (display && display.bounds && display.bounds.width) || 0;
  const scaleFactor = display && display.scaleFactor;
  let ratio = NOTCH_WIDTH_RATIO;
  if (typeof scaleFactor === "number" && scaleFactor > 0) {
    // Scaled modes (e.g. "More Space") report a backing width above the native
    // panel, so match exactly and fall back to the ratio when nothing lines up.
    // Fallback-only: an unmatched panel over-/under-estimates by a few pt; the native probe removes the ceiling when present.
    const physicalWidth = width * scaleFactor;
    const panel = NOTCH_PANELS.find(
      (p) => Math.abs(physicalWidth - p.physicalWidth) <= PANEL_MATCH_TOLERANCE_PX
    );
    if (panel) ratio = panel.ratio;
  }
  const estimate = Math.round(width * ratio);
  return Math.min(MAX_NOTCH_WIDTH, Math.max(MIN_NOTCH_WIDTH, estimate));
}

function findInternalDisplay(displays) {
  if (!Array.isArray(displays)) return null;
  return displays.find((display) => display && display.internal === true) || null;
}

function displayHasNotch(display) {
  if (!display || !display.bounds || !display.workArea) return false;
  return display.workArea.y - display.bounds.y >= NOTCH_MENU_BAR_THRESHOLD_PX;
}

// Menu bar strip height; wings match it so they sit inline with the notch.
function computeMenuBarHeight(display) {
  if (!display || !display.bounds || !display.workArea) return 0;
  return Math.max(0, display.workArea.y - display.bounds.y);
}

// Fixed-size window centered on the display; the island morphs in CSS inside it.
function computeNotchPopupBounds(display, size) {
  const bounds = display.bounds;
  const width = (size && size.width) || 0;
  const height = (size && size.height) || 0;
  const x = Math.round(bounds.x + bounds.width / 2 - width / 2);
  return { x, y: bounds.y, width, height };
}

function resolveNotchPopup(displays, size) {
  const internal = findInternalDisplay(displays);
  if (!internal || !displayHasNotch(internal)) return null;
  return { display: internal, bounds: computeNotchPopupBounds(internal, size) };
}

module.exports = {
  NOTCH_MENU_BAR_THRESHOLD_PX,
  LEFT_WING_WIDTH,
  RIGHT_WING_WIDTH,
  MAX_NOTCH_WIDTH,
  findInternalDisplay,
  displayHasNotch,
  computeMenuBarHeight,
  estimatedNotchWidth,
  setMeasuredNotchWidths,
  clearMeasuredNotchWidths,
  computeNotchPopupBounds,
  resolveNotchPopup,
};
