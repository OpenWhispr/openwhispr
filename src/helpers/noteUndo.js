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

function initializeNoteUndo(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_note_undo (
      note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      account_id TEXT,
      previous TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS assistant_note_undo_update AFTER UPDATE ON notes
    WHEN ${GUARDED_FIELDS.filter((field) => field !== "owner_user_id")
      .map((field) => `OLD.${field} IS NOT NEW.${field}`)
      .join(" OR ")}
      OR (OLD.owner_user_id IS NOT NULL AND OLD.owner_user_id IS NOT NEW.owner_user_id)
    BEGIN DELETE FROM assistant_note_undo WHERE note_id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS assistant_note_undo_delete AFTER DELETE ON notes
    BEGIN DELETE FROM assistant_note_undo WHERE note_id = OLD.id; END;
  `);
}

function updateNoteWithUndo(manager, id, updates, expected) {
  return manager.db.transaction(() => {
    const before = manager.getNote(id);
    if (!before || before.deleted_at) return { success: false, error: "Note not found" };
    if (
      !expected ||
      GUARDED_FIELDS.some((key) => (before[key] ?? null) !== (expected[key] ?? null))
    ) {
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
    if (!Object.keys(previous).length && !updates.clear_fields?.length)
      return { success: true, note: before };
    const result = manager.updateNote(id, updates);
    if (!result.success) return result;
    // A deliberate summary clear may also reset its generation metadata.
    for (const key of [
      "enhancement_prompt",
      "enhancement_template_id",
      "enhanced_at_content_hash",
    ]) {
      if (before[key] !== result.note[key]) previous[key] = before[key];
    }
    if (!Object.keys(previous).length) return result;
    manager.db
      .prepare(
        "INSERT OR REPLACE INTO assistant_note_undo (note_id, token, account_id, previous) VALUES (?, ?, ?, ?)"
      )
      .run(id, randomUUID(), manager.activeAccountId, JSON.stringify(previous));
    return result;
  })();
}

function getNoteUndos(manager) {
  const scope = manager._accountScopeCondition("notes");
  return manager.db
    .prepare(
      `
    SELECT u.token, notes.id AS noteId, notes.title
    FROM assistant_note_undo u JOIN notes ON notes.id = u.note_id
    WHERE notes.deleted_at IS NULL AND u.account_id IS ? AND ${scope.sql}
  `
    )
    .all(manager.activeAccountId, ...scope.params);
}

function undoNoteUpdate(manager, token) {
  return manager.db.transaction(() => {
    const saved = manager.db
      .prepare("SELECT * FROM assistant_note_undo WHERE token = ?")
      .get(token);
    const note =
      saved && saved.account_id === manager.activeAccountId && manager.getNote(saved.note_id);
    if (!note || note.deleted_at) return { success: false, error: "note_changed" };
    const previous = JSON.parse(saved.previous);
    if (previous.folder_id != null) {
      const folder = manager._getFolderInAccountScope(previous.folder_id);
      if (!folder || folder.deleted_at || folder.space_id !== note.space_id) {
        return { success: false, error: "note_changed" };
      }
    }
    const clearFields = ["content", "enhanced_content"].filter(
      (key) => key in previous && (previous[key] == null || previous[key] === "")
    );
    const result = manager.updateNote(note.id, {
      ...previous,
      ...(clearFields.length && { clear_fields: clearFields }),
    });
    if (result.success)
      manager.db.prepare("DELETE FROM assistant_note_undo WHERE token = ?").run(token);
    return result;
  })();
}

function discardNoteUndo(manager, id, token) {
  if (!manager.getNote(id)) return;
  // A toast may expire after a newer edit; only that toast's token is retired.
  if (token)
    manager.db
      .prepare(
        "DELETE FROM assistant_note_undo WHERE note_id = ? AND token = ? AND account_id IS ?"
      )
      .run(id, token, manager.activeAccountId);
  else manager.db.prepare("DELETE FROM assistant_note_undo WHERE note_id = ?").run(id);
}

module.exports = {
  initializeNoteUndo,
  updateNoteWithUndo,
  getNoteUndos,
  undoNoteUpdate,
  discardNoteUndo,
};
