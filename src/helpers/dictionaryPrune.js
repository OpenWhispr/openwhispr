/**
 * Words eligible for the user-confirmed "remove unused" bulk action.
 *
 * Returns [] until at least one word has a recorded use: with zero usage
 * signal, "unused" is indistinguishable from "not observed yet" (fresh
 * install, or a dictionary that predates usage tracking), and offering a
 * full-dictionary purge there would be data loss dressed as cleanup.
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
