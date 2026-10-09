const { randomUUID } = require("crypto");

// Sync acknowledgements are not edits. All semantic changes (including SQL
// writers outside updateNote) retire the previous assistant's recovery token.
const GUARDED_FIELDS = [
  "title",
  "content",
  "enhanced_content",
  "enhancement_prompt",
  "enhancement_template_id",
  "enhanced_at_content_hash",
  "folder_id",
  "space_id",
  "transcript",
  "participants",
  "calendar_event_id",
  "deleted_at",
  "client_note_id",
  "account_id",
  "owner_user_id",
  "note_type",
  "created_at",
];
const EDITABLE_FIELDS = ["title", "content", "enhanced_content", "folder_id"];
// A cloud pull stores an empty field as NULL, so here and in the trigger ''
// and NULL are equal: the echo of a cleared summary is not a later edit.
const sameValue = (a, b) => (a ?? "") === (b ?? "");
// Outlives a cancelled turn, a renderer reload and an unfocused panel, but an
// edit is never offered again at a later launch.
const UNDO_TTL_MS = 10 * 60 * 1000;
// Every window lists live recoveries, but only the first focused one offers
// each as a toast, so an edit is not offered again in another window.
const offeredTokens = new Set();
// The chat turn (assistant message) that made each recovery.
const undoTurns = new Map();
const JOURNAL_COLUMNS = ["note_id", "token", "account_id", "previous", "created_at"];

