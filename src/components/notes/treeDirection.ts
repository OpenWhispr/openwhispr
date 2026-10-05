export type TreeHorizontalIntent = "inward" | "outward";

const TREE_ROW_ACTION_WIDTH_PX = 20;
const TREE_ROW_ACTION_GAP_PX = 1;
const TREE_ROW_ACTION_END_INSET_PX = 6;
const TREE_ROW_ACTION_SAFETY_PX = 1;

export function treeRowActionClearanceStyle(actionCount = 2): { paddingInlineEnd: number } {
  const actionWidth = actionCount * TREE_ROW_ACTION_WIDTH_PX;
  const gapsWidth = Math.max(0, actionCount - 1) * TREE_ROW_ACTION_GAP_PX;
  return {
    paddingInlineEnd:
      TREE_ROW_ACTION_END_INSET_PX + actionWidth + gapsWidth + TREE_ROW_ACTION_SAFETY_PX,
  };
}

export function treeHorizontalIntent(
  key: string,
  direction: "ltr" | "rtl"
): TreeHorizontalIntent | null {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const inwardKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  return key === inwardKey ? "inward" : "outward";
}
