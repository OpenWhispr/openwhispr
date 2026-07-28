/**
 * Work out which dictionary changes an agent name requires: drop a
 * renamed-away name, add the current one.
 *
 * Returns a delta, not a whole list. A whole-list write replaces the SQLite
 * table, so a caller holding a stale snapshot deletes everything it omitted
 * (#1295); a delta can only touch the words it names.
 *
 * @param {string[]} dictionary current dictionary snapshot
 * @param {string} newName
 * @param {string} [oldName]
 * @returns {{ add: string[], remove: string[] }}
 */
export function agentNameDictionaryChanges(dictionary, newName, oldName) {
  const words = Array.isArray(dictionary) ? dictionary : [];
  const trimmed = newName.trim();

  return {
    add: trimmed && !words.includes(trimmed) ? [trimmed] : [],
    remove: oldName && oldName !== newName && words.includes(oldName) ? [oldName] : [],
  };
}
