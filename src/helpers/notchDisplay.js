// Pure geometry helpers for the notch popup. No Electron imports so node --test can require it.

// Notch Macs report a ~37px menu bar inset; non-notch ~25px. 30px separates them.
const NOTCH_MENU_BAR_THRESHOLD_PX = 30;

// Wings are asymmetric, so bounds center the notch spacer, not the window frame.
const LEFT_WING_WIDTH = 68; // dot 6 + 6 gap + tabular M:SS + 8 inner + 10 outer
const RIGHT_WING_WIDTH = 48; // mic button + 8 inner + 10 outer

// Notch width scales linearly with logical display width; clamp to a sane band.
const NOTCH_WIDTH_RATIO = 0.1323;
const MIN_NOTCH_WIDTH = 180;
const MAX_NOTCH_WIDTH = 264;

function estimatedNotchWidth(display) {
  const width = (display && display.bounds && display.bounds.width) || 0;
  const estimate = Math.round(width * NOTCH_WIDTH_RATIO);
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

function computeNotchPopupBounds(display, height) {
  const bounds = display.bounds;
  const spacer = estimatedNotchWidth(display);
  const width = LEFT_WING_WIDTH + spacer + RIGHT_WING_WIDTH;
  // Center the spacer on the display, not the frame (wings are asymmetric).
  const displayCenterX = bounds.x + bounds.width / 2;
  const x = Math.round(displayCenterX - spacer / 2 - LEFT_WING_WIDTH);
  const y = bounds.y;
  return { x, y, width, height };
}

function resolveNotchPopup(displays, size) {
  const internal = findInternalDisplay(displays);
  if (!internal || !displayHasNotch(internal)) return null;
  const height = typeof size === "number" ? size : (size && size.height) || 0;
  return { display: internal, bounds: computeNotchPopupBounds(internal, height) };
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
  computeNotchPopupBounds,
  resolveNotchPopup,
};
