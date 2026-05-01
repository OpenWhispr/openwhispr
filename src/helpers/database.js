const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
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
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_code TEXT");
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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

      try {
        this.db.exec("ALTER TABLE agent_messages ADD COLUMN metadata TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN archived_at DATETIME");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN note_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_note ON agent_conversations(note_id)"
      );

      const actionCount = this.db.prepare("SELECT COUNT(*) as count FROM actions").get();
      if (actionCount.count === 0) {
        this.db
          .prepare(
            "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key) VALUES (?, ?, ?, ?, 1, 0, ?)"
          )
          .run(
            "Generate Notes",
            "Clean up, structure, and enhance your notes",
            "Transform the provided content into clean, well-structured notes in markdown. Preserve the user's intent and all substantive information. Remove filler, small talk, false starts, and redundant content. For personal notes, improve grammar and structure for readability. For meeting transcripts, extract key discussion points, decisions, action items, and follow-ups.",
            "sparkles",
            "notes.actions.builtin.generateNotes"
          );
      }

      // Migrate built-in action to "Generate Notes"
      this.db
        .prepare(
          "UPDATE actions SET name = ?, description = ?, prompt = ?, translation_key = ? WHERE is_builtin = 1 AND translation_key != ?"
        )
        .run(
          "Generate Notes",
          "Clean up, structure, and enhance your notes",
          "Transform the provided content into clean, well-structured notes in markdown. Preserve the user's intent and all substantive information. Remove filler, small talk, false starts, and redundant content. For personal notes, improve grammar and structure for readability. For meeting transcripts, extract key discussion points, decisions, action items, and follow-ups.",
          "notes.actions.builtin.generateNotes",
          "notes.actions.builtin.generateNotes"
        );

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

      try {
        this.db.exec("ALTER TABLE calendar_events ADD COLUMN attendees TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN participants TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          email TEXT PRIMARY KEY,
          display_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          email TEXT,
          embedding BLOB NOT NULL,
          sample_count INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_mappings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          profile_id INTEGER,
          display_name TEXT NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
          FOREIGN KEY (profile_id) REFERENCES speaker_profiles(id) ON DELETE SET NULL
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_speaker_embeddings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
      `);

      // Sync columns for notes
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN client_note_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for folders
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN client_folder_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN updated_at DATETIME");
        this.db.exec("UPDATE folders SET updated_at = created_at WHERE updated_at IS NULL");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for agent_conversations
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN client_conversation_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE agent_conversations ADD COLUMN sync_status TEXT DEFAULT 'pending'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for transcriptions
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN client_transcription_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Backfill client IDs for existing rows
      const syncTables = [
        { table: "notes", col: "client_note_id" },
        { table: "folders", col: "client_folder_id" },
        { table: "agent_conversations", col: "client_conversation_id" },
        { table: "transcriptions", col: "client_transcription_id" },
      ];
      for (const { table, col } of syncTables) {
        const rows = this.db.prepare(`SELECT id FROM ${table} WHERE ${col} IS NULL`).all();
        const stmt = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
        for (const row of rows) {
          stmt.run(randomUUID(), row.id);
        }
      }

      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_client_note_id ON notes(client_note_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_client_id ON agent_conversations(client_conversation_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_transcriptions_client_id ON transcriptions(client_transcription_id)"
      );

      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: error.message }, "database");
      throw error;
    }
  }

  saveTranscription(
    text,
    rawText = null,
    {
      status = "completed",
      errorMessage = null,
      errorCode = null,
      clientTranscriptionId = null,
    } = {}
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const txId = clientTranscriptionId || randomUUID();
      const stmt = this.db.prepare(
        "INSERT INTO transcriptions (text, raw_text, status, error_message, error_code, client_transcription_id) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(text, rawText, status, errorMessage, errorCode, txId);

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
      const stmt = this.db.prepare(
        "SELECT * FROM transcriptions WHERE deleted_at IS NULL ORDER BY timestamp DESC LIMIT ?"
      );
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
      const tombstone = this.db.prepare(
        "UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending' WHERE cloud_id IS NOT NULL AND deleted_at IS NULL"
      );
      const hardDelete = this.db.prepare("DELETE FROM transcriptions WHERE cloud_id IS NULL");
      const clearAll = this.db.transaction(
        () => tombstone.run().changes + hardDelete.run().changes
      );
      return { cleared: clearAll(), success: true };
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
      const row = this.db
        .prepare("SELECT cloud_id, deleted_at FROM transcriptions WHERE id = ?")
        .get(id);
      if (!row || row.deleted_at) return { success: false, id };
      const stmt = row.cloud_id
        ? this.db.prepare(
            "UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND deleted_at IS NULL"
          )
        : this.db.prepare("DELETE FROM transcriptions WHERE id = ?");
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

  updateTranscriptionStatus(id, status, errorMessage = null, errorCode = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "UPDATE transcriptions SET status = ?, error_message = ?, error_code = ? WHERE id = ?"
      );
      stmt.run(status, errorMessage, errorCode, id);
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
      const clientNoteId = randomUUID();
      const stmt = this.db.prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id, client_note_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(
        title,
        content,
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        clientNoteId
      );

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
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      if (noteType) {
        conditions.push("note_type = ?");
        params.push(noteType);
      }
      if (folderId) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      }
      const where = `WHERE ${conditions.join(" AND ")}`;
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
        "participants",
        "sync_status",
        "deleted_at",
        "client_note_id",
        "cloud_id",
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
      return this.db
        .prepare(
          "SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC"
        )
        .all();
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
      const clientFolderId = randomUUID();
      const result = this.db
        .prepare("INSERT INTO folders (name, sort_order, client_folder_id) VALUES (?, ?, ?)")
        .run(trimmed, sortOrder, clientFolderId);
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
      const noteIds = this.db
        .prepare("SELECT id FROM notes WHERE folder_id = ?")
        .all(id)
        .map((row) => row.id);
      // Server cascades note deletes on folder delete; sync pull picks up note tombstones.
      const hardDeleteNotes = this.db.prepare("DELETE FROM notes WHERE folder_id = ?");
      const tombstoneFolder = this.db.prepare(
        "UPDATE folders SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = 'pending', name = '__deleted_' || id || '_' || name WHERE id = ?"
      );
      const hardDeleteFolder = this.db.prepare("DELETE FROM folders WHERE id = ?");
      this.db.transaction(() => {
        hardDeleteNotes.run(id);
        if (folder.cloud_id) tombstoneFolder.run(id);
        else hardDeleteFolder.run(id);
      })();
      return { success: true, id, noteIds };
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
      this.db
        .prepare(
          "UPDATE folders SET name = ?, sync_status = 'pending', updated_at = datetime('now') WHERE id = ?"
        )
        .run(trimmed, id);
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
        .prepare(
          "SELECT folder_id, COUNT(*) as count FROM notes WHERE deleted_at IS NULL GROUP BY folder_id"
        )
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
      const stmt = this.db.prepare(
        "UPDATE notes SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
      );
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting note", { error: error.message }, "notes");
      throw error;
    }
  }

  createAgentConversation(title = "Untitled", noteId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const clientConversationId = randomUUID();
      const result = this.db
        .prepare(
          "INSERT INTO agent_conversations (title, note_id, client_conversation_id) VALUES (?, ?, ?)"
        )
        .run(title, noteId, clientConversationId);
      return this.db
        .prepare("SELECT * FROM agent_conversations WHERE id = ?")
        .get(result.lastInsertRowid);
    } catch (error) {
      debugLogger.error("Error creating agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  getConversationsForNote(noteId, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          WHERE c.note_id = ?
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(noteId, limit);
    } catch (error) {
      debugLogger.error(
        "Error getting conversations for note",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getAgentConversations(limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM agent_conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?"
        )
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
      const result = this.db
        .prepare(
          "UPDATE agent_conversations SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now') WHERE id = ?"
        )
        .run(id);
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

  addAgentMessage(conversationId, role, content, metadata) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const metadataStr = metadata ? JSON.stringify(metadata) : null;
      const result = this.db
        .prepare(
          "INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)"
        )
        .run(conversationId, role, content, metadataStr);
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
          "INSERT OR REPLACE INTO calendar_events (id, calendar_id, summary, start_time, end_time, is_all_day, status, hangout_link, conference_data, organizer_email, attendees_count, attendees, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
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
            e.attendees_count || 0,
            e.attendees || null
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
        WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
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
          "SELECT * FROM calendar_events WHERE ((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0 AND status = 'confirmed' ORDER BY start_time ASC"
        )
        .all(windowMinutes);
    } catch (error) {
      debugLogger.error("Error getting upcoming events", { error: error.message }, "gcal");
      throw error;
    }
  }

  getCalendarEventById(eventId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(eventId) || null;
    } catch (error) {
      debugLogger.error("Error getting calendar event by id", { error: error.message }, "gcal");
      return null;
    }
  }

  getNoteByCalendarEventId(eventId, excludeNoteId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const base = "SELECT * FROM notes WHERE calendar_event_id = ? AND deleted_at IS NULL";
      if (excludeNoteId) {
        return this.db.prepare(`${base} AND id != ? LIMIT 1`).get(eventId, excludeNoteId) || null;
      }
      return this.db.prepare(`${base} LIMIT 1`).get(eventId) || null;
    } catch (error) {
      debugLogger.error(
        "Error getting note by calendar event id",
        { error: error.message },
        "notes"
      );
      return null;
    }
  }

  upsertContacts(contacts) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        const stmt = this.db.prepare(
          "INSERT INTO contacts (email, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"
        );
        for (const c of list) {
          if (c.email) stmt.run(c.email.toLowerCase().trim(), c.displayName || null);
        }
      });
      transaction(contacts);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting contacts", { error: error.message }, "database");
      throw error;
    }
  }

  searchContacts(query) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query || ""}%`;
      return this.db
        .prepare(
          "SELECT * FROM contacts WHERE email LIKE ? OR display_name LIKE ? ORDER BY display_name ASC, email ASC LIMIT 20"
        )
        .all(pattern, pattern);
    } catch (error) {
      debugLogger.error("Error searching contacts", { error: error.message }, "database");
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

  cleanup() {
    try {
      if (this.db) {
        try {
          this.db.close();
        } catch (closeError) {
          debugLogger.error("Error closing database", { error: closeError.message }, "database");
        }
        this.db = null;
      }
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
  getAgentConversationsWithPreview(limit = 50, offset = 0, includeArchived = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const archiveFilter = includeArchived
        ? "WHERE c.archived_at IS NOT NULL AND c.deleted_at IS NULL"
        : "WHERE c.archived_at IS NULL AND c.deleted_at IS NULL";
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at, c.archived_at, c.cloud_id,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          ${archiveFilter}
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ? OFFSET ?`
        )
        .all(limit, offset);
    } catch (error) {
      debugLogger.error(
        "Error getting agent conversations with preview",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  searchAgentConversations(query, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query}%`;
      return this.db
        .prepare(
          `SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.archived_at, c.cloud_id,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          LEFT JOIN agent_messages ms ON ms.conversation_id = c.id
          WHERE c.archived_at IS NULL AND c.deleted_at IS NULL
            AND (c.title LIKE ? OR ms.content LIKE ?)
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(pattern, pattern, limit);
    } catch (error) {
      debugLogger.error(
        "Error searching agent conversations",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  archiveAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE agent_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error archiving agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  unarchiveAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE agent_conversations SET archived_at = NULL WHERE id = ?").run(id);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error unarchiving agent conversation",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  updateAgentConversationCloudId(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE agent_conversations SET cloud_id = ? WHERE id = ?").run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error updating agent conversation cloud_id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  _normalizeEmail(email) {
    const trimmed = (email || "").trim().toLowerCase();
    return trimmed || null;
  }

  _findProfileByEmail(email) {
    const normalized = this._normalizeEmail(email);
    if (!normalized) return null;
    return this.db.prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ?").get(normalized);
  }

  upsertSpeakerProfile(name, email, embeddingBuffer, profileId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      let existing = profileId
        ? this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId)
        : null;
      if (!existing && normalizedEmail) {
        existing = this._findProfileByEmail(normalizedEmail);
      }
      if (!existing) {
        existing = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE display_name = ?")
          .get(name);
      }
      if (existing) {
        const stored = new Float32Array(
          existing.embedding.buffer,
          existing.embedding.byteOffset,
          existing.embedding.byteLength / 4
        );
        const incoming = new Float32Array(
          embeddingBuffer.buffer,
          embeddingBuffer.byteOffset,
          embeddingBuffer.byteLength / 4
        );
        const updated = new Float32Array(stored.length);
        for (let i = 0; i < stored.length; i++) {
          updated[i] = 0.3 * incoming[i] + 0.7 * stored[i];
        }
        const updatedBuf = Buffer.from(updated.buffer);
        const finalEmail = normalizedEmail || existing.email || null;
        this.db
          .prepare(
            "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = sample_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(name, finalEmail, updatedBuf, existing.id);
        const resolved = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
          .get(existing.id);
        if (normalizedEmail) {
          const collision = this.db
            .prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ? AND id != ?")
            .get(normalizedEmail, existing.id);
          if (collision) {
            return this.mergeSpeakerProfiles(resolved, collision);
          }
        }
        return resolved;
      }
      const result = this.db
        .prepare("INSERT INTO speaker_profiles (display_name, email, embedding) VALUES (?, ?, ?)")
        .run(name, normalizedEmail, embeddingBuffer);
      return this.db
        .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
        .get(result.lastInsertRowid);
    } catch (error) {
      debugLogger.error("Error upserting speaker profile", { error: error.message }, "database");
      throw error;
    }
  }

  attachEmailToProfile(profileId, email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      const profile = this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      if (!profile) throw new Error(`Speaker profile ${profileId} not found`);

      if (!normalizedEmail) {
        this.db
          .prepare(
            "UPDATE speaker_profiles SET email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(profileId);
        return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      }

      const collision = this._findProfileByEmail(normalizedEmail);
      if (collision && collision.id !== profileId) {
        return this.mergeSpeakerProfiles(collision, profile);
      }

      this.db
        .prepare(
          "UPDATE speaker_profiles SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(normalizedEmail, profileId);
      return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
    } catch (error) {
      debugLogger.error(
        "Error attaching email to speaker profile",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  mergeSpeakerProfiles(a, b) {
    const winner = (a.sample_count || 0) >= (b.sample_count || 0) ? a : b;
    const loser = winner === a ? b : a;

    const winnerEmb = new Float32Array(
      winner.embedding.buffer,
      winner.embedding.byteOffset,
      winner.embedding.byteLength / 4
    );
    const loserEmb = new Float32Array(
      loser.embedding.buffer,
      loser.embedding.byteOffset,
      loser.embedding.byteLength / 4
    );
    const wSamples = winner.sample_count || 1;
    const lSamples = loser.sample_count || 1;
    const total = wSamples + lSamples;
    const blended = new Float32Array(winnerEmb.length);
    for (let i = 0; i < winnerEmb.length; i++) {
      blended[i] = (winnerEmb[i] * wSamples + loserEmb[i] * lSamples) / total;
    }

    const finalEmail = winner.email || loser.email || null;
    const finalName = winner.display_name || loser.display_name;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(finalName, finalEmail, Buffer.from(blended.buffer), total, winner.id);
      this.db
        .prepare(
          "UPDATE speaker_mappings SET profile_id = ?, display_name = ? WHERE profile_id = ?"
        )
        .run(winner.id, finalName, loser.id);
      this.db.prepare("DELETE FROM speaker_profiles WHERE id = ?").run(loser.id);
    });
    tx();

    return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(winner.id);
  }

  getSpeakerProfiles(includeEmbedding = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const query = includeEmbedding
        ? "SELECT * FROM speaker_profiles"
        : `SELECT id, display_name, email, sample_count, created_at, updated_at
           FROM speaker_profiles`;
      return this.db.prepare(query).all();
    } catch (error) {
      debugLogger.error("Error getting speaker profiles", { error: error.message }, "database");
      throw error;
    }
  }

  setSpeakerMapping(noteId, speakerId, profileId, displayName) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "INSERT OR REPLACE INTO speaker_mappings (note_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?)"
        )
        .run(noteId, speakerId, profileId, displayName);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }

  getSpeakerMappings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM speaker_mappings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error("Error getting speaker mappings", { error: error.message }, "database");
      throw error;
    }
  }

  saveNoteSpeakerEmbeddings(noteId, embeddings) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((entries) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
        );
        for (const [speakerId, buffer] of entries) {
          stmt.run(noteId, speakerId, buffer);
        }
      });
      transaction(Object.entries(embeddings));
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error saving note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getNoteSpeakerEmbeddings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM note_speaker_embeddings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error(
        "Error getting note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getPendingNotes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM notes WHERE sync_status = 'pending' AND deleted_at IS NULL")
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending notes", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingNoteDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM notes WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending'"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending note deletes", { error: error.message }, "database");
      throw error;
    }
  }

  getNoteByClientId(clientNoteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db.prepare("SELECT * FROM notes WHERE client_note_id = ?").get(clientNoteId) || null
      );
    } catch (error) {
      debugLogger.error("Error getting note by client id", { error: error.message }, "database");
      throw error;
    }
  }

  upsertNoteFromCloud(cloudNote, localFolderId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(`
        INSERT INTO notes (client_note_id, cloud_id, title, content, enhanced_content,
          enhancement_prompt, enhanced_at_content_hash, note_type, source_file,
          audio_duration_seconds, transcript, folder_id, sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)
        ON CONFLICT(client_note_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          title = excluded.title,
          content = excluded.content,
          enhanced_content = excluded.enhanced_content,
          enhancement_prompt = excluded.enhancement_prompt,
          enhanced_at_content_hash = excluded.enhanced_at_content_hash,
          transcript = excluded.transcript,
          folder_id = excluded.folder_id,
          sync_status = 'synced',
          updated_at = excluded.updated_at
      `);
      stmt.run(
        cloudNote.client_note_id,
        cloudNote.id,
        cloudNote.title,
        cloudNote.content,
        cloudNote.enhanced_content || null,
        cloudNote.enhancement_prompt || null,
        cloudNote.enhanced_at_content_hash || null,
        cloudNote.note_type || "personal",
        cloudNote.source_file || null,
        cloudNote.audio_duration_seconds || null,
        cloudNote.transcript || null,
        localFolderId,
        cloudNote.created_at,
        cloudNote.updated_at
      );
      return this.db
        .prepare("SELECT * FROM notes WHERE client_note_id = ?")
        .get(cloudNote.client_note_id);
    } catch (error) {
      debugLogger.error("Error upserting note from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markNoteSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE notes SET sync_status = 'synced', cloud_id = ? WHERE id = ?")
        .run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking note synced", { error: error.message }, "database");
      throw error;
    }
  }

  markNoteSyncError(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE notes SET sync_status = 'error' WHERE id = ?").run(id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking note sync error", { error: error.message }, "database");
      throw error;
    }
  }

  hardDeleteNote(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error hard deleting note", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingFolders() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM folders WHERE sync_status = 'pending' AND deleted_at IS NULL")
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending folders", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingFolderDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM folders WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending'"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending folder deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db.prepare("SELECT name FROM folders WHERE id = ?").get(id);
      const noteIds = this.db
        .prepare("SELECT id FROM notes WHERE folder_id = ?")
        .all(id)
        .map((row) => row.id);
      const result = this.db.transaction(() => {
        this.db.prepare("DELETE FROM notes WHERE folder_id = ?").run(id);
        return this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      })();
      return { success: result.changes > 0, id, noteIds, name: folder?.name ?? null };
    } catch (error) {
      debugLogger.error("Error hard deleting folder", { error: error.message }, "database");
      throw error;
    }
  }

  getFolderByClientId(clientFolderId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db.prepare("SELECT * FROM folders WHERE client_folder_id = ?").get(clientFolderId) ||
        null
      );
    } catch (error) {
      debugLogger.error("Error getting folder by client id", { error: error.message }, "database");
      throw error;
    }
  }

  upsertFolderFromCloud(cloudFolder) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(`
        INSERT INTO folders (client_folder_id, cloud_id, name, is_default, sort_order, sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'synced', ?, ?)
        ON CONFLICT(client_folder_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          name = excluded.name,
          sort_order = excluded.sort_order,
          sync_status = 'synced',
          updated_at = excluded.updated_at
      `);
      stmt.run(
        cloudFolder.client_folder_id,
        cloudFolder.id,
        cloudFolder.name,
        cloudFolder.is_default ? 1 : 0,
        cloudFolder.sort_order || 0,
        cloudFolder.created_at,
        cloudFolder.updated_at || cloudFolder.created_at
      );
      return this.db
        .prepare("SELECT * FROM folders WHERE client_folder_id = ?")
        .get(cloudFolder.client_folder_id);
    } catch (error) {
      debugLogger.error("Error upserting folder from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markFolderSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE folders SET sync_status = 'synced', cloud_id = ? WHERE id = ?")
        .run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking folder synced", { error: error.message }, "database");
      throw error;
    }
  }

  getFolderIdMap() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM folders WHERE deleted_at IS NULL").all();
    } catch (error) {
      debugLogger.error("Error getting folder id map", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingConversations() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM agent_conversations WHERE sync_status = 'pending' AND deleted_at IS NULL"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending conversations",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getPendingConversationDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM agent_conversations WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending'"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending conversation deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getConversationByClientId(clientId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT * FROM agent_conversations WHERE client_conversation_id = ?")
          .get(clientId) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting conversation by client id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertConversationFromCloud(cloudConv, messages) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const convStmt = this.db.prepare(`
          INSERT INTO agent_conversations (client_conversation_id, cloud_id, title, note_id, sync_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'synced', ?, ?)
          ON CONFLICT(client_conversation_id) DO UPDATE SET
            cloud_id = excluded.cloud_id,
            title = excluded.title,
            note_id = excluded.note_id,
            sync_status = 'synced',
            updated_at = excluded.updated_at
        `);
        convStmt.run(
          cloudConv.client_conversation_id ?? null,
          cloudConv.id ?? null,
          cloudConv.title ?? "Untitled",
          cloudConv.note_id ?? null,
          cloudConv.created_at ?? new Date().toISOString(),
          cloudConv.updated_at ?? new Date().toISOString()
        );
        const conv = this.db
          .prepare("SELECT * FROM agent_conversations WHERE client_conversation_id = ?")
          .get(cloudConv.client_conversation_id);
        this.db.prepare("DELETE FROM agent_messages WHERE conversation_id = ?").run(conv.id);
        if (messages && messages.length > 0) {
          const msgStmt = this.db.prepare(
            "INSERT INTO agent_messages (conversation_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
          );
          for (const msg of messages) {
            msgStmt.run(
              conv.id,
              msg.role ?? "user",
              msg.content ?? "",
              msg.metadata ? JSON.stringify(msg.metadata) : null,
              msg.created_at ?? new Date().toISOString()
            );
          }
        }
        return conv;
      });
      return transaction();
    } catch (error) {
      debugLogger.error(
        "Error upserting conversation from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  markConversationSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE agent_conversations SET sync_status = 'synced', cloud_id = ? WHERE id = ?")
        .run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking conversation synced", { error: error.message }, "database");
      throw error;
    }
  }

  hardDeleteConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM agent_messages WHERE conversation_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM agent_conversations WHERE id = ?").run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error hard deleting conversation", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingTranscriptions() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM transcriptions WHERE sync_status = 'pending' AND deleted_at IS NULL"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending transcriptions",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getPendingTranscriptionDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM transcriptions WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending'"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending transcription deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteTranscription(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error hard deleting transcription", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptionByClientId(clientId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT * FROM transcriptions WHERE client_transcription_id = ?")
          .get(clientId) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting transcription by client id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertTranscriptionFromCloud(cloudTranscription) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(`
        INSERT INTO transcriptions (client_transcription_id, cloud_id, text, raw_text, status, sync_status, created_at)
        VALUES (?, ?, ?, ?, ?, 'synced', ?)
        ON CONFLICT(client_transcription_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          text = excluded.text,
          raw_text = excluded.raw_text,
          status = excluded.status,
          sync_status = 'synced'
      `);
      stmt.run(
        cloudTranscription.client_transcription_id,
        cloudTranscription.id,
        cloudTranscription.text,
        cloudTranscription.raw_text || null,
        cloudTranscription.status || "completed",
        cloudTranscription.created_at
      );
      return this.db
        .prepare("SELECT * FROM transcriptions WHERE client_transcription_id = ?")
        .get(cloudTranscription.client_transcription_id);
    } catch (error) {
      debugLogger.error(
        "Error upserting transcription from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  markTranscriptionSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE transcriptions SET sync_status = 'synced', cloud_id = ? WHERE id = ?")
        .run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking transcription synced", { error: error.message }, "database");
      throw error;
    }
  }

  getNotesWithUnmappedSpeakers() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT DISTINCT nse.note_id
          FROM note_speaker_embeddings nse
          LEFT JOIN speaker_mappings sm ON nse.note_id = sm.note_id AND nse.speaker_id = sm.speaker_id
          WHERE sm.note_id IS NULL`
        )
        .all()
        .map((row) => row.note_id);
    } catch (error) {
      debugLogger.error(
        "Error getting notes with unmapped speakers",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  removeSpeakerMapping(noteId, speakerId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("DELETE FROM speaker_mappings WHERE note_id = ? AND speaker_id = ?")
        .run(noteId, speakerId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }
}

module.exports = DatabaseManager;
