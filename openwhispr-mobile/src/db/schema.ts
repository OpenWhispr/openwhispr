import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { Buffer } from 'buffer';

const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globalWithBuffer.Buffer) {
  globalWithBuffer.Buffer = Buffer;
}

// A space is a shared container inside a workspace (or, for kind 'private', the
// device-local personal space every install seeds exactly one of — see
// migrate.ts). space_id on notes/folders is documentation-only: this codebase
// never enables the foreign_keys pragma, so child cleanup stays manual.
export const spaces = sqliteTable(
  'spaces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientSpaceId: text('client_space_id').notNull(),
    cloudSpaceId: text('cloud_space_id'),
    workspaceId: text('workspace_id'),
    // Denormalised from GET /api/workspaces: /api/me/spaces returns only the id,
    // and the Spaces list groups under workspace names.
    workspaceName: text('workspace_name'),
    kind: text('kind', { enum: ['private', 'team'] }).notNull(),
    name: text('name').notNull(),
    emoji: text('emoji'),
    sortOrder: integer('sort_order').notNull().default(0),
    myRole: text('my_role', { enum: ['admin', 'member'] }),
    memberCount: integer('member_count').notNull().default(0),
    // JSON array from the server, stored verbatim.
    teams: text('teams'),
    // 'pending' marks a skeleton space whose content backfill hasn't completed.
    syncStatus: text('sync_status', { enum: ['synced', 'pending'] })
      .notNull()
      .default('synced'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_spaces_client_space_id').on(table.clientSpaceId),
    uniqueIndex('idx_spaces_cloud_space_id')
      .on(table.cloudSpaceId)
      .where(sql`${table.cloudSpaceId} IS NOT NULL`),
    check('spaces_kind', sql`${table.kind} IN ('private', 'team')`),
    check('spaces_sync_status', sql`${table.syncStatus} IN ('synced', 'pending')`),
  ],
);

export const folders = sqliteTable('folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  isDefault: integer('is_default').default(0),
  sortOrder: integer('sort_order').default(0),
  clientFolderId: text('client_folder_id'),
  remoteId: text('remote_id'),
  deletedAt: text('deleted_at'),
  pendingSync: integer('pending_sync').notNull().default(0),
  spaceId: integer('space_id').references(() => spaces.id),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull().default('Untitled'),
  content: text('content').notNull().default(''),
  folderId: integer('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  noteType: text('note_type').default('personal'),
  sourceFile: text('source_file'),
  audioDurationSeconds: real('audio_duration_seconds'),
  enhancedContent: text('enhanced_content'),
  enhancementPrompt: text('enhancement_prompt'),
  enhancedAtContentHash: text('enhanced_at_content_hash'),
  // Raw desktop-shape transcript JSON, synced verbatim via notes.transcript.
  // Segments/speakers are decomposed from this on pull; kept to detect remote changes.
  transcript: text('transcript'),
  diarizationEnabled: integer('diarization_enabled').notNull().default(0),
  expectedSpeakerCount: integer('expected_speaker_count'),
  transcriptionStatus: text('transcription_status').default('idle'),
  calendarEventId: text('calendar_event_id'),
  participants: text('participants'),
  clientNoteId: text('client_note_id'),
  remoteId: text('remote_id'),
  deletedAt: text('deleted_at'),
  pendingSync: integer('pending_sync').notNull().default(0),
  isPrivate: integer('is_private').notNull().default(0),
  spaceId: integer('space_id').references(() => spaces.id),
  // The note's owner (CloudNote.user_id) — who created it, not who last edited
  // it. NULL until a cloud pull or push response fills it.
  ownerUserId: text('owner_user_id'),
  // Last cloud editor (CloudNote.updated_by_user_id); only populated on cloud pull.
  updatedByUserId: text('updated_by_user_id'),
  // Server updated_at this device last acked (push response or pull); echoed back
  // as base_updated_at on the next PATCH so the server can 409 a stale overwrite.
  cloudUpdatedAt: text('cloud_updated_at'),
  // JSON-serialized RemoteNote snapshot from a 409 note_version_conflict's
  // ApiError.data.note. Set only while the row is "parked" (see pushNotes.ts);
  // its presence excludes the row from the pending-push query until resolved
  // via resolveConflictKeepMine/resolveConflictUseServer.
  conflictServerNote: text('conflict_server_note'),
  leftTeam: integer('left_team').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const actions = sqliteTable('actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  prompt: text('prompt').notNull(),
  isDefault: integer('is_default').default(0),
  sortOrder: integer('sort_order').default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const dictionaryEntries = sqliteTable('dictionary_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  word: text('word').notNull(),
  source: text('source', { enum: ['manual', 'learned'] })
    .notNull()
    .default('manual'),
  clientDictId: text('client_dict_id'),
  remoteId: text('remote_id'),
  deletedAt: text('deleted_at'),
  pendingSync: integer('pending_sync').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const snippets = sqliteTable('snippets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trigger: text('trigger').notNull(),
  replacement: text('replacement').notNull(),
  clientSnippetId: text('client_snippet_id'),
  remoteId: text('remote_id'),
  deletedAt: text('deleted_at'),
  pendingSync: integer('pending_sync').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const transcriptSegments = sqliteTable('transcript_segments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  noteId: integer('note_id')
    .notNull()
    .references(() => notes.id, { onDelete: 'cascade' }),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  text: text('text').notNull().default(''),
  speakerLabel: text('speaker_label'),
  sortOrder: integer('sort_order').notNull().default(0),
  clientId: text('client_id'),
  remoteId: text('remote_id'),
  deletedAt: text('deleted_at'),
  pendingSync: integer('pending_sync').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const speakers = sqliteTable('speakers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  noteId: integer('note_id')
    .notNull()
    .references(() => notes.id, { onDelete: 'cascade' }),
  speakerLabel: text('speaker_label').notNull(),
  displayName: text('display_name'),
  profileId: integer('profile_id'),
  color: text('color'),
  sortOrder: integer('sort_order').notNull().default(0),
  speakerStatus: text('speaker_status', {
    enum: ['provisional', 'suggested', 'confirmed', 'locked'],
  }),
  speakerLocked: integer('speaker_locked').notNull().default(0),
  speakerLockSource: text('speaker_lock_source', {
    enum: ['user', 'diarization', 'suggestion'],
  }),
  clientId: text('client_id'),
  remoteId: text('remote_id'),
  deletedAt: text('deleted_at'),
  pendingSync: integer('pending_sync').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const speakerProfiles = sqliteTable(
  'speaker_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    displayName: text('display_name').notNull(),
    email: text('email'),
    isOwner: integer('is_owner').notNull().default(0),
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),
    sampleCount: integer('sample_count').notNull().default(1),
    consentAt: text('consent_at').notNull(),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_speaker_profiles_owner')
      .on(table.isOwner)
      .where(sql`${table.isOwner} = 1`),
    index('idx_speaker_profiles_email')
      .on(table.email)
      .where(sql`${table.email} IS NOT NULL`),
    check('speaker_profiles_is_owner_bool', sql`${table.isOwner} IN (0, 1)`),
  ],
);

export const googleCalendarAccounts = sqliteTable(
  'google_calendar_accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    googleSubject: text('google_subject').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    grantedScopes: text('granted_scopes'),
    status: text('status', {
      enum: ['connected', 'needs_reconnect', 'error'],
    })
      .notNull()
      .default('connected'),
    lastSyncAt: text('last_sync_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [uniqueIndex('idx_google_calendar_accounts_subject').on(table.googleSubject)],
);

export const googleCalendars = sqliteTable(
  'google_calendars',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => googleCalendarAccounts.id, { onDelete: 'cascade' }),
    googleCalendarId: text('google_calendar_id').notNull(),
    summary: text('summary'),
    isPrimary: integer('is_primary').notNull().default(0),
    accessRole: text('access_role'),
    selected: integer('selected').notNull().default(0),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_google_calendars_account_calendar').on(
      table.accountId,
      table.googleCalendarId,
    ),
    index('idx_google_calendars_account_selected').on(table.accountId, table.selected),
  ],
);

export const googleCalendarSyncState = sqliteTable(
  'google_calendar_sync_state',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => googleCalendarAccounts.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type', { enum: ['calendar_list'] }).notNull(),
    syncToken: text('sync_token'),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.resourceType],
      name: 'pk_google_calendar_sync_state',
    }),
  ],
);

