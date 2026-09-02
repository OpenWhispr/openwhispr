export type TreeHorizontalIntent = "inward" | "outward";

export function treeHorizontalIntent(
  key: string,
  direction: "ltr" | "rtl"
): TreeHorizontalIntent | null {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const inwardKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  return key === inwardKey ? "inward" : "outward";
}
