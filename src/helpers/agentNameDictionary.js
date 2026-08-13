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
  const trimmedNew = typeof newName === "string" ? newName.trim() : "";
  const trimmedOld = typeof oldName === "string" ? oldName.trim() : "";

  return {
    add: trimmedNew && !words.includes(trimmedNew) ? [trimmedNew] : [],
    remove:
      trimmedOld && trimmedOld !== trimmedNew && words.includes(trimmedOld) ? [trimmedOld] : [],
  };
}
