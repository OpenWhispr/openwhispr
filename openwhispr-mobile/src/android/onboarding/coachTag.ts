/** A box in the practice screen's coordinates, in dp. */
export type Frame = { x: number; y: number; width: number; height: number };

export type TagPlacement = {
  /** `outside`: beside the menu. `inside`: at the right end of the row, whose subtitle then hides. */
  mode: 'outside' | 'inside';
  /** Which way the tag points: `right` ("Pick ›") sits left of the menu, `left` ("‹ Pick") right of it. */
  points: 'left' | 'right';
  x: number;
  y: number;
};

/** The gap between the menu and the tag, and the room the tag needs from the screen edge. */
export const TAG_GAP = 8;
/** Inset from the row's right end when the tag has to go inside the row. */
export const TAG_INSET = 10;

/**
 * Where the practice coach tag goes (Figma rule card 5276:7769, Josh 19 Nov). Always from the
 * menu's measured position, never from screen numbers:
 * - its centre lines up with the target row's centre;
 * - 8 dp outside the menu, on the side facing the screen centre;
 * - with no room for 8 dp + tag + 8 dp there, inside the row at its right end.
 * `row` is the target row's frame inside the menu; `tag` is the tag's measured size.
 */
export function placeCoachTag(
  menu: Frame,
  row: Frame,
  tag: { width: number; height: number },
  screenWidth: number,
): TagPlacement {
  const y = menu.y + row.y + row.height / 2 - tag.height / 2;
  const menuCentre = menu.x + menu.width / 2;
  // The menu opens beside the bubble, so the screen centre is on the bubble's far side.
  const towardLeft = menuCentre >= screenWidth / 2;
  const room = towardLeft ? menu.x : screenWidth - (menu.x + menu.width);
  if (room >= TAG_GAP + tag.width + TAG_GAP)
    return towardLeft
      ? { mode: 'outside', points: 'right', x: menu.x - TAG_GAP - tag.width, y }
      : { mode: 'outside', points: 'left', x: menu.x + menu.width + TAG_GAP, y };
  return {
    mode: 'inside',
    points: towardLeft ? 'right' : 'left',
    x: menu.x + row.x + row.width - TAG_INSET - tag.width,
    y,
  };
}
