// Committed streaming text is the concatenation of completed turns. The current
// turn often still lives in the partial until generationComplete, so a stop
// that only kept the committed string dropped the last 10–15s of speech.
export function mergeStreamingTranscript(committed, partial) {
  const a = String(committed || "").trim();
  const b = String(partial || "").trim();
  if (!b) return a;
  if (!a) return b;
  if (a === b) return a;
  if (a.endsWith(b) || a.includes(b)) return a;
  if (b.startsWith(a) || b.includes(a)) return b;
  return `${a} ${b}`;
}
