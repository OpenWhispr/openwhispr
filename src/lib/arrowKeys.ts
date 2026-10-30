export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export function isArrowKey(key: string): key is ArrowKey {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}

// A row laid out with flex follows the document direction, so right to left
// the left arrow moves forward.
export function logicalArrowKey(key: ArrowKey, dir: "ltr" | "rtl"): ArrowKey {
  if (dir !== "rtl") return key;
  if (key === "ArrowLeft") return "ArrowRight";
  if (key === "ArrowRight") return "ArrowLeft";
  return key;
}
