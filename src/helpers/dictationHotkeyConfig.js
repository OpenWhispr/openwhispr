// The dictation hotkey rows and their per-row text-cleanup mode, as one
// ordered list. Pure and Electron-free: the renderer imports it directly and
// main loads it through require(esm), the same way providerHttpErrors.js is
// shared.
//
// A row is `{ key, mode }`. `key` keeps the user's ORIGINAL spelling —
// canonicalization is platform-dependent (CommandOrControl resolves to Command
// on macOS and Control elsewhere), so storing a canonical form would bake the
// authoring platform into the profile and a macOS-written profile would lose
// its modes on Windows. Canonical form is therefore only ever used to compare,
// and every entry point that needs it takes a `canonicalize` function so this
// module keeps no opinion about which process it runs in.
//
// `mode` is the pipeline's own vocabulary — "raw" skips cleanup, "cleaned"
// forces it, null follows the app setting — so resolveCleanupSelection takes
// these values unchanged. The UI's Always off / Always on / Use app setting is
// a display mapping over the same three values.

/** The only two overrides. Anything else means "follow the app setting". */
export const CLEANUP_MODE = Object.freeze({ RAW: "raw", CLEANED: "cleaned" });

// Anything unrecognized becomes null rather than reaching the pipeline, where
// an unknown string would silently fall through to the global preference.
export function normalizeMode(value) {
  return value === CLEANUP_MODE.RAW || value === CLEANUP_MODE.CLEANED ? value : null;
}

function normalizeRow(entry) {
  if (!entry) return null;
  const key = typeof entry === "string" ? entry : entry.key;
  if (typeof key !== "string" || !key.trim()) return null;
  return { key: key.trim(), mode: typeof entry === "string" ? null : normalizeMode(entry.mode) };
}

/**
 * Drops blank rows and rows whose key is the same chord as an earlier one.
 * De-duplication is canonical, not textual: `Ctrl+Shift+Space` and
 * `Control+Shift+Space` are one chord, and leaving both would give two rows
 * that cannot both register and whose modes would fight over one key.
 */
export function pruneRows(rows, canonicalize) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    const row = normalizeRow(entry);
    if (!row) continue;
    const identity = canonicalize ? canonicalize(row.key) : row.key;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(row);
  }
  return out;
}

/** Rows a stored config string describes, or [] when it is absent or malformed. */
export function parseConfig(raw, canonicalize) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A hand-edited or truncated value must not take the app down with it.
    return [];
  }
  return pruneRows(parsed, canonicalize);
}

export function serializeConfig(rows) {
  return JSON.stringify(rows.map(({ key, mode }) => ({ key, mode: normalizeMode(mode) })));
}

/**
 * Rows for a profile written before per-row modes existed. Every one follows
 * the app setting: an ordinary saved list must never be pinned to whatever the
 * global preference happens to be today.
 */
export function rowsFromHotkeyList(hotkeys, canonicalize) {
  return pruneRows(
    (Array.isArray(hotkeys) ? hotkeys : []).map((key) => ({ key, mode: null })),
    canonicalize
  );
}

/** The keys alone, for the derived flat list legacy readers still use. */
export function rowKeys(rows) {
  return rows.map((row) => row.key);
}

/**
 * The mode for whichever row owns `key`, compared canonically so a row stored
 * as `Ctrl+…` is still found when the backend reports `Control+…`. An unknown
 * key follows the app setting, which is the conservative answer.
 */
export function modeFor(rows, key, canonicalize) {
  if (typeof key !== "string" || !key) return null;
  const wanted = canonicalize ? canonicalize(key) : key;
  for (const row of rows) {
    if ((canonicalize ? canonicalize(row.key) : row.key) === wanted) return normalizeMode(row.mode);
  }
  return null;
}

export function findRowIndex(rows, key, canonicalize) {
  if (typeof key !== "string" || !key) return -1;
  const wanted = canonicalize ? canonicalize(key) : key;
  return rows.findIndex((row) => (canonicalize ? canonicalize(row.key) : row.key) === wanted);
}

/**
 * Replaces one row's key, carrying its mode with it. The row object is the
 * identity, so a rename cannot leave its override behind on a neighbour and a
 * removal cannot hand one to the row that takes its place.
 */
export function renameRow(rows, index, nextKey) {
  if (index < 0 || index >= rows.length) return rows;
  const key = typeof nextKey === "string" ? nextKey.trim() : "";
  if (!key) return rows;
  return rows.map((row, i) => (i === index ? { key, mode: row.mode } : row));
}

export function setRowMode(rows, index, mode) {
  if (index < 0 || index >= rows.length) return rows;
  return rows.map((row, i) => (i === index ? { key: row.key, mode: normalizeMode(mode) } : row));
}

export function removeRow(rows, index) {
  return rows.filter((_, i) => i !== index);
}

/** True when only modes differ, so the commit needs no re-registration. */
export function isModeOnlyChange(previous, next, canonicalize) {
  if (previous.length !== next.length) return false;
  return previous.every((row, i) => {
    const a = canonicalize ? canonicalize(row.key) : row.key;
    const b = canonicalize ? canonicalize(next[i].key) : next[i].key;
    return a === b;
  });
}
