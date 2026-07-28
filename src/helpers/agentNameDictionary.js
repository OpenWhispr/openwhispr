/**
 * Drop a renamed-away agent name, move the current one to the front.
 *
 * `changed` is false when the snapshot already reflects the name; callers must
 * skip the write then, since setCustomDictionary replaces the whole SQLite
 * table and a stale snapshot would delete everything it omitted (#1295).
 *
 * @param {string[]} dictionary
 * @param {string} newName
 * @param {string} [oldName]
 * @returns {{ changed: boolean, dictionary: string[] }}
 */
export function applyAgentNameToDictionary(dictionary, newName, oldName) {
  let words = Array.isArray(dictionary) ? [...dictionary] : [];
  let changed = false;

  if (oldName && oldName !== newName) {
    const kept = words.filter((w) => w !== oldName);
    if (kept.length !== words.length) {
      words = kept;
      changed = true;
    }
  }

  const trimmed = newName.trim();
  if (trimmed && !words.includes(trimmed)) {
    words = [trimmed, ...words];
    changed = true;
  }

  return { changed, dictionary: words };
}
