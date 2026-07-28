// Startup reconcile for custom dictionary localStorage <-> SQLite (#1295).
//
// SQLite is the durable store. The renderer also caches words in localStorage.
// setDictionary() is a full replace: any SQLite row missing from the incoming
// list is hard-deleted (or tombstoned). If startup treats a stale cache as
// authoritative, newer DB state is overwritten and those words disappear.

/**
 * Decide how to reconcile the renderer cache with SQLite on app launch.
 *
 * Policy (mirrors snippets startup):
 * - Empty DB + non-empty cache → migrate cache into SQLite (legacy / first write).
 * - Non-empty DB → SQLite wins; refresh the cache from the DB.
 * - Both empty → nothing to do.
 *
 * @param {string[]} dbWords words currently in SQLite
 * @param {string[]} localWords words currently in the renderer/localStorage cache
 * @returns {{ action: "push-local-to-db" | "pull-db-to-local" | "noop", words: string[] }}
 */
export function chooseDictionaryStartupAction(dbWords, localWords) {
  const db = Array.isArray(dbWords) ? dbWords : [];
  const local = Array.isArray(localWords) ? localWords : [];

  if (db.length === 0 && local.length > 0) {
    return { action: "push-local-to-db", words: local };
  }

  if (db.length > 0) {
    return { action: "pull-db-to-local", words: db };
  }

  return { action: "noop", words: local };
}
