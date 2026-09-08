function findStoredWord(words, word) {
  const needle = word.toLowerCase();
  return words.find((w) => typeof w === "string" && w.trim().toLowerCase() === needle);
}

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
  const storedNew = trimmedNew ? findStoredWord(words, trimmedNew) : undefined;
  const storedOld = trimmedOld ? findStoredWord(words, trimmedOld) : undefined;

  return {
    add: trimmedNew && !storedNew ? [trimmedNew] : [],
    remove:
      storedOld && storedOld.trim().toLowerCase() !== trimmedNew.toLowerCase() ? [storedOld] : [],
  };
}
