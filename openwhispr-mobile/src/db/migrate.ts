import 'expo-sqlite/localStorage/install';
import * as SQLite from 'expo-sqlite';
import { randomUUID } from '@/lib/uuid';
import { openApplicationDatabase } from './connections';

const legacyDb = openApplicationDatabase('openwhispr_notes.db');

const LEGACY_DICTIONARY_KEY = 'openwhispr_dictionary';

function tryAlter(rawDb: SQLite.SQLiteDatabase, statement: string) {
  try {
    rawDb.execSync(statement);
  } catch {
    // Column already exists
  }
}

function columnExists(rawDb: SQLite.SQLiteDatabase, table: string, column: string): boolean {
  const rows = rawDb.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
  rawDb: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  if (columnExists(rawDb, table, column)) return;
  tryAlter(rawDb, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// One-shot migration: legacy `openwhispr_dictionary` localStorage payload → SQLite.
// Wrapped in a transaction so a single bad row (e.g., lower(word) duplicate
// against the partial unique index) doesn't abort the entire payload and leave
// behind a half-migrated state plus a deleted legacy key.
function migrateDictionaryFromLocalStorage(rawDb: SQLite.SQLiteDatabase): void {
  const raw = localStorage.getItem(LEGACY_DICTIONARY_KEY);
  if (!raw) return;

  const existing = rawDb.getAllSync<{ count: number }>(
    'SELECT COUNT(*) as count FROM dictionary_entries',
  );
  if ((existing[0]?.count ?? 0) > 0) {
    localStorage.removeItem(LEGACY_DICTIONARY_KEY);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(LEGACY_DICTIONARY_KEY);
    return;
  }
  if (!Array.isArray(parsed)) {
    localStorage.removeItem(LEGACY_DICTIONARY_KEY);
    return;
  }

  type LegacyEntry = { word: string; source?: 'manual' | 'learned'; addedAt?: number | null };
  const nowSql = new Date().toISOString().replace('T', ' ').slice(0, 19);
  // INSERT OR IGNORE on (lower(word)) collisions — legacy data may have
  // duplicates that the new partial unique index would reject.
  const insertSql =
    'INSERT OR IGNORE INTO dictionary_entries (word, source, client_dict_id, pending_sync, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)';

  let committed = false;
  try {
    rawDb.execSync('BEGIN');
    for (const entry of parsed) {
      let word = '';
      let source: 'manual' | 'learned' = 'manual';
      // null preserves the "ancient entry, no addedAt" semantic that the
      // pre-Drizzle store used to exclude rows from "Recently Added".
      let createdAt: string | null = null;
      if (typeof entry === 'string') {
        word = entry.trim();
      } else if (entry && typeof entry === 'object') {
        const e = entry as LegacyEntry;
        if (typeof e.word !== 'string') continue;
        word = e.word.trim();
        if (e.source === 'learned') source = 'learned';
        if (typeof e.addedAt === 'number') {
          createdAt = new Date(e.addedAt).toISOString().replace('T', ' ').slice(0, 19);
        }
      }
      if (!word) continue;
      rawDb.runSync(insertSql, word, source, randomUUID(), createdAt, nowSql);
    }
    rawDb.execSync('COMMIT');
    committed = true;
  } catch {
    try {
      rawDb.execSync('ROLLBACK');
    } catch {
      // Already rolled back or transaction never opened.
    }
    // Leave the legacy key in place so the next launch can retry.
    return;
  }

  if (committed) {
    localStorage.removeItem(LEGACY_DICTIONARY_KEY);
  }
}

// Every install gets exactly one 'private' space (idempotent: only inserted
// when none exists yet), and every notes/folders row without a space defaults
// into it — both fresh rows created before this migration first ran, and any
// row a future addColumnIfMissing leaves NULL.
function seedPrivateSpaceAndBackfillSpaceId(rawDb: SQLite.SQLiteDatabase): void {
  const existing = rawDb.getAllSync<{ count: number }>(
    "SELECT COUNT(*) as count FROM spaces WHERE kind = 'private'",
  );
  if ((existing[0]?.count ?? 0) === 0) {
    rawDb.runSync(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status) VALUES (?, 'private', 'Personal', 0, 'synced')",
      randomUUID(),
    );
  }

  const privateSpace = rawDb.getAllSync<{ id: number }>(
    "SELECT id FROM spaces WHERE kind = 'private' LIMIT 1",
  );
  const privateSpaceId = privateSpace[0]?.id;
  // Guards a corrupt/edge-case DB state; the insert above should always
  // produce exactly one row by this point.
  if (privateSpaceId == null) return;

  rawDb.runSync('UPDATE notes SET space_id = ? WHERE space_id IS NULL', privateSpaceId);
  rawDb.runSync('UPDATE folders SET space_id = ? WHERE space_id IS NULL', privateSpaceId);
}

function seedDefaultFolders(rawDb: SQLite.SQLiteDatabase): void {
  const privateSpaceId = rawDb.getAllSync<{ id: number }>(
    "SELECT id FROM spaces WHERE kind = 'private' LIMIT 1",
  )[0]?.id;
  if (privateSpaceId == null) return;

  for (const [legacyId, name, sortOrder] of [
    [1, 'Personal', 0],
    [2, 'Meetings', 1],
  ] as const) {
    // Old launches recreated ids 1/2 after account-switch pulls assigned new ids.
    // Retire only unused, unchanged seeds; synced/customized folders and every
    // note reference (including soft-deleted notes) must survive untouched.
    rawDb.runSync(
      `DELETE FROM folders
       WHERE id = ? AND name = ? AND sort_order = ? AND space_id = ?
         AND is_default = 1 AND deleted_at IS NULL AND pending_sync = 0
         AND remote_id IS NULL AND client_folder_id IS NULL AND updated_at = created_at
         AND NOT EXISTS (SELECT 1 FROM notes WHERE folder_id = folders.id)
         AND NOT EXISTS (SELECT 1 FROM folder_delete_journal WHERE folder_id = folders.id)
         AND EXISTS (
           SELECT 1 FROM folders AS synced
           WHERE synced.id != folders.id AND synced.space_id = folders.space_id
             AND synced.is_default = 1 AND synced.deleted_at IS NULL
             AND synced.remote_id IS NOT NULL AND lower(synced.name) = lower(folders.name)
         )`,
      legacyId,
      name,
      sortOrder,
      privateSpaceId,
    );
    // Local ids are not stable across account switches. Reuse a private default
    // by name, also preserving renamed legacy defaults and deletion tombstones.
    rawDb.runSync(
      `INSERT INTO folders (name, is_default, sort_order, space_id)
       SELECT ?, 1, ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM folders WHERE space_id = ? AND is_default = 1
           AND (lower(name) = lower(?)
             OR (id = ? AND lower(name) NOT IN ('personal', 'meetings')))
       )`,
      name,
      sortOrder,
      privateSpaceId,
      privateSpaceId,
      name,
      legacyId,
    );
  }
}

export function runMigrations(
  rawDb: SQLite.SQLiteDatabase = legacyDb,
  migrateLegacyDictionary = true,
): void {
  rawDb.execSync(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT NOT NULL DEFAULT '',
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      note_type TEXT DEFAULT 'personal',
      source_file TEXT,
      audio_duration_seconds REAL,
      enhanced_content TEXT,
      enhancement_prompt TEXT,
      enhanced_at_content_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dictionary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','learned')),
      client_dict_id TEXT,
      remote_id TEXT,
      deleted_at TEXT,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL,
      replacement TEXT NOT NULL,
      client_snippet_id TEXT,
      remote_id TEXT,
      deleted_at TEXT,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      steps_json TEXT,
      sources_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      speaker_label TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      client_id TEXT,
      remote_id TEXT,
      deleted_at TEXT,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      speaker_label TEXT NOT NULL,
      display_name TEXT,
      profile_id INTEGER,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      speaker_status TEXT,
      speaker_locked INTEGER NOT NULL DEFAULT 0,
      speaker_lock_source TEXT,
      client_id TEXT,
      remote_id TEXT,
      deleted_at TEXT,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS speaker_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      email TEXT,
      is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
      embedding BLOB NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 1,
      consent_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS google_calendar_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_subject TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      granted_scopes TEXT,
      status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reconnect','error')),
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS google_calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES google_calendar_accounts(id) ON DELETE CASCADE,
      google_calendar_id TEXT NOT NULL,
      summary TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      access_role TEXT,
      selected INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS google_calendar_sync_state (
      account_id INTEGER NOT NULL REFERENCES google_calendar_accounts(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('calendar_list')),
      sync_token TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      CONSTRAINT pk_google_calendar_sync_state PRIMARY KEY (account_id, resource_type)
    );

    CREATE TABLE IF NOT EXISTS google_calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES google_calendar_accounts(id) ON DELETE CASCADE,
      calendar_local_id INTEGER NOT NULL REFERENCES google_calendars(id) ON DELETE CASCADE,
      google_calendar_id TEXT NOT NULL,
      google_event_id TEXT NOT NULL,
      ical_uid TEXT,
      summary TEXT,
      description TEXT,
      location TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      organizer_email TEXT,
      creator_email TEXT,
      attendees_json TEXT,
      updated TEXT,
      html_link TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- A space is a shared container inside a workspace; kind='private' is the
    -- device-local personal space every install seeds exactly one of (below).
    CREATE TABLE IF NOT EXISTS spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_space_id TEXT NOT NULL,
      cloud_space_id TEXT,
      workspace_id TEXT,
      workspace_name TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('private','team')),
      name TEXT NOT NULL,
      emoji TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      my_role TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      teams TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced','pending')),
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS folder_delete_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('folder','note')),
      entity_id INTEGER NOT NULL,
      original_deleted_at TEXT,
      original_pending_sync INTEGER NOT NULL,
      original_updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_delete_journal_entity
      ON folder_delete_journal(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_folder_delete_journal_folder
      ON folder_delete_journal(folder_id);
  `);

  // Add columns that may be missing on existing installs
  addColumnIfMissing(rawDb, 'notes', 'note_type', "TEXT DEFAULT 'personal'");
  addColumnIfMissing(rawDb, 'notes', 'source_file', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'audio_duration_seconds', 'REAL');
  addColumnIfMissing(rawDb, 'notes', 'enhanced_content', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'enhancement_prompt', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'enhanced_at_content_hash', 'TEXT');
  addColumnIfMissing(rawDb, 'folders', 'sort_order', 'INTEGER DEFAULT 0');

  // Cloud sync additive migrations
  addColumnIfMissing(rawDb, 'folders', 'client_folder_id', 'TEXT');
  addColumnIfMissing(rawDb, 'folders', 'remote_id', 'TEXT');
  addColumnIfMissing(rawDb, 'folders', 'deleted_at', 'TEXT');
  addColumnIfMissing(rawDb, 'folders', 'pending_sync', 'INTEGER NOT NULL DEFAULT 0');
  // SQLite forbids function defaults (datetime('now')) in ALTER TABLE ADD COLUMN.
  // The CREATE TABLE above carries the default for fresh installs; for existing
  // rows, our repository writes updated_at explicitly on every insert/update.
  addColumnIfMissing(rawDb, 'folders', 'updated_at', 'TEXT');

  addColumnIfMissing(rawDb, 'notes', 'client_note_id', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'remote_id', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'deleted_at', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'pending_sync', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(rawDb, 'notes', 'is_private', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(rawDb, 'notes', 'diarization_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(rawDb, 'notes', 'expected_speaker_count', 'INTEGER');
  addColumnIfMissing(rawDb, 'notes', 'transcription_status', "TEXT DEFAULT 'idle'");
  addColumnIfMissing(rawDb, 'notes', 'calendar_event_id', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'participants', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'transcript', 'TEXT');

  // Spaces: scope columns on notes/folders (no REFERENCES clause — ALTER-added
  // columns stay plain, matching the rest of this file; FK enforcement is off
  // regardless since foreign_keys is never pragma'd on).
  addColumnIfMissing(rawDb, 'spaces', 'workspace_name', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'space_id', 'INTEGER');
  addColumnIfMissing(rawDb, 'folders', 'space_id', 'INTEGER');
  addColumnIfMissing(rawDb, 'notes', 'owner_user_id', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'updated_by_user_id', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'cloud_updated_at', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'conflict_server_note', 'TEXT');
  addColumnIfMissing(rawDb, 'notes', 'left_team', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(rawDb, 'dictionary_entries', 'shared_at', 'TEXT');
  addColumnIfMissing(
    rawDb,
    'dictionary_entries',
    'shared_at_cleared',
    'INTEGER NOT NULL DEFAULT 0',
  );

  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_id ON folders(client_folder_id) WHERE client_folder_id IS NOT NULL',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_folders_pending_sync ON folders(pending_sync) WHERE pending_sync = 1',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_client_id ON notes(client_note_id) WHERE client_note_id IS NOT NULL',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_notes_pending_sync ON notes(pending_sync) WHERE pending_sync = 1',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_dictionary_client_id ON dictionary_entries(client_dict_id) WHERE client_dict_id IS NOT NULL',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_dictionary_word_lower ON dictionary_entries(lower(word)) WHERE deleted_at IS NULL',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_dictionary_pending_sync ON dictionary_entries(pending_sync) WHERE pending_sync = 1',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_client_id ON snippets(client_snippet_id) WHERE client_snippet_id IS NOT NULL',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_lower ON snippets(lower(trigger)) WHERE deleted_at IS NULL',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_snippets_pending_sync ON snippets(pending_sync) WHERE pending_sync = 1',
  );
  tryAlter(rawDb, 'CREATE INDEX IF NOT EXISTS idx_segments_note ON transcript_segments(note_id)');
  tryAlter(rawDb, 'CREATE INDEX IF NOT EXISTS idx_speakers_note ON speakers(note_id)');
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_profiles_owner ON speaker_profiles(is_owner) WHERE is_owner = 1',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_speaker_profiles_email ON speaker_profiles(email) WHERE email IS NOT NULL',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendar_accounts_subject ON google_calendar_accounts(google_subject)',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendars_account_calendar ON google_calendars(account_id, google_calendar_id)',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_google_calendars_account_selected ON google_calendars(account_id, selected)',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendar_events_account_calendar_event ON google_calendar_events(account_id, google_calendar_id, google_event_id)',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_google_calendar_events_account_start ON google_calendar_events(account_id, start_at)',
  );
  tryAlter(
    rawDb,
    'CREATE INDEX IF NOT EXISTS idx_google_calendar_events_calendar_window ON google_calendar_events(calendar_local_id, start_at, end_at)',
  );
  tryAlter(rawDb, 'CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)');
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_client_space_id ON spaces(client_space_id)',
  );
  tryAlter(
    rawDb,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_space_id ON spaces(cloud_space_id) WHERE cloud_space_id IS NOT NULL',
  );

  if (migrateLegacyDictionary) migrateDictionaryFromLocalStorage(rawDb);

  // Seed default data
  seedPrivateSpaceAndBackfillSpaceId(rawDb);
  seedDefaultFolders(rawDb);
  rawDb.execSync(`
    INSERT OR IGNORE INTO actions (id, name, description, prompt, is_default)
    VALUES (
      1,
      'Generate Notes',
      'Turn rough dictation into clean, structured notes',
      'Transform the provided content into clean, well-structured notes in markdown. Preserve the user''s intent and all substantive information. Remove filler, small talk, false starts, and redundant content. For personal notes, improve grammar and structure for readability. For meeting transcripts, extract key discussion points, decisions, action items, and follow-ups.',
      1
    );

    UPDATE actions
    SET name = 'Generate Notes',
        description = 'Turn rough dictation into clean, structured notes',
        prompt = 'Transform the provided content into clean, well-structured notes in markdown. Preserve the user''s intent and all substantive information. Remove filler, small talk, false starts, and redundant content. For personal notes, improve grammar and structure for readability. For meeting transcripts, extract key discussion points, decisions, action items, and follow-ups.',
        updated_at = datetime('now')
    WHERE id = 1 AND name = 'Clean Up Notes' AND is_default = 1;
  `);
}
