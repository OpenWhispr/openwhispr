export function acceptsCorrectionEdit(original: string, edited: string): boolean {
  return !edited.startsWith(original) && !original.startsWith(edited);
}

export function retainsCorrectionContext(original: string[], edited: string[]): boolean {
  // A one-word dictation has no surrounding context to retain.
  if (original.length === 1 && edited.length === 1) return true;

  const remaining = new Map<string, number>();
  for (const word of original) {
    const key = word.toLowerCase();
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let retained = 0;
  for (const word of edited) {
    const key = word.toLowerCase();
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      retained += 1;
      remaining.set(key, count - 1);
    }
  }
  // Replacing most of a note is a rewrite, not reliable evidence that similar
  // words anywhere in the old and new bodies are spelling corrections.
  return retained >= Math.max(original.length, edited.length) / 2;
}
