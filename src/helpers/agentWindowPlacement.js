// Geometry for the agent window. Kept free of Electron so it can be
// unit-tested: the manager supplies the work area and where the dictation pill is.

// The window shrinks to what it shows, plus an 8px margin on every side for
// the surface's shadow. The pill row is never wider than PILL_CONTENT_WIDTH;
// the reference pill (173px) sits centered inside it.
const SHADOW_MARGIN = 8;
const PILL_CONTENT_WIDTH = 240;
const PILL_HEIGHT = 40;
const COMPOSER = { width: 510, height: 145 };
const COMPOSER_GAP = 12;
const MODAL = { width: 480, height: 520 };

const AGENT_LAYOUT_SIZES = Object.freeze({
  pill: {
    width: PILL_CONTENT_WIDTH + 2 * SHADOW_MARGIN,
    height: PILL_HEIGHT + 2 * SHADOW_MARGIN,
  },
  typing: {
    width: COMPOSER.width + 2 * SHADOW_MARGIN,
    height: COMPOSER.height + COMPOSER_GAP + PILL_HEIGHT + 2 * SHADOW_MARGIN,
  },
  modal: {
    width: MODAL.width + 2 * SHADOW_MARGIN,
    height: MODAL.height + 2 * SHADOW_MARGIN,
  },
});

// The window's bottom edge sits this far above the work area's, which puts the
// pill where the dictation pill docks (12px up).
const BOTTOM_MARGIN = 4;
// A center-docked dictation pill: its 12px dock inset, its 40px idle height,
// and the gap kept between it (or its window) and the agent window.
const DICTATION_DOCK_INSET = 12;
const DICTATION_PILL_HEIGHT = 40;
const DICTATION_GAP = 8;

/**
 * Where the window's bottom-center sits on a display: the bottom center of the
 * work area, lifted above the dictation pill when that pill is docked in the
 * center of the same display. Where the dictation window takes clicks across
 * its whole area (Windows), it is lifted above that window instead.
 */
function computeAgentAnchor({
  workArea,
  dictationBounds = null,
  wholeDictationWindowTakesClicks = false,
}) {
  const centerX = workArea.x + workArea.width / 2;
  let bottom = workArea.y + workArea.height - BOTTOM_MARGIN;
  if (dictationBounds) {
    const dictationTop = wholeDictationWindowTakesClicks
      ? dictationBounds.y
      : dictationBounds.y + dictationBounds.height - DICTATION_DOCK_INSET - DICTATION_PILL_HEIGHT;
    bottom = Math.min(bottom, dictationTop - DICTATION_GAP);
  }
  return { centerX, bottom };
}

/** The window's bounds for a layout, kept inside the work area: a modal too tall for it shrinks. */
function computeAgentWindowBounds({ anchor, layout, workArea }) {
  const size = AGENT_LAYOUT_SIZES[layout] ?? AGENT_LAYOUT_SIZES.pill;
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const x = Math.round(anchor.centerX - width / 2);
  const y = Math.round(anchor.bottom - height);
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

module.exports = { AGENT_LAYOUT_SIZES, computeAgentAnchor, computeAgentWindowBounds };
