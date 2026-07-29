/**
 * Unused words for the user-confirmed bulk removal. Empty until some word has
 * recorded usage: with zero signal, "unused" just means "not observed yet".
 *
 * @template {{ word?: string, usage_count?: number }} T
 * @param {T[]} entries
 * @returns {T[]} the unused subset of `entries`
 */
export function selectPruneCandidates(entries) {
  const usable = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e.word === "string" && e.word.trim()
  );
  if (!usable.some((e) => Number(e.usage_count) > 0)) return [];
  return usable.filter((e) => !(Number(e.usage_count) > 0));
}
