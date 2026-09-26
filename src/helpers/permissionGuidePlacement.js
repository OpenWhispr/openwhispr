// Placement for the permission guide overlay. Kept free of Electron so the
// geometry can be unit-tested: the manager supplies the work area, the size and
// the System Settings window bounds (null when it is closed or unreadable).

// The overlay sits inside the System Settings window, this far above its bottom
// edge; SCREEN_MARGIN is the gutter it keeps from the bottom of the screen when
// it falls back or when the inset spot would land off screen.
const BOTTOM_INSET = 20;
const SCREEN_MARGIN = 24;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function computeGuideBounds({ settingsBounds, workArea, size }) {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const lowestTop = workArea.y + workArea.height - height - SCREEN_MARGIN;

  const anchor = settingsBounds
    ? {
        x: settingsBounds.x + (settingsBounds.width - width) / 2,
        y: settingsBounds.y + settingsBounds.height - height - BOTTOM_INSET,
      }
    : { x: workArea.x + (workArea.width - width) / 2, y: lowestTop };

  return {
    x: Math.round(clamp(anchor.x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(anchor.y, workArea.y, lowestTop)),
    width,
    height,
  };
}

module.exports = { computeGuideBounds, BOTTOM_INSET, SCREEN_MARGIN };