function initializeNoteUndo(db) {
  // Recoveries are short-lived, so a journal of another shape (an earlier
  // build's) is dropped rather than migrated.
  const columns = db
    .prepare("PRAGMA table_info(assistant_note_undo)")
    .all()
    .map((column) => column.name);
  if (columns.length && columns.join() !== JOURNAL_COLUMNS.join()) {
    db.exec("DROP TABLE assistant_note_undo");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_note_undo (
      note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      account_id TEXT,
      previous TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    DROP TRIGGER IF EXISTS assistant_note_undo_update;
    CREATE TRIGGER assistant_note_undo_update AFTER UPDATE ON notes
    WHEN ${GUARDED_FIELDS.filter((field) => field !== "owner_user_id")
      .map((field) => `IFNULL(OLD.${field}, '') IS NOT IFNULL(NEW.${field}, '')`)
      .join(" OR ")}
      OR (OLD.owner_user_id IS NOT NULL AND OLD.owner_user_id IS NOT NEW.owner_user_id)
    BEGIN DELETE FROM assistant_note_undo WHERE note_id = NEW.id; END;
    DROP TRIGGER IF EXISTS assistant_note_undo_delete;
    CREATE TRIGGER assistant_note_undo_delete AFTER DELETE ON notes
    BEGIN DELETE FROM assistant_note_undo WHERE note_id = OLD.id; END;
  `);
  db.prepare("DELETE FROM assistant_note_undo WHERE created_at < ?").run(Date.now() - UNDO_TTL_MS);
}

function updateNoteWithUndo(manager, id, updates, expected, turn) {
  return manager.db.transaction(() => {
    const before = manager.getNote(id);
    if (!before || before.deleted_at) return { success: false, error: "Note not found" };
    if (!expected || GUARDED_FIELDS.some((key) => !sameValue(before[key], expected[key]))) {
      return { success: false, error: "Note changed. Read it again before editing." };
    }
    if (
      Object.keys(updates).some((key) => key !== "clear_fields" && !EDITABLE_FIELDS.includes(key))
    ) {
      return { success: false, error: "Unsupported assistant note field" };
    }
    if (updates.folder_id != null) {
      const folder = manager._getFolderInAccountScope(updates.folder_id);
      if (!folder || folder.deleted_at || folder.space_id !== before.space_id) {
        return { success: false, error: "Folder is no longer available in this space" };
      }
    }
    const previous = Object.fromEntries(
      Object.keys(updates)
        .filter((key) => key !== "clear_fields")
        .filter((key) => before[key] !== updates[key])
        .map((key) => [key, before[key]])
    );
    if (!Object.keys(previous).length) return { success: true, note: before };
    // Read before the write: the update trigger retires the live recovery.
    const live = liveUndo(manager, "note_id", id);
    const result = manager.updateNote(id, updates);
    if (!result.success) return result;
    // A summary clear also resets its prompt and hash; Undo restores them too.
    for (const key of ["enhancement_prompt", "enhanced_at_content_hash"]) {
      if (!(key in previous) && before[key] !== result.note[key]) previous[key] = before[key];
    }
    // Edits of one note in the same turn (e.g. a summary rewrite and a rename)
    // share one Undo that restores each field's oldest value.
    const sameTurn = turn != null && live && undoTurns.get(live.token) === turn;
    const merged = { ...previous, ...(sameTurn && JSON.parse(live.previous)) };
    if (live) undoTurns.delete(live.token);
    const token = randomUUID();
    manager.db
      .prepare(
        "INSERT OR REPLACE INTO assistant_note_undo (note_id, token, account_id, previous, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, token, manager.activeAccountId, JSON.stringify(merged), Date.now());
    if (turn != null) undoTurns.set(token, turn);
    return result;
  })();
}

// A recovery is usable only by the account that made it, within its TTL.
function liveUndo(manager, column, value) {
  return manager.db
    .prepare(
      `SELECT * FROM assistant_note_undo WHERE ${column} = ? AND account_id IS ? AND created_at >= ?`
    )
    .get(value, manager.activeAccountId, Date.now() - UNDO_TTL_MS);
}

function getNoteUndos(manager) {
  const scope = manager._accountScopeCondition("notes");
  return manager.db
    .prepare(
      `
    SELECT u.token, notes.id AS noteId, notes.title
    FROM assistant_note_undo u JOIN notes ON notes.id = u.note_id
    WHERE notes.deleted_at IS NULL AND u.account_id IS ? AND u.created_at >= ? AND ${scope.sql}
  `
    )
    .all(manager.activeAccountId, Date.now() - UNDO_TTL_MS, ...scope.params);
}

function undoNoteUpdate(manager, token) {
  return manager.db.transaction(() => {
    const saved = liveUndo(manager, "token", token);
    const note = saved && manager.getNote(saved.note_id);
    if (!note || note.deleted_at) return { success: false, error: "note_changed" };
    const previous = JSON.parse(saved.previous);
    if (previous.folder_id != null) {
      const folder = manager._getFolderInAccountScope(previous.folder_id);
      if (!folder || folder.deleted_at || folder.space_id !== note.space_id) {
        return { success: false, error: "note_changed" };
      }
    }
    // Restoring an empty field is a deliberate clear, so it syncs; a bare blank
    // would stay on this device while the edit came back from the cloud.
    const clearFields = ["content", "enhanced_content"].filter(
      (key) => key in previous && !previous[key]?.trim()
    );
    const result = manager.updateNote(note.id, {
      ...previous,
      ...(clearFields.length > 0 && { clear_fields: clearFields }),
    });
    if (result.success)
      manager.db.prepare("DELETE FROM assistant_note_undo WHERE token = ?").run(token);
    return result;
  })();
}

function claimNoteUndo(manager, token) {
  if (offeredTokens.has(token) || !liveUndo(manager, "token", token)) return false;
  offeredTokens.add(token);
  return true;
}

// Runs on every keystroke in the note editor, so it is a single statement.
function discardNoteUndo(manager, id, token) {
  const scope = manager._accountScopeCondition("notes");
  // A toast may expire after a newer edit; only that toast's token is retired.
  const byToken = token ? " AND token = ? AND account_id IS ?" : "";
  manager.db
    .prepare(
      `DELETE FROM assistant_note_undo WHERE note_id = ?
        AND note_id IN (SELECT id FROM notes WHERE ${scope.sql})${byToken}`
    )
    .run(id, ...scope.params, ...(token ? [token, manager.activeAccountId] : []));
}

module.exports = {
  UNDO_TTL_MS,
  initializeNoteUndo,
  updateNoteWithUndo,
  getNoteUndos,
  claimNoteUndo,
  undoNoteUpdate,
  discardNoteUndo,
};
