import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { randomUUID } from '@/lib/uuid';
import { LocalNotesRepository } from '../notesRepository';

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// In-memory schema for repository tests. Keep aligned with src/db/migrate.ts; runMigrations itself
// can't run here because it is bound to expo-sqlite at module load.
export const createMemoryRepository = (): { repo: LocalNotesRepository; db: TestDb } => {
  const rawDb = new Database(':memory:');
  rawDb.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT NOT NULL DEFAULT '',
      folder_id INTEGER,
      note_type TEXT DEFAULT 'personal',
      source_file TEXT,
      audio_duration_seconds REAL,
      enhanced_content TEXT,
      enhancement_prompt TEXT,
      enhanced_at_content_hash TEXT,
      transcript TEXT,
      diarization_enabled INTEGER NOT NULL DEFAULT 0,
      expected_speaker_count INTEGER,
      transcription_status TEXT DEFAULT 'idle',
      calendar_event_id TEXT,
      participants TEXT,
      client_note_id TEXT,
      remote_id TEXT,
      deleted_at TEXT,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      is_private INTEGER NOT NULL DEFAULT 0,
      space_id INTEGER,
      owner_user_id TEXT,
      updated_by_user_id TEXT,
      cloud_updated_at TEXT,
      conflict_server_note TEXT,
      left_team INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      client_folder_id TEXT,
      remote_id TEXT,
      deleted_at TEXT,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      space_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE spaces (
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

    CREATE TABLE dictionary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','learned')),
      replacement TEXT,
      category TEXT,
      notes TEXT,
      client_dict_id TEXT,
      remote_id TEXT,
      deleted_at TEXT,
      pending_sync INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE snippets (
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

    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
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

    CREATE TABLE transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
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

    CREATE TABLE speaker_profiles (
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

    CREATE TABLE google_calendar_accounts (
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

    CREATE TABLE google_calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      google_calendar_id TEXT NOT NULL,
      summary TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      access_role TEXT,
      selected INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE google_calendar_sync_state (
      account_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('calendar_list')),
      sync_token TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      CONSTRAINT pk_google_calendar_sync_state PRIMARY KEY (account_id, resource_type)
    );

    CREATE TABLE google_calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      calendar_local_id INTEGER NOT NULL,
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

    CREATE UNIQUE INDEX idx_speaker_profiles_owner
      ON speaker_profiles(is_owner)
      WHERE is_owner = 1;
    CREATE INDEX idx_speaker_profiles_email
      ON speaker_profiles(email)
      WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX idx_google_calendar_accounts_subject
      ON google_calendar_accounts(google_subject);
    CREATE UNIQUE INDEX idx_google_calendars_account_calendar
      ON google_calendars(account_id, google_calendar_id);
    CREATE INDEX idx_google_calendars_account_selected
      ON google_calendars(account_id, selected);
    CREATE UNIQUE INDEX idx_google_calendar_events_account_calendar_event
      ON google_calendar_events(account_id, google_calendar_id, google_event_id);
    CREATE INDEX idx_google_calendar_events_account_start
      ON google_calendar_events(account_id, start_at);
    CREATE INDEX idx_google_calendar_events_calendar_window
      ON google_calendar_events(calendar_local_id, start_at, end_at);
    CREATE UNIQUE INDEX idx_spaces_client_space_id ON spaces(client_space_id);
    CREATE UNIQUE INDEX idx_spaces_cloud_space_id
      ON spaces(cloud_space_id)
      WHERE cloud_space_id IS NOT NULL;
  `);
  // Mirrors the migration's fresh-install seed: every install gets exactly one
  // 'private' space, which repo.createFolder/createNote resolve into.
  rawDb
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status) VALUES (?, 'private', 'Personal', 0, 'synced')",
    )
    .run(randomUUID());

  const db = drizzle(rawDb, { schema });
  return {
    repo: new LocalNotesRepository(
      db as unknown as ConstructorParameters<typeof LocalNotesRepository>[0],
    ),
    db,
  };
};
