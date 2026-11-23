import type { ParakeetModelInfo } from "./ModelRegistry";

export function parakeetDownloadSpace(
  bytes: number,
  modelType: ParakeetModelInfo["modelType"],
  archiveFactor: number
): number {
  // Bundle files move into place on the same disk. Archives coexist with their extracted weights.
  return bytes * (modelType === "qwen3-asr" ? 1.01 : archiveFactor);
}
