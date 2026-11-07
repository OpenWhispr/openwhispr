// Geometry for the agent window. Kept free of Electron so it can be
// unit-tested: the manager supplies the work area and where the dictation pill is.

// The window shrinks to what it shows, plus an 8px margin on every side for
// the surface's shadow; on Windows and Linux its transparent parts still take
// clicks. The pill row is never wider than PILL_CONTENT_WIDTH (the idle pill,
// with Call, is 206px, and Thinking… in German 199px), except the pill that reads
// "Waiting for answer" (the reference's is 287px, French 299px) or a notice.
const SHADOW_MARGIN = 8;
const PILL_CONTENT_WIDTH = 216;
const WAITING_PILL_CONTENT_WIDTH = 304;
const PILL_HEIGHT = 40;
const COMPOSER = { width: 510, height: 145 };
const COMPOSER_GAP = 12;
const MODAL = { width: 480, height: 520 };
// A standalone card is as tall as it measures, within these bounds; a taller
// one scrolls inside.
const STANDALONE_CARD = { width: 420, minHeight: 80, maxHeight: 400 };
// In a voice call the pill carries its status above it (237×65 in the reference);
// its transcript is the modal, as in typed chat.
const CALL_PILL = { width: 240, height: 65 };
// A long answer card with the call's pill is about 597px in the reference.
const CALL_CARD_MAX_HEIGHT = 520;

const standaloneSize = (cardHeight, pillHeight = PILL_HEIGHT) => ({
  width: STANDALONE_CARD.width + 2 * SHADOW_MARGIN,
  height: cardHeight + COMPOSER_GAP + pillHeight + 2 * SHADOW_MARGIN,
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function callLayoutSize(layout, contentHeight) {
  if (layout === "standalone") {
    return standaloneSize(
      clamp(contentHeight, STANDALONE_CARD.minHeight, CALL_CARD_MAX_HEIGHT),
      CALL_PILL.height
    );
  }
  if (layout === "modal") return AGENT_LAYOUT_SIZES.modal;
  return {
    width: CALL_PILL.width + 2 * SHADOW_MARGIN,
    height: CALL_PILL.height + 2 * SHADOW_MARGIN,
  };
}

const AGENT_LAYOUT_SIZES = Object.freeze({
  pill: {
    width: PILL_CONTENT_WIDTH + 2 * SHADOW_MARGIN,
    height: PILL_HEIGHT + 2 * SHADOW_MARGIN,
  },
  typing: {
    width: COMPOSER.width + 2 * SHADOW_MARGIN,
    height: COMPOSER.height + COMPOSER_GAP + PILL_HEIGHT + 2 * SHADOW_MARGIN,
  },
  standalone: standaloneSize(STANDALONE_CARD.minHeight),
  modal: {
    width: MODAL.width + 2 * SHADOW_MARGIN,
    height: MODAL.height + 2 * SHADOW_MARGIN,
  },
});

const WAITING_PILL_SIZE = Object.freeze({
  width: WAITING_PILL_CONTENT_WIDTH + 2 * SHADOW_MARGIN,
  height: PILL_HEIGHT + 2 * SHADOW_MARGIN,
});

// The window's bottom edge sits this far above the work area's, which puts the
// pill where the dictation pill docks (12px up).
const BOTTOM_MARGIN = 4;
// A center-docked dictation pill: its 12px dock inset, its 40px idle height,
// and the gap kept between it (or its window) and the agent window.
const DICTATION_DOCK_INSET = 12;
const DICTATION_PILL_HEIGHT = 40;
const DICTATION_GAP = 8;

// The top of the dock's zone: its pill stays in the lower 40%.
const dockZoneTop = (workArea) =>
  workArea.y + workArea.height * 0.6 + AGENT_LAYOUT_SIZES.pill.height;

/**
 * Where the window's bottom-center sits on a display: the bottom center of the
 * work area, lifted above the dictation pill when that pill is docked in the
 * center of the same display. Where the dictation window takes clicks across
 * its whole area (Windows), it is lifted above that window instead. A pill
 * that leaves no room for the agent above it within the lower 40% isn't in
 * the way.
 */
function computeAgentAnchor({
  workArea,
  dictationBounds = null,
  wholeDictationWindowTakesClicks = false,
}) {
  const centerX = workArea.x + workArea.width / 2;
  let bottom = workArea.y + workArea.height - BOTTOM_MARGIN;
  const pillTop = dictationBounds
    ? dictationBounds.y + dictationBounds.height - DICTATION_DOCK_INSET - DICTATION_PILL_HEIGHT
    : null;
  if (pillTop !== null && pillTop - DICTATION_GAP >= dockZoneTop(workArea)) {
    const dictationTop = wholeDictationWindowTakesClicks ? dictationBounds.y : pillTop;
    bottom = Math.min(bottom, dictationTop - DICTATION_GAP);
  }
  return { centerX, bottom };
}

// Keep the dock in the lower 40%, with room for every layout to open upward
// and a small inset from the sides, as in the assistant's placement spec.
function clampAgentAnchor(
  anchor,
  workArea,
  maxBottom = workArea.y + workArea.height - BOTTOM_MARGIN
) {
  const halfWidth = Math.min(AGENT_LAYOUT_SIZES.typing.width / 2, workArea.width * 0.44);
  const sideInset = workArea.width * 0.06 + halfWidth;
  const minBottom = Math.min(
    maxBottom,
    Math.max(dockZoneTop(workArea), workArea.y + AGENT_LAYOUT_SIZES.modal.height)
  );
  return {
    centerX: Math.max(
      workArea.x + sideInset,
      Math.min(anchor.centerX, workArea.x + workArea.width - sideInset)
    ),
    bottom: Math.max(minBottom, Math.min(anchor.bottom, maxBottom)),
  };
}

/**
 * The window's bounds for a layout, kept inside the work area: a modal too
 * tall for it shrinks. A standalone card brings its measured height; a wide
 * pill is the one waiting for an answer. A voice call has its own pill.
 */
function computeAgentWindowBounds({
  anchor,
  layout,
  workArea,
  contentHeight = 0,
  wide = false,
  call = false,
}) {
  const size = call
    ? callLayoutSize(layout, contentHeight)
    : layout === "standalone"
      ? standaloneSize(clamp(contentHeight, STANDALONE_CARD.minHeight, STANDALONE_CARD.maxHeight))
      : layout === "pill" && wide
        ? WAITING_PILL_SIZE
        : (AGENT_LAYOUT_SIZES[layout] ?? AGENT_LAYOUT_SIZES.pill);
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

module.exports = {
  AGENT_LAYOUT_SIZES,
  WAITING_PILL_SIZE,
  computeAgentAnchor,
  clampAgentAnchor,
  computeAgentWindowBounds,
};
