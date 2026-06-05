export type DictionaryReplacement = {
  from: string;
  to: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeDictionaryReplacements(
  replacements: DictionaryReplacement[] | undefined
): DictionaryReplacement[] {
  if (!Array.isArray(replacements)) return [];

  const seen = new Set<string>();
  return replacements
    .map((replacement) => ({
      from: typeof replacement?.from === "string" ? replacement.from.trim() : "",
      to: typeof replacement?.to === "string" ? replacement.to.trim() : "",
    }))
    .filter(({ from, to }) => from && to)
    .filter(({ from }) => {
      const key = from.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function applyDictionaryReplacements(
  text: string,
  replacements: DictionaryReplacement[] | undefined
): string {
  if (!text || !Array.isArray(replacements) || replacements.length === 0) return text;

  return normalizeDictionaryReplacements(replacements).reduce((result, { from, to }) => {
    const pattern = new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi");
    return result.replace(pattern, to);
  }, text);
}
