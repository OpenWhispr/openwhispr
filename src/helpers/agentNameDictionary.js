function findStoredWord(words, word) {
  if (typeof word !== "string" || !Array.isArray(words)) return undefined;
  const needle = word.trim().toLowerCase();
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
 * @param {Iterable<string>|string[]} dictionary current dictionary snapshot
 * @param {string} newName
 * @param {string} [oldName]
 * @returns {{ add: string[], remove: string[] }}
 */
export function agentNameDictionaryChanges(dictionary, newName, oldName) {
  const words = Array.isArray(dictionary)
    ? dictionary
    : dictionary && typeof dictionary[Symbol.iterator] === "function" && typeof dictionary !== "string"
      ? Array.from(dictionary)
      : [];
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
