// Matches the size segment of a registry id: "-9b", "-1.7b", "-350m", and
// Gemma's effective-size "-e4b". The lookahead stops "-4-" in "gemma-4-…" matching.
const SIZE_SEGMENT = /-e?(\d+(?:\.\d+)?)([bm])(?=$|[-_.])/i;

export function estimateModelSizeB(modelId: string): number {
  const match = modelId.match(SIZE_SEGMENT);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  return match[2].toLowerCase() === "m" ? value / 1000 : value;
}