export const googleCalendarEvents = sqliteTable(
  'google_calendar_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => googleCalendarAccounts.id, { onDelete: 'cascade' }),
    calendarLocalId: integer('calendar_local_id')
      .notNull()
      .references(() => googleCalendars.id, { onDelete: 'cascade' }),
    googleCalendarId: text('google_calendar_id').notNull(),
    googleEventId: text('google_event_id').notNull(),
    iCalUID: text('ical_uid'),
    summary: text('summary'),
    description: text('description'),
    location: text('location'),
    startAt: text('start_at').notNull(),
    endAt: text('end_at').notNull(),
    allDay: integer('all_day').notNull().default(0),
    status: text('status'),
    organizerEmail: text('organizer_email'),
    creatorEmail: text('creator_email'),
    attendeesJson: text('attendees_json'),
    updated: text('updated'),
    htmlLink: text('html_link'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_google_calendar_events_account_calendar_event').on(
      table.accountId,
      table.googleCalendarId,
      table.googleEventId,
    ),
    index('idx_google_calendar_events_account_start').on(table.accountId, table.startAt),
    index('idx_google_calendar_events_calendar_window').on(
      table.calendarLocalId,
      table.startAt,
      table.endAt,
    ),
  ],
);

// Journal for an in-flight folder delete. A folder delete cascades to its notes
// server-side, so the client applies that cascade optimistically — tombstoning
// the folder and its notes before the server has ruled. Their prior state is
// recorded here so a refusal (a non-admin deleting a space folder, an archived
// space) can put every row back exactly as it was. Rows named here are held:
// excluded from the note push queue and skipped by pulls until the folder
// delete settles, so nothing races the finalize/revert.
export const folderDeleteJournal = sqliteTable(
  'folder_delete_journal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    folderId: integer('folder_id').notNull(),
    entityType: text('entity_type', { enum: ['folder', 'note'] }).notNull(),
    entityId: integer('entity_id').notNull(),
    originalDeletedAt: text('original_deleted_at'),
    originalPendingSync: integer('original_pending_sync').notNull(),
    originalUpdatedAt: text('original_updated_at'),
  },
  (table) => [
    uniqueIndex('idx_folder_delete_journal_entity').on(table.entityType, table.entityId),
    index('idx_folder_delete_journal_folder').on(table.folderId),
    check('folder_delete_journal_entity_type', sql`${table.entityType} IN ('folder', 'note')`),
  ],
);
