// The Add to team / Add to teamspace menus in Figma ("State / Choose space"): a 240px panel with
// 8px padding, rows 29px tall (4px padding around a 21px line) spaced 8px apart, 9px row radius,
// a 20px icon slot (or a 16px box) and a 4px gap before the label.
export const MENU_PANEL = "w-60 max-w-[calc(100vw-32px)] rounded-xl p-2";

/** Stacks a menu's rows with the design's 8px between them. */
export const MENU_ROWS = "flex flex-col gap-2";

/** A plain or submenu-trigger row. */
export const MENU_ROW = "gap-1 rounded-[9px] p-1 text-sm leading-[21px] focus:bg-muted";
export const MENU_SUBMENU_TRIGGER = `${MENU_ROW} data-[state=open]:bg-muted`;

/** A row with a box in front: the box sits in a 20px slot, so the label starts at 28px. */
export const MENU_CHECK_ROW =
  "rounded-[9px] p-1 ps-7 pe-1 text-sm leading-[21px] focus:bg-muted data-[disabled]:opacity-100";

/** A 14px icon centred in the row's 20px slot. */
export const MENU_ICON = "mx-[3px] size-3.5 shrink-0 text-muted-foreground";
