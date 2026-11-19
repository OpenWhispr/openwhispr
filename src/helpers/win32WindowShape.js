const { isValidWindowInputRegion } = require("./windowInputRegion");

// getBounds() rounds edges outward at fractional DPI, so the window can read up
// to two DIPs larger than the viewport the renderer measured.
const SIZE_TOLERANCE_DIP = 2;

const fitsWindow = (width, height, bounds) =>
  Math.abs(width - bounds.width) <= SIZE_TOLERANCE_DIP &&
  Math.abs(height - bounds.height) <= SIZE_TOLERANCE_DIP;

// The dictation window sets no zoom, so the renderer's CSS pixels are the
// window's DIPs.
function shapeRect(region, bounds) {
  const x = Math.min(Math.max(0, Math.floor(region.x)), bounds.width - 1);
  const y = Math.min(Math.max(0, Math.floor(region.y)), bounds.height - 1);
  const right = Math.max(x + 1, Math.min(bounds.width, Math.ceil(region.x + region.width)));
  const bottom = Math.max(y + 1, Math.min(bounds.height, Math.ceil(region.y + region.height)));
  return { x, y, width: right - x, height: bottom - y };
}

// setShape is SetWindowRgn: it limits painting as well as clicks, and an empty
// list restores the full window. Chromium keeps the region in window-relative
// physical pixels through resizes and moves, so a resize leaves it covering the
// wrong part of the window and a move to another display's scale leaves it the
// wrong size. revalidate() repairs both after the window's bounds change, and
// prepareResize() clears ahead of the app's own resizes.
function createWin32WindowShape(win) {
  // The narrow shape and the window size it was measured for, or null while
  // the whole window is shown.
  let shape = null;
  let cleared = false;

  // Chromium skips a region equal to the current one, and converts DIPs at the
  // window's current scale, so a narrow shape can always be applied again. It
  // repaints the window on every empty one, though.
  const apply = (rects) => {
    if (!rects.length && cleared) return;
    cleared = !rects.length;
    win.setShape(rects);
  };

  const clear = () => {
    shape = null;
    apply([]);
  };

  const set = (region) => {
    if (region === null) return clear();
    if (!isValidWindowInputRegion(region)) {
      // The renderer stops shaping after a failure, so leave the whole window
      // rather than a shape the pill may outgrow.
      clear();
      throw new Error("Invalid input region");
    }
    const bounds = win.getBounds();
    // A viewport that doesn't match the window was measured before a resize.
    if (
      region.width === 0 ||
      region.height === 0 ||
      !fitsWindow(region.viewportWidth, region.viewportHeight, bounds)
    ) {
      return clear();
    }
    shape = { rects: [shapeRect(region, bounds)], width: bounds.width, height: bounds.height };
    apply(shape.rects);
  };

  const revalidate = () => {
    if (!shape) return;
    if (fitsWindow(shape.width, shape.height, win.getBounds())) apply(shape.rects);
    else clear();
  };

  // revalidate() only runs once the window has its new size, so a resize the
  // app makes clears a shape that won't fit before setBounds.
  const prepareResize = (bounds) => {
    if (shape && !fitsWindow(shape.width, shape.height, bounds)) clear();
  };

  return { set, revalidate, prepareResize };
}

module.exports = { createWin32WindowShape };
