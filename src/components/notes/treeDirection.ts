export type TreeHorizontalIntent = "inward" | "outward";

// Two 20px actions, their 1px gap, and the 6px logical-end inset need 47px.
// Round up one pixel so mixed-direction labels never share the action box.
const TREE_ROW_ACTION_CLEARANCE_PX = 48;

export function treeRowActionClearanceStyle(): { paddingInlineEnd: number } {
  return { paddingInlineEnd: TREE_ROW_ACTION_CLEARANCE_PX };
}

export function treeHorizontalIntent(
  key: string,
  direction: "ltr" | "rtl"
): TreeHorizontalIntent | null {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const inwardKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  return key === inwardKey ? "inward" : "outward";
}
