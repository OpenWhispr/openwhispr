const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const { app } = require("electron");

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Audio retention columns
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN raw_text TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN audio_duration_ms INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN provider TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN model TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE transcriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_message TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled Note',
          content TEXT NOT NULL DEFAULT '',
          note_type TEXT NOT NULL DEFAULT 'personal',
          source_file TEXT,
          audio_duration_seconds REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_content TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhancement_prompt TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_at_content_hash TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title,
          content,
          enhanced_content,
          content='notes',
          content_rowid='id'
        )
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
        END
      `);

      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO notes_fts(rowid, title, content, enhanced_content)
        SELECT id, COALESCE(title, ''), COALESCE(content, ''), COALESCE(enhanced_content, '')
        FROM notes
      `
        )
        .run();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const folderCount = this.db.prepare("SELECT COUNT(*) as count FROM folders").get();
      if (folderCount.count === 0) {
        const seedFolder = this.db.prepare(
          "INSERT INTO folders (name, is_default, sort_order) VALUES (?, 1, ?)"
        );
        seedFolder.run("Personal", 0);
        seedFolder.run("Meetings", 1);
      }

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN folder_id INTEGER REFERENCES folders(id)");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      const personalFolder = this.db
        .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
        .get();
      if (personalFolder) {
        this.db
          .prepare("UPDATE notes SET folder_id = ? WHERE folder_id IS NULL")
          .run(personalFolder.id);
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT 'sparkles',
          is_builtin INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE actions ADD COLUMN translation_key TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id)"
      );

      const actionCount = this.db.prepare("SELECT COUNT(*) as count FROM actions").get();
      if (actionCount.count === 0) {
        this.db
          .prepare(
            "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key) VALUES (?, ?, ?, ?, 1, 0, ?)"
          )
          .run(
            "Clean Up Notes",
            "Fix grammar, structure, and formatting",
            "Clean up grammar, improve structure, and format these notes for readability while preserving all original meaning.",
            "sparkles",
            "notes.actions.builtin.cleanupNotes"
          );
      }

      this.db
        .prepare(
          "UPDATE actions SET translation_key = ? WHERE is_builtin = 1 AND name = ? AND translation_key IS NULL"
        )
        .run("notes.actions.builtin.cleanupNotes", "Clean Up Notes");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS google_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Migration: add UNIQUE constraint to google_email if table already existed without it
      try {
        const tableInfo = this.db.pragma("index_list('google_calendar_tokens')");
        const hasUniqueEmail = tableInfo.some((idx) => {
          if (!idx.unique) return false;
          const cols = this.db.pragma(`index_info('${idx.name}')`);
          return cols.length === 1 && cols[0].name === "google_email";
        });
        if (!hasUniqueEmail) {
          this.db.exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendar_tokens_email ON google_calendar_tokens(google_email)"
          );
        }
      } catch (err) {
        debugLogger.error(
          "Migration: google_email unique index",
          { error: err.message },
          "database"
        );
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS google_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          description TEXT,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          sync_token TEXT,
          account_email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE google_calendars ADD COLUMN account_email TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          calendar_id TEXT NOT NULL,
          summary TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'confirmed',
          hangout_link TEXT,
          conference_data TEXT,
          organizer_email TEXT,
          attendees_count INTEGER DEFAULT 0,
          synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN transcript TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN calendar_event_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS command_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          command_text TEXT NOT NULL,
          original_transcript TEXT,
          duration_ms INTEGER,
          model TEXT,
          provider TEXT,
          status TEXT NOT NULL DEFAULT 'completed',
          error_message TEXT,
          metadata TEXT,
          source TEXT NOT NULL DEFAULT 'dictation',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE command_log ADD COLUMN error_message TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_command_log_timestamp ON command_log(timestamp)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_command_log_status ON command_log(status)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_command_log_provider ON command_log(provider)"
      );

      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: error.message }, "database");
      throw error;
    }
  }

  saveTranscription(text, rawText = null, { status = "completed", errorMessage = null } = {}) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare(
        "INSERT INTO transcriptions (text, raw_text, status, error_message) VALUES (?, ?, ?, ?)"
      );
      const result = stmt.run(text, rawText, status, errorMessage);

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      return { id: result.lastInsertRowid, success: true, transcription };
    } catch (error) {
      debugLogger.error("Error saving transcription", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptions(limit = 50) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM transcriptions ORDER BY timestamp DESC LIMIT ?");
      const transcriptions = stmt.all(limit);
      return transcriptions;
    } catch (error) {
      debugLogger.error("Error getting transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  clearTranscriptions() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions");
      const result = stmt.run();
      return { cleared: result.changes, success: true };
    } catch (error) {
      debugLogger.error("Error clearing transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  deleteTranscription(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions WHERE id = ?");
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting transcription", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionAudio(id, { hasAudio, audioDurationMs, provider, model }) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "UPDATE transcriptions SET has_audio = ?, audio_duration_ms = ?, provider = ?, model = ? WHERE id = ?"
      );
      stmt.run(hasAudio, audioDurationMs, provider, model, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating transcription audio", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionText(id, text, rawText) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("UPDATE transcriptions SET text = ?, raw_text = ? WHERE id = ?");
      stmt.run(text, rawText, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating transcription text", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionStatus(id, status, errorMessage = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "UPDATE transcriptions SET status = ?, error_message = ? WHERE id = ?"
      );
      stmt.run(status, errorMessage, id);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error updating transcription status",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getTranscriptionById(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      return stmt.get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting transcription by id", { error: error.message }, "database");
      throw error;
    }
  }

  clearAudioFlags(ids) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!ids || ids.length === 0) return { success: true };
      const transaction = this.db.transaction((idList) => {
        const stmt = this.db.prepare("UPDATE transcriptions SET has_audio = 0 WHERE id = ?");
        for (const id of idList) {
          stmt.run(id);
        }
      });
      transaction(ids);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing audio flags", { error: error.message }, "database");
      throw error;
    }
  }

  getDictionary() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT word FROM custom_dictionary ORDER BY id ASC");
      const rows = stmt.all();
      return rows.map((row) => row.word);
    } catch (error) {
      debugLogger.error("Error getting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  setDictionary(words) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const transaction = this.db.transaction((wordList) => {
        this.db.prepare("DELETE FROM custom_dictionary").run();
        const insert = this.db.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
        for (const word of wordList) {
          const trimmed = typeof word === "string" ? word.trim() : "";
          if (trimmed) {
            insert.run(trimmed);
          }
        }
      });
      transaction(words);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  saveNote(
    title,
    content,
    noteType = "personal",
    sourceFile = null,
    audioDuration = null,
    folderId = null
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      if (!folderId) {
        const defaultFolderName = noteType === "meeting" ? "Meetings" : "Personal";
        const defaultFolder = this.db
          .prepare("SELECT id FROM folders WHERE name = ? AND is_default = 1")
          .get(defaultFolderName);
        folderId = defaultFolder?.id || null;
      }
      const stmt = this.db.prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(title, content, noteType, sourceFile, audioDuration, folderId);

      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(result.lastInsertRowid);

      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error saving note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      return stmt.get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNotes(noteType = null, limit = 100, folderId = null) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const conditions = [];
      const params = [];
      if (noteType) {
        conditions.push("note_type = ?");
        params.push(noteType);
      }
      if (folderId) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const stmt = this.db.prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC LIMIT ?`);
      params.push(limit);
      return stmt.all(...params);
    } catch (error) {
      debugLogger.error("Error getting notes", { error: error.message }, "notes");
      throw error;
    }
  }

  updateNote(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const allowedFields = [
        "title",
        "content",
        "enhanced_content",
        "enhancement_prompt",
        "enhanced_at_content_hash",
        "folder_id",
        "transcript",
        "calendar_event_id",
      ];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      const stmt = this.db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`);
      stmt.run(...values);
      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(id);
      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error updating note", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolders() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM folders ORDER BY sort_order ASC, created_at ASC").all();
    } catch (error) {
      debugLogger.error("Error getting folders", { error: error.message }, "notes");
      throw error;
    }
  }

  createFolder(name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const existing = this.db.prepare("SELECT id FROM folders WHERE name = ?").get(trimmed);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM folders").get();
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare("INSERT INTO folders (name, sort_order) VALUES (?, ?)")
        .run(trimmed, sortOrder);
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, folder };
    } catch (error) {
      debugLogger.error("Error creating folder", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot delete default folders" };
      const personal = this.db
        .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
        .get();
      if (personal) {
        this.db.prepare("UPDATE notes SET folder_id = ? WHERE folder_id = ?").run(personal.id, id);
      }
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      return { success: true, id };
    } catch (error) {
      debugLogger.error("Error deleting folder", { error: error.message }, "notes");
      throw error;
    }
  }

  renameFolder(id, name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot rename default folders" };
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const existing = this.db
        .prepare("SELECT id FROM folders WHERE name = ? AND id != ?")
        .get(trimmed, id);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      this.db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(trimmed, id);
      const updated = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      return { success: true, folder: updated };
    } catch (error) {
      debugLogger.error("Error renaming folder", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolderNoteCounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT folder_id, COUNT(*) as count FROM notes GROUP BY folder_id")
        .all();
    } catch (error) {
      debugLogger.error("Error getting folder note counts", { error: error.message }, "notes");
      throw error;
    }
  }

  getActions() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions ORDER BY sort_order ASC, created_at ASC").all();
    } catch (error) {
      debugLogger.error("Error getting actions", { error: error.message }, "notes");
      throw error;
    }
  }

  getAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting action", { error: error.message }, "notes");
      throw error;
    }
  }

  createAction(name, description, prompt, icon = "sparkles") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmedName = (name || "").trim();
      const trimmedPrompt = (prompt || "").trim();
      if (!trimmedName) return { success: false, error: "Action name is required" };
      if (!trimmedPrompt) return { success: false, error: "Action prompt is required" };
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM actions").get();
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare(
          "INSERT INTO actions (name, description, prompt, icon, sort_order) VALUES (?, ?, ?, ?, ?)"
        )
        .run(trimmedName, (description || "").trim(), trimmedPrompt, icon || "sparkles", sortOrder);
      const action = this.db
        .prepare("SELECT * FROM actions WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error creating action", { error: error.message }, "notes");
      throw error;
    }
  }

  updateAction(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const allowedFields = ["name", "description", "prompt", "icon", "sort_order"];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      this.db.prepare(`UPDATE actions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error updating action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      if (!action) return { success: false, error: "Action not found" };
      if (action.is_builtin) return { success: false, error: "Cannot delete built-in actions" };
      this.db.prepare("DELETE FROM actions WHERE id = ?").run(id);
      return { success: true, id };
    } catch (error) {
      debugLogger.error("Error deleting action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM notes WHERE id = ?");
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting note", { error: error.message }, "notes");
      throw error;
    }
  }

  createAgentConversation(title = "Untitled") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("INSERT INTO agent_conversations (title) VALUES (?)")
        .run(title);
      return this.db
        .prepare("SELECT * FROM agent_conversations WHERE id = ?")
        .get(result.lastInsertRowid);
    } catch (error) {
      debugLogger.error("Error creating agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  getAgentConversations(limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM agent_conversations ORDER BY updated_at DESC LIMIT ?")
        .all(limit);
    } catch (error) {
      debugLogger.error("Error getting agent conversations", { error: error.message }, "database");
      throw error;
    }
  }

  getAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conversation = this.db
        .prepare("SELECT * FROM agent_conversations WHERE id = ?")
        .get(id);
      if (!conversation) return null;
      const messages = this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(id);
      return { ...conversation, messages };
    } catch (error) {
      debugLogger.error("Error getting agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  deleteAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM agent_messages WHERE conversation_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM agent_conversations WHERE id = ?").run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error deleting agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  updateAgentConversationTitle(id, title) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE agent_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(title, id);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error updating agent conversation title",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  saveGoogleTokens(tokens) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(google_email) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = CURRENT_TIMESTAMP`
      );
      stmt.run(
        tokens.google_email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scope
      );
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM google_calendar_tokens LIMIT 1").get() || null;
    } catch (error) {
      debugLogger.error("Error getting Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleTokensByEmail(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db.prepare("SELECT * FROM google_calendar_tokens WHERE google_email = ?").get(email) ||
        null
      );
    } catch (error) {
      debugLogger.error("Error getting Google tokens by email", { error: error.message }, "gcal");
      throw error;
    }
  }

  addAgentMessage(conversationId, role, content) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("INSERT INTO agent_messages (conversation_id, role, content) VALUES (?, ?, ?)")
        .run(conversationId, role, content);
      this.db
        .prepare("UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(conversationId);
      return this.db
        .prepare("SELECT * FROM agent_messages WHERE id = ?")
        .get(result.lastInsertRowid);
    } catch (error) {
      debugLogger.error("Error adding agent message", { error: error.message }, "database");
      throw error;
    }
  }

  getAllGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM google_calendar_tokens").all();
    } catch (error) {
      debugLogger.error("Error getting all Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleAccounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT google_email AS email FROM google_calendar_tokens ORDER BY created_at ASC")
        .all();
    } catch (error) {
      debugLogger.error("Error getting Google accounts", { error: error.message }, "gcal");
      throw error;
    }
  }

  removeGoogleAccount(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const calendarIds = this.db
          .prepare("SELECT id FROM google_calendars WHERE account_email = ?")
          .all(email)
          .map((c) => c.id);
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => "?").join(", ");
          this.db
            .prepare(`DELETE FROM calendar_events WHERE calendar_id IN (${placeholders})`)
            .run(...calendarIds);
        }
        this.db.prepare("DELETE FROM google_calendars WHERE account_email = ?").run(email);
        this.db.prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?").run(email);
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing Google account", { error: error.message }, "gcal");
      throw error;
    }
  }

  deleteGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM google_calendar_tokens").run();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error deleting Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  saveGoogleCalendars(calendars, accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO google_calendars (id, summary, description, background_color, account_email)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           description = excluded.description,
           background_color = excluded.background_color,
           account_email = excluded.account_email`
      );
      for (const cal of calendars) {
        stmt.run(
          cal.id,
          cal.summary,
          cal.description || null,
          cal.background_color || null,
          accountEmail
        );
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Google calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleCalendars(accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (accountEmail) {
        return this.db
          .prepare("SELECT * FROM google_calendars WHERE account_email = ?")
          .all(accountEmail);
      }
      return this.db.prepare("SELECT * FROM google_calendars").all();
    } catch (error) {
      debugLogger.error("Error getting Google calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateCalendarSelection(calendarId, isSelected) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE google_calendars SET is_selected = ? WHERE id = ?")
        .run(isSelected ? 1 : 0, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating calendar selection", { error: error.message }, "gcal");
      throw error;
    }
  }

  getAgentMessages(conversationId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(conversationId);
    } catch (error) {
      debugLogger.error("Error getting agent messages", { error: error.message }, "database");
      throw error;
    }
  }

  getSelectedCalendars(accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (accountEmail) {
        return this.db
          .prepare("SELECT * FROM google_calendars WHERE is_selected = 1 AND account_email = ?")
          .all(accountEmail);
      }
      return this.db.prepare("SELECT * FROM google_calendars WHERE is_selected = 1").all();
    } catch (error) {
      debugLogger.error("Error getting selected calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  upsertCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((eventList) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO calendar_events (id, calendar_id, summary, start_time, end_time, is_all_day, status, hangout_link, conference_data, organizer_email, attendees_count, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
        );
        for (const e of eventList) {
          stmt.run(
            e.id,
            e.calendar_id,
            e.summary || null,
            e.start_time,
            e.end_time,
            e.is_all_day ? 1 : 0,
            e.status || "confirmed",
            e.hangout_link || null,
            e.conference_data || null,
            e.organizer_email || null,
            e.attendees_count || 0
          );
        }
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting calendar events", { error: error.message }, "gcal");
      throw error;
    }
  }

  getActiveEvents() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM calendar_events WHERE datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status = 'confirmed' ORDER BY start_time ASC"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting active events", { error: error.message }, "gcal");
      throw error;
    }
  }

  searchNotes(query, limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const term = query
        .trim()
        .replace(/[^\w\s]/g, " ")
        .trim();
      if (!term) return [];
      return this.db
        .prepare(
          `
        SELECT n.*
        FROM notes n
        JOIN notes_fts ON notes_fts.rowid = n.id
        WHERE notes_fts MATCH ?
        ORDER BY notes_fts.rank
        LIMIT ?
      `
        )
        .all(term + "*", limit);
    } catch (error) {
      debugLogger.error("Error searching notes", { error: error.message }, "database");
      throw error;
    }
  }

  getUpcomingEvents(windowMinutes = 1440) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM calendar_events WHERE datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes') AND is_all_day = 0 AND status = 'confirmed' ORDER BY start_time ASC"
        )
        .all(windowMinutes);
    } catch (error) {
      debugLogger.error("Error getting upcoming events", { error: error.message }, "gcal");
      throw error;
    }
  }

  clearCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events").run();
        this.db.prepare("DELETE FROM google_calendars").run();
        this.db.prepare("DELETE FROM google_calendar_tokens").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing calendar data", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateCalendarSyncToken(calendarId, syncToken) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE google_calendars SET sync_token = ? WHERE id = ?")
        .run(syncToken, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating sync token", { error: error.message }, "gcal");
      throw error;
    }
  }

  removeCalendarEvents(eventIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const placeholders = eventIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM calendar_events WHERE id IN (${placeholders})`).run(...eventIds);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing calendar events", { error: error.message }, "gcal");
      throw error;
    }
  }

  getMeetingsFolder() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT id FROM folders WHERE name = 'Meetings' AND is_default = 1")
          .get() || null
      );
    } catch (error) {
      debugLogger.error("Error getting meetings folder", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateNoteCloudId(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE notes SET cloud_id = ? WHERE id = ?").run(cloudId, id);
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    } catch (error) {
      debugLogger.error("Error updating note cloud_id", { error: error.message }, "database");
      throw error;
    }
  }

  saveCommandLog(commandText, originalTranscript = null, options = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const {
        durationMs = null,
        model = null,
        provider = null,
        status = "completed",
        errorMessage = null,
        metadata = null,
        source = "dictation",
      } = options;
      const metadataStr = metadata ? JSON.stringify(metadata) : null;
      const stmt = this.db.prepare(
        "INSERT INTO command_log (command_text, original_transcript, duration_ms, model, provider, status, error_message, metadata, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(
        commandText,
        originalTranscript,
        durationMs,
        model,
        provider,
        status,
        errorMessage,
        metadataStr,
        source
      );
      const entry = this.db
        .prepare("SELECT * FROM command_log WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, entry };
    } catch (error) {
      debugLogger.error("Error saving command log", { error: error.message }, "database");
      throw error;
    }
  }

  getCommandHistory({
    limit = 50,
    offset = 0,
    status = null,
    provider = null,
    source = null,
    startDate = null,
    endDate = null,
  } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conditions = [];
      const params = [];
      if (status) {
        conditions.push("status = ?");
        params.push(status);
      }
      if (provider) {
        conditions.push("provider = ?");
        params.push(provider);
      }
      if (source) {
        conditions.push("source = ?");
        params.push(source);
      }
      if (startDate) {
        conditions.push("timestamp >= ?");
        params.push(startDate);
      }
      if (endDate) {
        conditions.push("timestamp <= ?");
        params.push(endDate);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const stmt = this.db.prepare(
        `SELECT * FROM command_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      );
      params.push(limit, offset);
      return stmt.all(...params);
    } catch (error) {
      debugLogger.error("Error getting command history", { error: error.message }, "database");
      throw error;
    }
  }

  searchCommandHistory(query, limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const term = (query || "").trim();
      if (!term) return [];
      const likeTerm = `%${term}%`;
      const stmt = this.db.prepare(
        "SELECT * FROM command_log WHERE command_text LIKE ? OR original_transcript LIKE ? ORDER BY timestamp DESC LIMIT ?"
      );
      return stmt.all(likeTerm, likeTerm, limit);
    } catch (error) {
      debugLogger.error("Error searching command history", { error: error.message }, "database");
      throw error;
    }
  }

  getCommandStats() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const total = this.db
        .prepare("SELECT COUNT(*) as count FROM command_log")
        .get().count;
      const avgDuration = this.db
        .prepare(
          "SELECT AVG(duration_ms) as avg_duration FROM command_log WHERE duration_ms IS NOT NULL"
        )
        .get().avg_duration;
      const byStatus = this.db
        .prepare(
          "SELECT status, COUNT(*) as count FROM command_log GROUP BY status"
        )
        .all();
      const byProvider = this.db
        .prepare(
          "SELECT provider, COUNT(*) as count FROM command_log GROUP BY provider ORDER BY count DESC"
        )
        .all();

      const completed = byStatus.find((s) => s.status === "completed")?.count || 0;
      const failed = byStatus.find((s) => s.status === "failed")?.count || 0;

      // Find the most-used provider (excluding null entries)
      const topProvider = byProvider.find((p) => p.provider != null);
      const mostUsedProvider = topProvider ? topProvider.provider : null;

      return {
        total,
        completed,
        failed,
        avgDurationMs: avgDuration !== null && avgDuration !== undefined ? Math.round(avgDuration) : null,
        mostUsedProvider,
      };
    } catch (error) {
      debugLogger.error("Error getting command stats", { error: error.message }, "database");
      throw error;
    }
  }

  deleteCommandLog(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("DELETE FROM command_log WHERE id = ?");
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting command log", { error: error.message }, "database");
      throw error;
    }
  }

  clearCommandHistory() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("DELETE FROM command_log");
      const result = stmt.run();
      return { cleared: result.changes, success: true };
    } catch (error) {
      debugLogger.error("Error clearing command history", { error: error.message }, "database");
      throw error;
    }
  }

  exportCommandHistory({ startDate = null, endDate = null } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conditions = [];
      const params = [];
      if (startDate) {
        conditions.push("timestamp >= ?");
        params.push(startDate);
      }
      if (endDate) {
        conditions.push("timestamp <= ?");
        params.push(endDate);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const stmt = this.db.prepare(
        `SELECT * FROM command_log ${where} ORDER BY timestamp DESC`
      );
      const entries = stmt.all(...params);
      return { success: true, data: entries };
    } catch (error) {
      debugLogger.error("Error exporting command history", { error: error.message }, "database");
      throw error;
    }
  }

  cleanup() {
    try {
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch (error) {
      debugLogger.error("Error deleting database file", { error: error.message }, "database");
    }
  }
}

module.exports = DatabaseManager;
