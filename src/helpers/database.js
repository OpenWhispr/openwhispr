const Database = require("better-sqlite3");
const { dictionaryWordKey } = require("../utils/dictionaryWordKey");
const {
  NOTE_TEXT_FIELDS,
  SUMMARY_CLEARED_METADATA,
  SUMMARY_METADATA,
  clearedNoteFields,
  cloudTextUpdates,
  hasNoteRevision,
  hasPendingNoteClear,
} = require("./noteFieldSync");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { isDeepStrictEqual } = require("util");
const noteUndo = require("./noteUndo");
const debugLogger = require("./debugLogger");
const { buildNoteSearchQuery } = require("./noteSearch");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { parseEventTime } = require("./calendarAvailability");
const { isCloudEntryNewer } = require("./cloudSyncGuards");
// An explicit zone marks an instant this app captured at dictation time. A
// naive timestamp may instead be a sync artifact: upsertTranscriptionFromCloud
// keeps the cloud created_at but lets timestamp default to the local pull, so
// a naive value must never outrank created_at when dating a historical row.
const { hasExplicitTimeZone, parseDbTimestamp, toDbTimestamp } = require("./dbTimestamp");
const {
  BUILTIN_ACTIONS,
  GENERATE_NOTES_KEY,
  LEGACY_DETAILED_NOTES,
  NOTE_ACTION_LIMITS,
} = require("./builtinActions");
const { normalizeSections } = require("./templatePrompts");
const {
  ANALYTICS_COUNTER_VERSION,
  ANALYTICS_HISTORY_BACKFILL_VERSION,
  ANALYTICS_HISTORICAL_COUNTER_VERSION,
  countSpokenWords,
  inferHistoricalAnalyticsMode,
  localDateKey,
  summarizeAnalyticsDays,
} = require("./analytics");
const { EMBEDDING_VERSION } = require("../constants/speakerDetection.json");
const { app } = require("electron");

// Server-enforced trigger cap (openwhispr-api); enforced here so one oversized
// trigger can't 400 the whole sync batch.
const MAX_SNIPPET_TRIGGER_LENGTH = 100;

const SHARED_DICTIONARY_TABLES = [
  "shared_dictionary_entries",
  "shared_dictionary_hides",
  "shared_dictionary_meta",
];
// Personal tables whose rows are unique per account by a case-insensitive key.
const PERSONAL_ROW_KEYS = { custom_dictionary: "word", snippets: "trigger" };
const PERSONAL_ROW_TABLES = [
  "transcriptions",
  "agent_conversations",
  "custom_dictionary",
  "snippets",
];
// Tables whose rows name the account they belong to.
const ACCOUNT_OWNED_TABLES = [
  "notes",
  "folders",
  ...PERSONAL_ROW_TABLES,
  "analytics_events",
  "space_accounts",
];
// A word or trigger's case-insensitive key. SQLite's lower() folds only ASCII,
// so SQL compares keys through fold_key (registered per connection by
// _registerKeyFolding) and JS through this, and both agree on "École".
function foldKey(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

// One row per folded key from rows that may hold several casings of it: the
// account's own row over an unattributed one, a live row over a tombstone.
function rowsByFoldedKey(rows, key) {
  const rank = (row) => (row.account_id ? 2 : 0) + (row.deleted_at ? 0 : 1);
  const byKey = new Map();
  for (const row of rows) {
    const folded = foldKey(row[key]);
    const current = byKey.get(folded);
    if (!current || rank(row) > rank(current)) byKey.set(folded, row);
  }
  return byKey;
}

// legacy_unattributed: 0 is a row written since attribution; the others are from
// before it, so nobody knows whose they are. A row this device uploaded for
// whichever account synced first has a cloud id that says nothing about that.
const LEGACY_UNATTRIBUTED = 1;
const LEGACY_UPLOADED_HERE = 2;

// Text a local writer creates is the user's: recording it as a set lets
// conflict Keep tell it from text this device merely pulled. A blank stays
// unmarked, as it never clears anything.
function typedTextOperation(text) {
  return typeof text === "string" && text.trim() ? "set" : null;
}

const NOTE_FOLDER_DELETE_PENDING_SQL = `EXISTS (
  SELECT 1 FROM optimistic_folder_delete_rows r
  WHERE r.entity_type = 'note' AND r.entity_id = n.id
) AS folder_delete_pending`;

// Every local field a note create (POST) carries; the acknowledgement compares
// these atomically against the pushed snapshot. Must mirror NotePushSnapshot
// in src/types/electron.ts.
const NOTE_CREATE_ACK_FIELDS = [
  "client_note_id",
  "title",
  "content",
  "enhanced_content",
  "content_sync_operation",
  "enhanced_content_sync_operation",
  "content_edit_generation",
  "enhanced_content_edit_generation",
  "enhancement_prompt",
  "enhancement_template_id",
  "enhanced_at_content_hash",
  "note_type",
  "source_file",
  "audio_duration_seconds",
  "folder_id",
  "space_id",
  "transcript",
  "calendar_event_id",
  "participants",
  "diarization_enabled",
  "expected_speaker_count",
  "created_at",
  "updated_at",
  "sync_status",
  "deleted_at",
];
// A PATCH additionally pins the server base and any pending scope retraction.
const NOTE_PATCH_ACK_FIELDS = [
  ...NOTE_CREATE_ACK_FIELDS,
  "cloud_updated_at",
  "cloud_revision",
  "left_team",
];
// Must mirror FolderPushSnapshot in src/types/electron.ts.
const FOLDER_ACK_FIELDS = [
  "client_folder_id",
  "name",
  "is_default",
  "sort_order",
  "space_id",
  "created_at",
  "updated_at",
  "sync_status",
  "deleted_at",
  "left_team",
];

// Validates and normalizes the editable fields of a note template or action.
function resolveActionFields(kind, fields) {
  const name = (fields.name || "").trim();
  const description = (fields.description || "").trim();
  const prompt = (fields.prompt || "").trim();
  const sections = kind === "template" ? normalizeSections(fields.sections) : [];
  const output = kind === "action" ? fields.output || "chat" : null;
  if (!name) return { error: "Name is required" };
  if (kind === "action" && !prompt) return { error: "Action prompt is required" };
  if (kind === "template" && !prompt && sections.length === 0) {
    return { error: "A template needs instructions or a section" };
  }
  if (output !== null && output !== "summary" && output !== "chat") {
    return { error: "Unknown action output" };
  }
  const limits = NOTE_ACTION_LIMITS;
  if (
    name.length > limits.name ||
    description.length > limits.description ||
    prompt.length > limits.prompt ||
    sections.length > limits.sections ||
    sections.some(
      (section) =>
        section.heading.length > limits.heading || section.instruction.length > limits.instruction
    )
  ) {
    return { error: "Too long" };
  }
  return {
    name,
    description,
    prompt,
    sections: sections.length > 0 ? JSON.stringify(sections) : null,
    output,
  };
}

function toActionItem(row) {
  if (!row) return null;
  let sections = null;
  try {
    sections = row.sections ? JSON.parse(row.sections) : null;
  } catch {
    sections = null;
  }
  // Destinations are fixed by built-in identity, never by editable copy or stored output.
  const builtin = BUILTIN_ACTIONS.find((action) => action.translationKey === row.translation_key);
  const output =
    row.kind === "template" ? null : builtin?.output === "summary" ? "summary" : "chat";
  return { ...row, sections, output };
}

function rowMatchesSnapshot(row, snapshot, fields) {
  return fields.every((field) => {
    const fallback = field.endsWith("_edit_generation") ? 0 : null;
    const expected = snapshot[field] === undefined ? fallback : snapshot[field];
    return row[field] === expected;
  });
}

function noteTextMatchesSnapshot(row, snapshot, field) {
  return rowMatchesSnapshot(row, snapshot, [
    field,
    `${field}_sync_operation`,
    `${field}_edit_generation`,
    ...(field === "enhanced_content" ? SUMMARY_METADATA : []),
  ]);
}

// An applied create acknowledges the submitted sets, even if the server kept
// a clear instead. Later edits and undelivered clears still belong to this device.
function acknowledgedCreateTextUpdates(current, snapshot, cloudNote) {
  const fields = NOTE_TEXT_FIELDS.filter(
    (field) =>
      snapshot[`${field}_sync_operation`] !== "clear" &&
      noteTextMatchesSnapshot(current, snapshot, field)
  );
  return {
    ...cloudTextUpdates(current, cloudNote, fields),
    ...Object.fromEntries(fields.map((field) => [`${field}_sync_operation`, null])),
  };
}

// An optimistically deleted folder still holds its server-side name until the
// DELETE is confirmed, so it must keep blocking reuse of that name.
const FOLDER_NAME_TAKEN_FILTER = `(deleted_at IS NULL OR EXISTS (
  SELECT 1 FROM optimistic_folder_delete_rows r
  WHERE r.folder_id = folders.id AND r.entity_type = 'folder'
))`;

// A space's container chats: its root chats, plus every chat in a folder it
// holds now. Folder chats match only through their folder, because a folder
// moved to another space (locally before its chats followed it, or by a pull)
// leaves a stale space_id on them, and container chats never sync, so
// retiring one by that stale space deletes it for good. Binds the space twice.
const SPACE_CONTAINER_CONVERSATION_FILTER = `((space_id = ? AND folder_id IS NULL)
  OR folder_id IN (SELECT id FROM folders WHERE space_id = ?))`;

// Private notes stay on the device (D2). The one exception is a note shared
// before that (D10): its guests keep access, so it keeps syncing. Its cloud
// copy is what makes it one; a fork that dropped the copy is local again.
// Mirrors isLegacySharedPrivateNote in syncPassPolicy.ts; n is notes, s spaces.
const LEGACY_SHARED_PRIVATE_NOTE_SQL =
  "(s.kind = 'private' AND n.is_shared = 1 AND n.cloud_id IS NOT NULL)";

// D32/D32a/D39: a private note drops any cloud identity when it moves into a teamspace, and takes a
// new client id as the import does for a taken key (D28), so its first push is a fresh create. A
// PATCH of an old Backup cloud id would 404 once the copy is purged, and the 404s fork the note
// back to Private. A create under the old key would upsert into the old personal row, and the API
// keeps a deleted row deleted: a copy deleted on another device would take the moved note with
// it. That holds for a key this device never sent too, since Granola derives keys from the
// meeting (its re-import dedupes on source_file instead). A shared note keeps both, since its
// guests' row becomes the team's. Folders keep their key: the folder upsert revives a deleted row.
const BACKUP_NOTE_CLOUD_IDENTITY = Object.freeze({
  cloud_id: null,
  cloud_updated_at: null,
  cloud_revision: null,
  owner_user_id: null,
  updated_by_user_id: null,
  cloud_create_rejected: 0,
  cloud_create_pending: null,
  cloud_create_attempted: 0,
});
const CLEAR_BACKUP_NOTE_CLOUD_IDENTITY_SQL = Object.entries(BACKUP_NOTE_CLOUD_IDENTITY)
  .map(([column, value]) => `${column} = ${value === null ? "NULL" : value}`)
  .join(", ");
// Mirrors LEGACY_SHARED_PRIVATE_NOTE_SQL for a row of notes alone.
const NOT_LEGACY_SHARED_NOTE_SQL = "NOT (is_shared = 1 AND cloud_id IS NOT NULL)";

function isLegacySharedNote(note) {
  return Boolean(note.is_shared) && note.cloud_id != null;
}

// D31: a team row the cloud already holds never becomes private by a move, which would keep its
// cloud identity in a Private. Copy to Private makes a private copy instead. Forks drop the cloud
// link in the same write and aren't moves.
function teamRowSyncedRefusal() {
  return {
    success: false,
    code: "team_row_synced",
    error: "A teamspace note or folder the cloud already has can't move to Private",
  };
}

// The default folders a private space gets the first time a note needs one.
const PRIVATE_DEFAULT_FOLDERS = [
  { name: "Personal", sortOrder: 0 },
  { name: "Meetings", sortOrder: 1 },
];

function workspaceIdOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// A meeting synced by both a REST provider (Google/Microsoft) and Apple
// (Calendar.app mirrors the same accounts) would double-fire reminders and
// duplicate UI rows; suppress the Apple copy when a REST row occupies the same
// time slot + title (REST rows have richer conference data). datetime()
// normalizes the providers' timestamp formats (Google stores offset-form
// RFC3339, Apple/Microsoft store UTC "Z" form). All-day rows pair by local
// days instead: REST providers store plain dates (the end exclusive) while the
// Apple helper writes local instants, ending at either the next midnight or
// the last second of the final day — one second later is the exclusive end
// day in both cases. REST rows are never collapsed — Google and Microsoft are
// never mirrors of each other.
const ALL_DAY_FIRST_DAY = `CASE WHEN length(start_time) = 10 THEN start_time
  ELSE date(start_time, 'localtime') END`;
const ALL_DAY_END_DAY = `CASE WHEN length(end_time) = 10 THEN end_time
  ELSE date(end_time, '+1 second', 'localtime') END`;
const MIRROR_SLOT = `CASE WHEN is_all_day THEN 'day:' || ${ALL_DAY_FIRST_DAY} || '|' || ${ALL_DAY_END_DAY}
  ELSE datetime(start_time) || '|' || datetime(end_time) END`;

function dedupedEventsQuery(where) {
  return `SELECT * FROM (
    SELECT *, MAX(provider != 'apple') OVER (
      PARTITION BY ${MIRROR_SLOT}, COALESCE(summary, '')
    ) AS has_synced
    FROM calendar_events
    WHERE ${where}
  ) WHERE provider != 'apple' OR has_synced = 0 ORDER BY datetime(start_time) ASC`;
}

function stripDedupeColumn({ has_synced: _hasSynced, ...event }) {
  return event;
}

// Whitelist for provider-scoped SQL against the per-provider calendars tables.
const CALENDARS_TABLE_BY_PROVIDER = {
  google: "google_calendars",
  microsoft: "microsoft_calendars",
};

const AVAILABILITY_PROVIDERS = new Set(["google", "microsoft", "apple"]);
const SELECTED_CALENDAR_EVENT_FILTER = `(
  (provider = 'google' AND EXISTS (
    SELECT 1 FROM google_calendars WHERE google_calendars.id = calendar_events.calendar_id
      AND google_calendars.is_selected = 1
  )) OR
  (provider = 'microsoft' AND EXISTS (
    SELECT 1 FROM microsoft_calendars WHERE microsoft_calendars.id = calendar_events.calendar_id
      AND microsoft_calendars.is_selected = 1
  )) OR
  (provider = 'apple' AND EXISTS (
    SELECT 1 FROM apple_calendars WHERE apple_calendars.id = calendar_events.calendar_id
  ))
)`;

// A contacts row's source: "google:<account email>", "microsoft:<account
// email>", "apple", or "manual" (added by hand to a note).
function contactSource(provider, accountEmail = null) {
  return accountEmail ? `${provider}:${accountEmail}` : provider;
}

// Limits a note query to a list of space ids (the spaces the active workspace
// shows). Without a list nothing is filtered; an empty list matches nothing.
function noteSpaceListCondition(column, spaceIds) {
  if (!Array.isArray(spaceIds)) return null;
  const ids = spaceIds.filter((id) => Number.isInteger(id));
  return {
    sql: `${column} IN (SELECT value FROM json_each(?))`,
    param: JSON.stringify(ids),
  };
}

class DatabaseManager {
  constructor() {
    this.db = null;
    this.activeAccountId = null;
    // The active account's active and default workspace, as the renderer last
    // said. An account change restores that account's last accepted scope
    // (D40), since a login launch has no control panel to publish one.
    this.activeWorkspaceId = null;
    this.defaultWorkspaceId = null;
    this._accountTrackedSince = Date.now();
    this._accountChanges = [];
    this.mergedNoteIds = [];
    this.initDatabase();
  }

  setActiveAccountId(accountId) {
    const next =
      typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : null;
    if (next !== this.activeAccountId) {
      this._accountChanges.push({ at: Date.now(), previous: this.activeAccountId });
      if (next) {
        this.db.prepare("INSERT OR IGNORE INTO device_accounts (account_id) VALUES (?)").run(next);
      }
      // Those were the last account's workspaces. Until the renderer names this
      // account's, its notes go where they went when it last did; with nothing
      // saved, to its default private space. A workspace lost since gets a
      // Private the next successful list relocates (D18).
      const saved = next ? this._savedWorkspaceScope(next) : null;
      this.activeWorkspaceId = saved?.activeWorkspaceId ?? null;
      this.defaultWorkspaceId = saved?.defaultWorkspaceId ?? null;
    }
    this.activeAccountId = next;
  }

  setActiveWorkspaceScope({ activeWorkspaceId = null, defaultWorkspaceId = null } = {}) {
    this.activeWorkspaceId = workspaceIdOrNull(activeWorkspaceId);
    this.defaultWorkspaceId = workspaceIdOrNull(defaultWorkspaceId);
    this._saveWorkspaceScope();
  }

  // Keeps the active account's scope for its next sign-in or launch (D40).
  _saveWorkspaceScope() {
    if (!this.activeAccountId) return;
    try {
      this.db
        .prepare(
          `INSERT INTO account_workspace_scopes (account_id, active_workspace_id, default_workspace_id, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(account_id) DO UPDATE SET
             active_workspace_id = excluded.active_workspace_id,
             default_workspace_id = excluded.default_workspace_id,
             updated_at = excluded.updated_at`
        )
        .run(this.activeAccountId, this.activeWorkspaceId, this.defaultWorkspaceId);
    } catch (error) {
      debugLogger.warn("Saving the workspace scope failed", { error: error.message }, "spaces");
    }
  }

  _savedWorkspaceScope(accountId) {
    try {
      const row = this.db
        .prepare(
          "SELECT active_workspace_id, default_workspace_id FROM account_workspace_scopes WHERE account_id = ?"
        )
        .get(accountId);
      if (!row) return null;
      return {
        activeWorkspaceId: workspaceIdOrNull(row.active_workspace_id),
        defaultWorkspaceId: workspaceIdOrNull(row.default_workspace_id),
      };
    } catch (error) {
      debugLogger.warn("Reading the workspace scope failed", { error: error.message }, "spaces");
      return null;
    }
  }

  // Whose personal rows are in view. Signed out, the only account this device
  // has ever had keeps its history, words, snippets and chats; once a second
  // account has signed in here, signed out shows unattributed rows alone. New
  // rows, claims and sync belong to the signed-in account, never to this one.
  _visibleAccountId() {
    if (this.activeAccountId) return this.activeAccountId;
    const accounts = this.db.prepare("SELECT account_id FROM device_accounts LIMIT 2").all();
    return accounts.length === 1 ? accounts[0].account_id : null;
  }

  getAccountScope() {
    return { accountId: this.activeAccountId, visibleAccountId: this._visibleAccountId() };
  }

  // A dictation belongs to whoever was signed in when it was spoken, not whoever
  // is when its processing finishes. A time from before this launch (a recovered
  // recording) can't be placed, so it reads as the active account.
  _accountSpokenUnder(occurredAt) {
    const spokenAt = Date.parse(occurredAt);
    if (!(spokenAt >= this._accountTrackedSince)) return this.activeAccountId;
    const change = this._accountChanges.find(({ at }) => spokenAt < at);
    return change ? change.previous : this.activeAccountId;
  }

  // Only an account that has left counts: a guest who signs in mid-dictation,
  // or a launch that restores its account a moment late, changed nobody.
  accountChangedSince(occurredAt) {
    const spokenUnder = this._accountSpokenUnder(occurredAt);
    return spokenUnder !== null && spokenUnder !== this.activeAccountId;
  }

  // A private note or folder with no account (written signed out, or from
  // before attribution) is seen where it sits: in the stand-in while signed
  // out, in the account's own private spaces while signed in. Never in
  // another account's, and never in the stand-in once someone signs in.
  _accountScopeCondition(tableName) {
    return {
      sql: `((${tableName}.account_id IS NULL AND EXISTS (
        SELECT 1 FROM spaces account_scope_space
        WHERE account_scope_space.id = ${tableName}.space_id
          AND account_scope_space.kind = 'private'
          AND ((? IS NULL AND account_scope_space.account_id IS NULL
                AND account_scope_space.workspace_id IS NULL)
            OR account_scope_space.account_id = ?)
      )) OR ${tableName}.account_id = ? OR EXISTS (
        SELECT 1
        FROM spaces account_scope_space
        JOIN space_accounts account_scope_membership
          ON account_scope_membership.space_id = account_scope_space.id
        WHERE account_scope_space.id = ${tableName}.space_id
          AND account_scope_space.kind = 'team'
          AND account_scope_membership.account_id = ?
      ))`,
      params: [
        this.activeAccountId,
        this.activeAccountId,
        this.activeAccountId,
        this.activeAccountId,
      ],
    };
  }

  // A folder whose cloud delete is still waiting holds its rows where they
  // were. One the private-space split left in the stand-in, because several
  // accounts used it, stays within reach of each account that has a note or
  // chat in it, so that account's delete can still finish or roll back. Only
  // the delete paths ask for it.
  _folderScopeCondition(tableName, { pendingDelete = false } = {}) {
    const accountScope = this._accountScopeCondition(tableName);
    if (!pendingDelete) return accountScope;
    return {
      sql: `(${accountScope.sql} OR (${tableName}.account_id IS NULL
        AND ${tableName}.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM spaces pending_delete_space
          WHERE pending_delete_space.id = ${tableName}.space_id
            AND pending_delete_space.kind = 'private'
            AND pending_delete_space.account_id IS NULL
        ) AND (EXISTS (
          SELECT 1 FROM notes pending_delete_note
          WHERE pending_delete_note.folder_id = ${tableName}.id
            AND pending_delete_note.account_id = ?
        ) OR EXISTS (
          SELECT 1 FROM agent_conversations pending_delete_chat
          WHERE pending_delete_chat.folder_id = ${tableName}.id
            AND pending_delete_chat.account_id = ?
        ))))`,
      params: [...accountScope.params, this.activeAccountId, this.activeAccountId],
    };
  }

  // A private space belongs to its account. The stand-in has none, so what
  // is written there belongs to whoever is signed in: nobody, normally.
  _accountIdForSpace(spaceId) {
    const space = this.db.prepare("SELECT kind, account_id FROM spaces WHERE id = ?").get(spaceId);
    if (space?.kind === "team") return null;
    return space?.account_id ?? this.activeAccountId;
  }

  // Transcriptions, chats, dictionary words and snippets are personal in every
  // space: each row belongs to the account that wrote or pulled it. Rows from
  // before attribution, or written signed out, carry no account and stay
  // visible to everyone, as they always were. A word or snippet the account
  // has its own row for hides the unattributed one with the same key (one
  // added while signed out), so the account never sees, pushes or merges two.
  _ownedRowScope(tableName, alias = tableName, accountId = this._visibleAccountId()) {
    if (!PERSONAL_ROW_KEYS[tableName]) {
      return {
        sql: `(${alias}.account_id IS NULL OR ${alias}.account_id = ?)`,
        params: [accountId],
      };
    }
    return {
      sql: `(${tableName}.account_id = ? OR (${tableName}.account_id IS NULL AND NOT ${this._ownedDuplicateSql(tableName)}))`,
      params: [accountId, accountId],
    };
  }

  // Sync queues and pull merges are the signed-in account's: signed out, the
  // rows a sole account keeps in view wait for its next sign-in.
  _syncRowScope(tableName, alias = tableName) {
    return this._ownedRowScope(tableName, alias, this.activeAccountId);
  }

  // Uncorrelated, so SQLite folds the account's keys once per statement rather
  // than once per row it checks.
  _ownedDuplicateSql(tableName) {
    const key = PERSONAL_ROW_KEYS[tableName];
    return `fold_key(${tableName}.${key}) IN (SELECT fold_key(owned.${key}) FROM ${tableName} owned WHERE owned.account_id = ?)`;
  }

  // Deterministic, so SQLite may call it anywhere a built-in could go. The
  // indexes keep lower(): an index on an app-defined function would stop an
  // older build, which never registers it, from opening the database.
  _registerKeyFolding() {
    this.db.function("fold_key", { deterministic: true }, foldKey);
  }

  // Removing or renaming the account's word or snippet takes the hidden
  // signed-out copy of that key with it. Otherwise the copy would surface as
  // soon as the owned row is gone, and the next push would upload it to the
  // account's cloud. Only a copy no cloud has ever held goes.
  _dropHiddenDuplicates(tableName, keyValue) {
    const accountId = this._visibleAccountId();
    if (!accountId) return;
    const key = PERSONAL_ROW_KEYS[tableName];
    this.db
      .prepare(
        `DELETE FROM ${tableName}
         WHERE account_id IS NULL AND cloud_id IS NULL AND fold_key(${key}) = fold_key(?)
           AND ${this._ownedDuplicateSql(tableName)}`
      )
      .run(keyValue, accountId);
  }

  // Hard-deleting the account's word or snippet. A hidden copy someone's cloud
  // may hold can't be dropped, so a tombstone that nothing pushes keeps hiding
  // it. A row already tombstoned took the hidden copy with it when it was
  // removed, so one re-added since is left to surface.
  _hardDeleteKeyedRow(tableName, id, row) {
    const key = PERSONAL_ROW_KEYS[tableName];
    if (!row.deleted_at) this._dropHiddenDuplicates(tableName, row[key]);
    const hiddenCopy =
      row.account_id &&
      this.db
        .prepare(
          `SELECT 1 FROM ${tableName} WHERE account_id IS NULL AND cloud_id IS NOT NULL AND fold_key(${key}) = fold_key(?) LIMIT 1`
        )
        .get(row[key]);
    if (hiddenCopy) {
      this.db
        .prepare(
          `UPDATE ${tableName} SET deleted_at = COALESCE(deleted_at, datetime('now')), sync_status = 'synced' WHERE id = ?`
        )
        .run(id);
    } else {
      this.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
    }
  }

  // A pull that matches a word or snippet by its key rather than by id may
  // only merge into an unattributed row nobody has synced yet. One with a cloud
  // id, or from before attribution, may be another account's, and the merge
  // would move it into this one.
  _mergeableByKeySql(tableName) {
    // Signed out, a merge can only join two unattributed rows.
    if (!this.activeAccountId) return "1";
    return `(${tableName}.account_id IS NOT NULL OR (${tableName}.cloud_id IS NULL AND ${tableName}.legacy_unattributed = 0))`;
  }

  // SET clause that hands an unattributed row to the active account once it
  // syncs. Uploading a row from before attribution proves nothing about whose
  // it is on a shared device, so that one is claimed only when the account's
  // own cloud already holds it (`proven`: matched by client or cloud id). A
  // duplicate of the account's own word or snippet stays unattributed.
  _claimUnattributedSql(tableName, { proven = false, accountId = this.activeAccountId } = {}) {
    const legacy = proven
      ? ` AND ${tableName}.legacy_unattributed != ${LEGACY_UPLOADED_HERE}`
      : ` AND ${tableName}.legacy_unattributed = 0`;
    const duplicate = PERSONAL_ROW_KEYS[tableName]
      ? ` AND NOT ${this._ownedDuplicateSql(tableName)}`
      : "";
    // A push's ack is what makes a legacy row's first cloud id, so a later pull
    // matching that id proves nothing. An older cloud id still does.
    const uploaded = proven
      ? ""
      : `, legacy_unattributed = CASE WHEN ${tableName}.account_id IS NULL AND ${tableName}.legacy_unattributed = ${LEGACY_UNATTRIBUTED} AND ${tableName}.cloud_id IS NULL THEN ${LEGACY_UPLOADED_HERE} ELSE ${tableName}.legacy_unattributed END`;
    return {
      sql: `account_id = CASE WHEN ${tableName}.account_id IS NULL${legacy}${duplicate} THEN ? ELSE ${tableName}.account_id END${uploaded}`,
      params: PERSONAL_ROW_KEYS[tableName] ? [accountId, accountId] : [accountId],
    };
  }

  // Another local account has used this device if it signed in here or owns
  // anything here.
  hasOtherAccountRows() {
    if (!this.activeAccountId) return false;
    const tables = [...ACCOUNT_OWNED_TABLES, "device_accounts"];
    return Boolean(
      this.db
        .prepare(
          `${tables
            .map((table) => `SELECT 1 FROM ${table} WHERE account_id != ?`)
            .join(" UNION ALL ")} LIMIT 1`
        )
        .get(...tables.map(() => this.activeAccountId))
    );
  }

  // Signing in writes no row, so an account that came and went with nothing to
  // show is known only by this record. Accounts from before it existed are
  // known by their rows.
  _initDeviceAccounts() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_accounts (
        account_id TEXT PRIMARY KEY,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const table of ACCOUNT_OWNED_TABLES) {
      this.db.exec(
        `INSERT OR IGNORE INTO device_accounts (account_id)
         SELECT DISTINCT account_id FROM ${table} WHERE account_id IS NOT NULL`
      );
    }
  }

  // Each account's last workspace scope main accepted (D40), so a launch with
  // no control panel files notes where that account's workspace shows them.
  _initWorkspaceScopes() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_workspace_scopes (
        account_id TEXT PRIMARY KEY,
        active_workspace_id TEXT,
        default_workspace_id TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  // Signed-out rows normally join an account when they sync. These never sync
  // (failed or empty dictations, container chats), so they join at sign-in or
  // they'd stay visible to every later account.
  claimSignedOutLocalRows() {
    if (!this.activeAccountId) return;
    this.db
      .prepare(
        `UPDATE transcriptions SET account_id = ?
         WHERE account_id IS NULL AND legacy_unattributed = 0
           AND (status = 'failed' OR TRIM(COALESCE(text, '')) = '')`
      )
      .run(this.activeAccountId);
    this.db
      .prepare(
        `UPDATE agent_conversations SET account_id = ?
         WHERE account_id IS NULL AND legacy_unattributed = 0
           AND (space_id IS NOT NULL OR folder_id IS NOT NULL)`
      )
      .run(this.activeAccountId);
  }

  // With nobody else on this device, a row from before attribution that no cloud
  // holds can only be this account's, and nothing else could ever prove it. A row
  // with a cloud id waits for its own cloud to prove it, in case another account
  // left no other trace here. A twin of the account's own word or snippet stays
  // hidden. A twin of an unattributed one a cloud holds waits with it: claimed
  // first, it would hide that row from the pull that proves it.
  claimLegacyRowsOfOnlyAccount() {
    if (!this.activeAccountId || this.hasOtherAccountRows()) return;
    this.db.transaction(() => {
      for (const table of PERSONAL_ROW_TABLES) {
        const key = PERSONAL_ROW_KEYS[table];
        const noTwin = key
          ? `AND NOT ${this._ownedDuplicateSql(table)}
               AND fold_key(${table}.${key}) NOT IN (
                 SELECT fold_key(synced.${key}) FROM ${table} synced
                 WHERE synced.account_id IS NULL AND synced.cloud_id IS NOT NULL
               )`
          : "";
        this.db
          .prepare(
            `UPDATE ${table} SET account_id = ?
             WHERE account_id IS NULL AND legacy_unattributed != 0 AND cloud_id IS NULL
               ${noTwin}`
          )
          .run(this.activeAccountId, ...(key ? [this.activeAccountId] : []));
      }
    })();
  }

  // Rows from before attribution whose cloud copy could prove their owner.
  hasUnclaimedLegacyRows() {
    return Boolean(
      this.db
        .prepare(
          `${PERSONAL_ROW_TABLES.map(
            (table) =>
              `SELECT 1 FROM ${table} WHERE account_id IS NULL AND legacy_unattributed = ${LEGACY_UNATTRIBUTED} AND cloud_id IS NOT NULL`
          ).join(" UNION ALL ")} LIMIT 1`
        )
        .get()
    );
  }

  // A cloud row may only land on a local row this account can see. Another
  // account's row with the same client id stays as it is, and the pull skips it.
  _ownedByOtherAccount(row, accountId = this.activeAccountId) {
    return Boolean(row?.account_id && row.account_id !== accountId);
  }

  _initPersonalRowAccounts() {
    for (const table of PERSONAL_ROW_TABLES) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`);
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        // One step: a column added without its backfill is never backfilled,
        // since the next launch sees it and moves on.
        this.db.transaction(() => {
          this.db.exec(
            `ALTER TABLE ${table} ADD COLUMN legacy_unattributed INTEGER NOT NULL DEFAULT 0`
          );
          // Every row already here predates attribution, so its owner is unknown.
          this.db.exec(
            `UPDATE ${table} SET legacy_unattributed = ${LEGACY_UNATTRIBUTED} WHERE account_id IS NULL`
          );
        })();
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
    }

    // custom_dictionary was created with a column-level UNIQUE(word), which
    // SQLite can only drop by rebuilding the table. Every later column was
    // appended to the stored CREATE statement, so the copy keeps all of them.
    const autoIndex = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND tbl_name = 'custom_dictionary' AND name LIKE 'sqlite_autoindex_custom_dictionary%'"
      )
      .get();
    if (autoIndex) {
      const { sql } = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'custom_dictionary'"
        )
        .get();
      const rebuiltSql = sql
        .replace(/\bword\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i, "word TEXT NOT NULL")
        .replace(
          /CREATE TABLE\s+(IF NOT EXISTS\s+)?"?custom_dictionary"?/i,
          "CREATE TABLE custom_dictionary_rebuild"
        );
      // An unrecognized schema keeps the device-wide UNIQUE(word) rather than
      // failing the database open; two accounts then can't share a word.
      if (rebuiltSql === sql || /\bUNIQUE\b/i.test(rebuiltSql)) {
        debugLogger.error(
          "custom_dictionary has an unexpected schema; keeping UNIQUE(word)",
          {},
          "database"
        );
      } else {
        this._rebuildDictionaryWithoutWordUnique(rebuiltSql);
      }
    }
    for (const table of PERSONAL_ROW_TABLES) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_account_id ON ${table}(account_id)`);
    }
    // Every list read checks each unattributed row against the account's own.
    for (const [table, key] of Object.entries(PERSONAL_ROW_KEYS)) {
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_${table}_account_lower_${key} ON ${table}(account_id, lower(${key}))`
      );
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_dictionary_account_word ON custom_dictionary(COALESCE(account_id, ''), word)"
    );
  }

  // Drops the table's own trigger and indexes; the caller and initDatabase
  // recreate them right after.
  _rebuildDictionaryWithoutWordUnique(rebuiltSql) {
    const sequence = this.db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'custom_dictionary'")
      .get();
    this.db.transaction(() => {
      this.db.exec(rebuiltSql);
      this.db.exec("INSERT INTO custom_dictionary_rebuild SELECT * FROM custom_dictionary");
      this.db.exec("DROP TABLE custom_dictionary");
      this.db.exec("ALTER TABLE custom_dictionary_rebuild RENAME TO custom_dictionary");
      // Keep AUTOINCREMENT from reusing the ids of words deleted before.
      if (sequence) {
        this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'custom_dictionary'").run();
        this.db
          .prepare(
            "INSERT INTO sqlite_sequence (name, seq) VALUES ('custom_dictionary', MAX(?, (SELECT COALESCE(MAX(id), 0) FROM custom_dictionary)))"
          )
          .run(sequence.seq);
      }
    })();
  }

  _getFolderInAccountScope(id, { pendingDelete = false } = {}) {
    const folderScope = this._folderScopeCondition("folders", { pendingDelete });
    return (
      this.db
        .prepare(`SELECT * FROM folders WHERE id = ? AND ${folderScope.sql}`)
        .get(id, ...folderScope.params) || null
    );
  }

  // Child notes owned by another local account are invisible to the active
  // scope, so a folder removal must release them to the space root — never
  // delete them (or their conversations, speaker rows, or cloud tombstones)
  // with the folder. Run this before any statement that targets the folder's
  // children, so plain `folder_id = ?` filters only ever see in-scope rows.
  _releaseOutOfScopeChildNotes(folderId) {
    const accountScope = this._accountScopeCondition("notes");
    const outOfScopeIds = this.db
      .prepare(
        `SELECT id FROM notes
         WHERE folder_id = ? AND id NOT IN (
           SELECT id FROM notes WHERE folder_id = ? AND ${accountScope.sql}
         )`
      )
      .all(folderId, folderId, ...accountScope.params)
      .map((row) => row.id);
    if (outOfScopeIds.length === 0) return [];
    const placeholders = outOfScopeIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE notes
         SET folder_id = NULL, sync_status = 'pending', updated_at = datetime('now')
         WHERE id IN (${placeholders})`
      )
      .run(...outOfScopeIds);
    return this.db
      .prepare(`SELECT * FROM notes WHERE id IN (${placeholders})`)
      .all(...outOfScopeIds);
  }

  _releaseActiveSpaceMembershipIfShared(spaceId) {
    if (!this.activeAccountId) return false;
    const otherMembership = this.db
      .prepare(
        `SELECT 1 FROM space_accounts
         WHERE space_id = ? AND account_id != ?
         LIMIT 1`
      )
      .get(spaceId, this.activeAccountId);
    if (!otherMembership) return false;
    this.db
      .prepare("DELETE FROM space_accounts WHERE space_id = ? AND account_id = ?")
      .run(spaceId, this.activeAccountId);
    return true;
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);
      this._registerKeyFolding();
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
      // Records the dictation intent (e.g. "translation") so retry/recover re-runs the same route.
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN route_kind TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS snippets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL,
          replacement TEXT NOT NULL,
          client_snippet_id TEXT,
          cloud_id TEXT,
          sync_status TEXT DEFAULT 'pending',
          deleted_at TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // A skill's content is its folder under userData/skills; this keeps its on/off state.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          content_hash TEXT,
          last_used_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        this.db.exec("ALTER TABLE notes ADD COLUMN enhancement_template_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      let addedSyncOperations = false;
      for (const definition of [
        "cloud_revision INTEGER",
        "cloud_create_rejected INTEGER NOT NULL DEFAULT 0",
        "cloud_create_pending TEXT",
        "content_sync_operation TEXT",
        "enhanced_content_sync_operation TEXT",
        "content_edit_generation INTEGER NOT NULL DEFAULT 0",
        "enhanced_content_edit_generation INTEGER NOT NULL DEFAULT 0",
      ]) {
        try {
          this.db.exec(`ALTER TABLE notes ADD COLUMN ${definition}`);
          if (definition.startsWith("content_sync_operation")) addedSyncOperations = true;
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      if (addedSyncOperations) this._markUnsyncedNoteTextAsSet();
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
        seedFolder.run("Videos", 2);
      }

      // Backfill folder_id only when the column is first added: on later
      // launches a NULL folder_id is a legitimate space-root note, not a
      // pre-folders row.
      let folderColumnAdded = true;
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN folder_id INTEGER REFERENCES folders(id)");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
        folderColumnAdded = false;
      }

      if (folderColumnAdded) {
        const personalFolder = this.db
          .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
          .get();
        if (personalFolder) {
          this.db
            .prepare("UPDATE notes SET folder_id = ? WHERE folder_id IS NULL")
            .run(personalFolder.id);
        }
      }

      // One-time seed (user_version 1): a pre-existing user-created "Videos"
      // folder stays untouched (never promoted to default); URL downloads route
      // to it by name. Guarded so a later delete/rename doesn't resurrect it as
      // an undeletable default on the next launch.
      if (this.db.pragma("user_version", { simple: true }) < 1) {
        const videosFolder = this.db.prepare("SELECT id FROM folders WHERE name = 'Videos'").get();
        if (!videosFolder) {
          const maxOrder = this.db.prepare("SELECT MAX(sort_order) as m FROM folders").get();
          this.db
            .prepare(
              "INSERT OR IGNORE INTO folders (name, is_default, sort_order) VALUES ('Videos', 1, ?)"
            )
            .run((maxOrder?.m ?? 1) + 1);
        }
        this.db.pragma("user_version = 1");
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
      // Every row before these columns rewrote the AI summary from the note's
      // material, which is what a template does, so 'template' is the default.
      for (const column of [
        "client_id TEXT",
        "kind TEXT NOT NULL DEFAULT 'template'",
        "sections TEXT",
        "output TEXT",
      ]) {
        try {
          this.db.exec(`ALTER TABLE actions ADD COLUMN ${column}`);
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
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
      // Receipts for agent connector actions. Never holds message content:
      // destination labels, states and result links only.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS connector_actions (
          id TEXT PRIMARY KEY,
          account_id TEXT,
          connector TEXT NOT NULL,
          action TEXT NOT NULL,
          kind TEXT NOT NULL,
          destination_label TEXT,
          state TEXT NOT NULL,
          result_url TEXT,
          error_code TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_connector_actions_connector ON connector_actions(connector, created_at)"
      );
      // Destination labels name channels and people in someone's workspace,
      // so a receipt belongs to the OpenWhispr account that made it. Tables
      // created before the column existed gain it here.
      try {
        this.db.exec("ALTER TABLE connector_actions ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_connector_actions_account ON connector_actions(account_id, connector, created_at)"
      );
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
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN folder_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_container ON agent_conversations(space_id, folder_id)"
      );
      // A fork records the chat it was copied from, here and by the client id
      // every device shares, how many of its first messages it copied and the
      // text it was forked with. All but the local parent id sync.
      for (const column of [
        "parent_conversation_id INTEGER",
        "parent_client_conversation_id TEXT",
        "fork_message_count INTEGER",
        "fork_context TEXT",
      ]) {
        try {
          this.db.exec(`ALTER TABLE agent_conversations ADD COLUMN ${column}`);
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      const builtinKeys = [
        ...BUILTIN_ACTIONS.map((action) => action.translationKey),
        LEGACY_DETAILED_NOTES.translationKey,
      ];
      this.db.transaction(() => {
        // Older builds rename unfamiliar keys. Recover even the retired key
        // before the unknown-key fallback can turn it into a second AI Summary.
        this.db
          .prepare(
            `UPDATE actions SET translation_key = client_id WHERE is_builtin = 1 AND client_id IN (${builtinKeys.map(() => "?").join(", ")}) AND translation_key IS NOT client_id`
          )
          .run(...builtinKeys);

        const hasStockContent = (row, action) => {
          if (row.sections === null) return action.previousPrompts.includes(row.prompt);
          if (row.prompt !== action.prompt) return false;
          try {
            return isDeepStrictEqual(JSON.parse(row.sections), action.sections);
          } catch {
            // Unrecognized data may be a customization; keep it.
            return false;
          }
        };
        // A customized AI Summary isn't the detailed template, so Detailed Notes stays.
        const summaryRow = this.db
          .prepare(
            "SELECT prompt, sections FROM actions WHERE is_builtin = 1 AND translation_key = ?"
          )
          .get(GENERATE_NOTES_KEY);
        const summaryIsStock =
          !summaryRow ||
          hasStockContent(
            summaryRow,
            BUILTIN_ACTIONS.find((action) => action.translationKey === GENERATE_NOTES_KEY)
          );

        const legacyRows = this.db
          .prepare("SELECT * FROM actions WHERE is_builtin = 1 AND translation_key = ?")
          .all(LEGACY_DETAILED_NOTES.translationKey);
        const deleteLegacy = this.db.prepare("DELETE FROM actions WHERE id = ?");
        const settleLegacy = this.db.prepare(
          "UPDATE OR IGNORE actions SET client_id = COALESCE(client_id, ?), sort_order = ?, prompt = ?, sections = ? WHERE id = ?"
        );
        for (const row of legacyRows) {
          const stockContent = hasStockContent(row, LEGACY_DETAILED_NOTES);
          if (
            summaryIsStock &&
            stockContent &&
            row.name === LEGACY_DETAILED_NOTES.name &&
            row.description === LEGACY_DETAILED_NOTES.description &&
            row.icon === LEGACY_DETAILED_NOTES.icon
          ) {
            deleteLegacy.run(row.id);
          } else {
            // A previous flat default still moves to sections, keeping the user's name.
            const upgradesPrompt = stockContent && row.sections === null;
            settleLegacy.run(
              LEGACY_DETAILED_NOTES.translationKey,
              LEGACY_DETAILED_NOTES.sortOrder,
              upgradesPrompt ? LEGACY_DETAILED_NOTES.prompt : row.prompt,
              upgradesPrompt ? JSON.stringify(LEGACY_DETAILED_NOTES.sections) : row.sections,
              row.id
            );
          }
        }

        // Pre-2026 installs carry the default under an older key.
        this.db
          .prepare(
            `UPDATE actions SET translation_key = ? WHERE is_builtin = 1 AND (translation_key IS NULL OR translation_key NOT IN (${builtinKeys.map(() => "?").join(", ")}))`
          )
          .run(GENERATE_NOTES_KEY, ...builtinKeys);
      })();

      // Built-ins: insert any that are missing, and roll a new default out to rows
      // that are still a previous flat default (never a user edit). A built-in's
      // kind and destination are fixed, regardless of prompt edits.
      const selectBuiltin = this.db.prepare(
        "SELECT id, name, description, prompt, sections FROM actions WHERE is_builtin = 1 AND translation_key = ?"
      );
      const insertBuiltin = this.db.prepare(
        "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key, client_id, kind, sections, output) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)"
      );
      const upgradeBuiltin = this.db.prepare(
        "UPDATE actions SET prompt = ?, sections = ? WHERE id = ?"
      );
      const settleBuiltin = this.db.prepare(
        "UPDATE actions SET client_id = ?, kind = ?, sort_order = ?, output = ?, name = ?, description = ?, icon = ? WHERE id = ?"
      );
      for (const action of BUILTIN_ACTIONS) {
        const sections = action.sections ? JSON.stringify(action.sections) : null;
        const existing = selectBuiltin.get(action.translationKey);
        if (!existing) {
          insertBuiltin.run(
            action.name,
            action.description,
            action.prompt,
            action.icon,
            action.sortOrder,
            action.translationKey,
            action.translationKey,
            action.kind,
            sections,
            action.output
          );
          continue;
        }
        const upgradesPrompt =
          existing.sections === null && action.previousPrompts.includes(existing.prompt);
        if (upgradesPrompt) {
          upgradeBuiltin.run(action.prompt, sections, existing.id);
        }
        settleBuiltin.run(
          action.translationKey,
          action.kind,
          action.sortOrder,
          action.output,
          action.previousNames?.includes(existing.name) ? action.name : existing.name,
          (
            action.previousDescriptions?.length
              ? action.previousDescriptions.includes(existing.description)
              : upgradesPrompt
          )
            ? action.description
            : existing.description,
          action.icon,
          existing.id
        );
      }

      const actionsWithoutClientId = this.db
        .prepare("SELECT id FROM actions WHERE client_id IS NULL")
        .all();
      const setActionClientId = this.db.prepare("UPDATE actions SET client_id = ? WHERE id = ?");
      for (const row of actionsWithoutClientId) setActionClientId.run(randomUUID(), row.id);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_client_id ON actions(client_id) WHERE client_id IS NOT NULL"
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
          sync_token_expires_at INTEGER,
          account_email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE google_calendars ADD COLUMN account_email TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE google_calendars ADD COLUMN sync_token_expires_at INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec(
          "ALTER TABLE google_calendars ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS microsoft_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          microsoft_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE microsoft_calendar_tokens ADD COLUMN tenant_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE microsoft_calendar_tokens ADD COLUMN own_addresses TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS microsoft_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sync_token TEXT,
          sync_token_expires_at INTEGER,
          account_email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // One-time reset (user_version 2): pre-fix builds stored recurring
      // occurrences untitled when the series-master fetch failed, and delta
      // never re-delivers them; a forced full sync re-fetches them fixed.
      if (this.db.pragma("user_version", { simple: true }) < 2) {
        this.db.exec(
          "UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL"
        );
        this.db.pragma("user_version = 2");
      }

      // One-time reset (user_version 3): older builds stored rooms without a
      // resource flag, and incremental syncs never resend unchanged events; a
      // forced full sync stores them flagged, purges the rooms those builds
      // wrote to contacts and tags the contacts it sees with their source.
      if (this.db.pragma("user_version", { simple: true }) < 3) {
        this.db.exec("UPDATE google_calendars SET sync_token = NULL, sync_token_expires_at = NULL");
        this.db.exec(
          "UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL"
        );
        this.db.pragma("user_version = 3");
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
          availability_status TEXT NOT NULL DEFAULT 'unknown',
          self_response_status TEXT NOT NULL DEFAULT 'unknown',
          hangout_link TEXT,
          conference_data TEXT,
          organizer_email TEXT,
          attendees_count INTEGER DEFAULT 0,
          synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec(
          "ALTER TABLE calendar_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      let availabilitySchemaChanged = false;
      for (const column of ["availability_status", "self_response_status"]) {
        try {
          this.db.exec(
            `ALTER TABLE calendar_events ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'unknown'`
          );
          availabilitySchemaChanged = true;
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      if (availabilitySchemaChanged) {
        // Existing incremental tokens will not resend unchanged free/declined
        // events, so rebuild both REST caches once with the new semantics.
        this.db
          .prepare("UPDATE google_calendars SET sync_token = NULL, sync_token_expires_at = NULL")
          .run();
        this.db
          .prepare("UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL")
          .run();
      }

      // One-time reset (user_version 4): older builds took a shared Google
      // calendar owner's RSVP as the connected user's; clear those cached
      // responses and force a full sync of those calendars.
      if (this.db.pragma("user_version", { simple: true }) < 4) {
        this.db.exec(`
          UPDATE calendar_events SET self_response_status = 'unknown'
          WHERE provider = 'google' AND NOT EXISTS (
            SELECT 1 FROM google_calendars c
            WHERE c.id = calendar_events.calendar_id
              AND (c.is_primary = 1 OR c.id = c.account_email)
          );
          UPDATE google_calendars SET sync_token = NULL, sync_token_expires_at = NULL
          WHERE is_primary = 0 AND (account_email IS NULL OR id != account_email);
        `);
        this.db.pragma("user_version = 4");
      }

      // One-time reset (user_version 5): the stored lookback widened to
      // CALENDAR_LOOKBACK_DAYS so notes can link recent past events, and REST
      // sync tokens pin the window they were created with. The full sync also
      // fills calendar_events.web_link.
      if (this.db.pragma("user_version", { simple: true }) < 5) {
        this.db.exec(`
          UPDATE google_calendars SET sync_token = NULL, sync_token_expires_at = NULL;
          UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL;
        `);
        this.db.pragma("user_version = 5");
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS apple_calendars (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          color TEXT,
          source_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      // The event's page in Google Calendar or Outlook on the web; Apple has
      // none. The user_version 5 full sync fills it for rows in the sync window.
      try {
        this.db.exec("ALTER TABLE calendar_events ADD COLUMN web_link TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN participants TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN diarization_enabled INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN expected_speaker_count INTEGER");
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

      // Every source (see contactSource) that has seen a contact, so a
      // disconnect only removes people no other source still has. Rows older
      // builds stored have none.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS contact_sources (
          email TEXT NOT NULL REFERENCES contacts(email) ON DELETE CASCADE,
          source TEXT NOT NULL,
          PRIMARY KEY (email, source)
        )
      `);
      // Pre-release builds kept a single source in contacts.source.
      if (this.db.pragma("table_info(contacts)").some((column) => column.name === "source")) {
        this.db.exec(
          "INSERT OR IGNORE INTO contact_sources (email, source) SELECT email, source FROM contacts WHERE source IS NOT NULL"
        );
        this.db.exec("UPDATE contacts SET source = NULL WHERE source IS NOT NULL");
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          email TEXT,
          embedding BLOB NOT NULL,
          embedding_version INTEGER,
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
          embedding_version INTEGER,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
      `);

      // A cloud folder delete is optimistic until the API answers. Keep the
      // exact pre-delete row state in a durable journal so a permission denial
      // can revive the same folder, notes, speakers, and conversations even
      // after an app restart. Content stays in its owning tables; the journal
      // contains only identity and sync metadata.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS optimistic_folder_delete_rows (
          folder_id INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          original_sync_status TEXT,
          original_deleted_at TEXT,
          original_updated_at TEXT,
          PRIMARY KEY (folder_id, entity_type, entity_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_optimistic_folder_delete_entity ON optimistic_folder_delete_rows(entity_type, entity_id)"
      );

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
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN share_token TEXT");
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

      // Set just before a create request is sent, so a create whose reply never
      // arrives still counts as one the server may hold. A create that failed
      // before this column existed counts too.
      let addedCreateAttempts = false;
      for (const table of ["notes", "agent_conversations"]) {
        try {
          this.db.exec(
            `ALTER TABLE ${table} ADD COLUMN cloud_create_attempted INTEGER NOT NULL DEFAULT 0`
          );
          addedCreateAttempts = true;
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      if (addedCreateAttempts) {
        this.db.exec(
          "UPDATE notes SET cloud_create_attempted = 1 WHERE cloud_id IS NULL AND sync_status = 'error'"
        );
        this._removeNeverSyncedTombstones();
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

      // Sync columns for custom_dictionary
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN client_dict_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE custom_dictionary ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN updated_at DATETIME");
        this.db.exec(
          "UPDATE custom_dictionary SET updated_at = created_at WHERE updated_at IS NULL"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // Set when the word was shared into a team list. The row stays live as
      // the sharer's own fallback, so sharing can never lose a word.
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN shared_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // 1 while a local set or clear of shared_at awaits its push. Only then
      // does the push send shared_at: another device may have set it meanwhile.
      try {
        this.db.exec(
          "ALTER TABLE custom_dictionary ADD COLUMN shared_at_dirty INTEGER NOT NULL DEFAULT 0"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // 1 on a moved word's tombstone written because its shared copy went
      // (retireMovedDictionaryWords), so a restore or un-hide can revive it.
      try {
        this.db.exec(
          "ALTER TABLE custom_dictionary ADD COLUMN fallback_retired INTEGER NOT NULL DEFAULT 0"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Local mirror of the workspaces' shared lists. A hides row means the
      // member hid that entry; a visible entry has no row.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shared_dictionary_entries (
          cloud_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          space_id TEXT,
          word TEXT NOT NULL,
          added_by_user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_shared_dictionary_entries_workspace
          ON shared_dictionary_entries(workspace_id);
        CREATE TABLE IF NOT EXISTS shared_dictionary_hides (
          entry_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_shared_dictionary_hides_workspace
          ON shared_dictionary_hides(workspace_id);
        CREATE TABLE IF NOT EXISTS shared_dictionary_meta (
          workspace_id TEXT PRIMARY KEY,
          scopes_json TEXT NOT NULL,
          contributors_json TEXT NOT NULL,
          paused INTEGER NOT NULL,
          synced_at TEXT NOT NULL
        );
      `);

      // Backfill client IDs for existing rows
      const syncTables = [
        { table: "notes", col: "client_note_id" },
        { table: "folders", col: "client_folder_id" },
        { table: "agent_conversations", col: "client_conversation_id" },
        { table: "transcriptions", col: "client_transcription_id" },
        { table: "custom_dictionary", col: "client_dict_id" },
        { table: "snippets", col: "client_snippet_id" },
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

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS analytics_events (
          event_id TEXT PRIMARY KEY,
          account_id TEXT,
          occurred_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          word_count INTEGER NOT NULL CHECK (word_count > 0),
          spoken_duration_ms INTEGER,
          mode TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          counter_version INTEGER NOT NULL DEFAULT 1,
          sync_status TEXT NOT NULL DEFAULT 'pending',
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_events_account_date
          ON analytics_events(account_id, local_date);
        CREATE TABLE IF NOT EXISTS analytics_clear_requests (
          account_id TEXT PRIMARY KEY,
          cleared_through TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS analytics_device_clear_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          cleared_through TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS analytics_account_clear_state (
          account_scope TEXT PRIMARY KEY,
          cleared_through TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS analytics_history_backfill_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          scanned_through_transcription_id INTEGER NOT NULL DEFAULT 0
            CHECK (scanned_through_transcription_id >= 0)
        );
      `);
      // Repair databases created before analytics deletion tombstones were
      // introduced. SQLite has no ADD COLUMN IF NOT EXISTS syntax.
      try {
        this.db.exec("ALTER TABLE analytics_events ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this._initPersonalRowAccounts();
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_dictionary_client_id ON custom_dictionary(client_dict_id)"
      );
      // Cloud batch-create matches responses by client_dict_id, so a row
      // without one can never be marked synced and re-uploads every pass. Rows
      // written straight to SQLite don't set it (#1295), so the schema does.
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS custom_dictionary_client_id_default
        AFTER INSERT ON custom_dictionary
        WHEN new.client_dict_id IS NULL
        BEGIN
          UPDATE custom_dictionary SET client_dict_id =
            lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
            substr(lower(hex(randomblob(2))), 2) || '-' ||
            substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) ||
            '-' || lower(hex(randomblob(6)))
          WHERE id = new.id;
        END
      `);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_client_id ON snippets(client_snippet_id) WHERE client_snippet_id IS NOT NULL"
      );
      // An active trigger is unique per account, not per device: two accounts
      // on one machine may each keep their own "addr". The index keeps its
      // device-wide name so an older build's CREATE UNIQUE INDEX IF NOT EXISTS
      // finds it and skips, instead of failing to open the database.
      const triggerIndex = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_snippets_trigger_lower_active'"
        )
        .get();
      if (triggerIndex && !triggerIndex.sql.includes("account_id")) {
        this.db.exec("DROP INDEX idx_snippets_trigger_lower_active");
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_lower_active ON snippets(COALESCE(account_id, ''), lower(trigger)) WHERE deleted_at IS NULL"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_snippets_pending_sync ON snippets(sync_status) WHERE sync_status = 'pending'"
      );

      // A team space mirrors a cloud space. A private space never leaves the
      // device: there is one per account and workspace (account_id and
      // workspace_id, added below). The private row with neither is the
      // signed-out stand-in; an account's row with no workspace holds its
      // notes until its default workspace is known.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS spaces (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          client_space_id TEXT,
          cloud_team_id   TEXT,
          workspace_id    TEXT,
          kind            TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('private','team')),
          name            TEXT NOT NULL,
          emoji           TEXT,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          my_role         TEXT,
          member_count    INTEGER,
          sync_status     TEXT NOT NULL DEFAULT 'pending',
          deleted_at      TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_client_space_id ON spaces(client_space_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_team_id ON spaces(cloud_team_id) WHERE cloud_team_id IS NOT NULL"
      );

      // First-class spaces: a space mirrors a cloud space with one or more
      // assigned teams. cloud_team_id survives only so pre-spaces rows can be
      // adopted by upsertSpaceFromCloud (matched via the space's single
      // backfilled team).
      try {
        this.db.exec("ALTER TABLE spaces ADD COLUMN cloud_space_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        // JSON array of { id, name, my_role } mirrored from GET /api/me/spaces.
        this.db.exec("ALTER TABLE spaces ADD COLUMN teams TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        // Direct space_members grant ('admin' | 'member'), distinct from the
        // effective my_role: it decides whether the user can leave the space.
        this.db.exec("ALTER TABLE spaces ADD COLUMN my_direct_role TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        // JSON object of server-computed capabilities (edit_notes, manage_members,
        // manage_settings, leave) mirrored from GET /api/me/spaces; NULL from
        // an older API, so callers fall back to the role.
        this.db.exec("ALTER TABLE spaces ADD COLUMN capabilities TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_space_id ON spaces(cloud_space_id) WHERE cloud_space_id IS NOT NULL"
      );
      try {
        this.db.exec("ALTER TABLE spaces ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_private_identity ON spaces(COALESCE(account_id, ''), COALESCE(workspace_id, '')) WHERE kind = 'private' AND deleted_at IS NULL"
      );
      try {
        // Marks the account's default private space once its default workspace
        // is bound, so it is found again after the account changes, before the
        // renderer names the workspace.
        this.db.exec("ALTER TABLE spaces ADD COLUMN is_default_private INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_private_default ON spaces(account_id) WHERE kind = 'private' AND is_default_private = 1 AND deleted_at IS NULL"
      );

      if (this._standInPrivateSpaceId() == null) {
        this.db
          .prepare(
            "INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status) VALUES (?, 'private', 'Personal', 0, 'synced')"
          )
          .run(randomUUID());
      }

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Rebuild folders to drop the table-level UNIQUE(name); per-space name
      // uniqueness is enforced by idx_folders_space_legacy_name and
      // idx_folders_space_account_name below.
      // better-sqlite3 enables foreign_keys by default, so DROP TABLE folders
      // would fail while notes.folder_id rows reference it; the pragma is a
      // no-op inside a transaction, so toggle it around the rebuild.
      const foldersTable = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
        .get();
      if (foldersTable?.sql.includes("UNIQUE")) {
        const foreignKeysWereOn = this.db.pragma("foreign_keys", { simple: true }) === 1;
        this.db.pragma("foreign_keys = OFF");
        try {
          this.db.transaction(() => {
            this.db.exec(`
            CREATE TABLE folders_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              is_default INTEGER NOT NULL DEFAULT 0,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              client_folder_id TEXT,
              cloud_id TEXT,
              sync_status TEXT DEFAULT 'pending',
              deleted_at TEXT,
              space_id INTEGER
            )
          `);
            this.db.exec(`
            INSERT INTO folders_new (id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id)
            SELECT id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id
            FROM folders
          `);
            this.db.exec("DROP TABLE folders");
            this.db.exec("ALTER TABLE folders_new RENAME TO folders");
            this.db.exec(
              "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
            );
          })();
        } finally {
          if (foreignKeysWereOn) this.db.pragma("foreign_keys = ON");
        }
      }
      const standInId = this._standInPrivateSpaceId();
      this.db.prepare("UPDATE folders SET space_id = ? WHERE space_id IS NULL").run(standInId);
      this.db.prepare("UPDATE notes SET space_id = ? WHERE space_id IS NULL").run(standInId);

      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notes_space_updated ON notes(space_id, updated_at)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_folders_space_sort ON folders(space_id, sort_order)"
      );

      // Account attribution is intentionally nullable. Existing rows remain
      // device-owned legacy content; workspace rows are never attributed to a
      // personal account and therefore cannot be erased with that account.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_account_id ON notes(account_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_cloud_id ON notes(cloud_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_folders_account_id ON folders(account_id)");
      // Builds before per-account folders kept names unique per space alone,
      // which fails once two accounts' default folders share a space; never
      // re-create it, or launch fails on such a database.
      this.db.exec("DROP INDEX IF EXISTS idx_folders_space_name");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_legacy_name ON folders(space_id, name) WHERE deleted_at IS NULL AND account_id IS NULL"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_account_name ON folders(space_id, account_id, name) WHERE deleted_at IS NULL AND account_id IS NOT NULL"
      );

      // One-time split (user_version 6): each account's private notes leave
      // the shared private row for the account's own. A failure leaves the
      // database as it was and the next launch tries again; it must never keep
      // the notes database from opening. So every later user_version step must
      // also require version 6 (`>= 6 && < N`), never a bare `< N`: on a device
      // whose split failed it would set N and the split would never run again
      // (test/helpers/databaseUserVersionSteps.test.js).
      if (this.db.pragma("user_version", { simple: true }) < 6) {
        try {
          this._splitPrivateSpaceByAccount();
        } catch (error) {
          debugLogger.error(
            "Splitting the private space by account failed",
            { error: error.message },
            "database"
          );
        }
      }

      // A cloud space is workspace-owned, while visibility is account-specific.
      // Keep the many-to-many membership separate so signing out one local
      // account cannot delete or expose another account's workspace cache.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS space_accounts (
          space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (space_id, account_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_space_accounts_account_id ON space_accounts(account_id)"
      );
      this._initDeviceAccounts();
      this._initWorkspaceScopes();

      // Cloud-backed rows that just LEFT a team must keep pushing their scope
      // retraction (D6) even in the backup-off team-only pass, where the
      // pending queues otherwise filter on the row's CURRENT space kind.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN left_team INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN left_team INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Last cloud editor (CloudNote.updated_by_user_id); only populated on
      // cloud pull — local edits don't set it. Resolved to a display name via
      // the team roster when rendering note authorship.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN updated_by_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Server updated_at this device last acked (push response or pull),
      // echoed verbatim as base_updated_at on the next PATCH so the server can
      // 409 a stale overwrite. Local edits never touch it; NULL means the note
      // predates the guard and pushes last-write-wins once.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN cloud_updated_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // The note's owner (CloudNote.user_id) — who created it, not who last
      // edited it (updated_by_user_id). Drives the client-side delete/scope
      // permission checks; NULL until a cloud pull or push response fills it.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN owner_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN created_by_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Speaker-embedding schema version. Rows written before this column existed
      // predate the Kaldi/CMN fbank fix, so their embeddings live in an
      // incompatible space; leaving the column NULL marks them stale so matching
      // skips them until the speaker is re-enrolled (see EMBEDDING_VERSION).
      try {
        this.db.exec("ALTER TABLE speaker_profiles ADD COLUMN embedding_version INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE note_speaker_embeddings ADD COLUMN embedding_version INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Space vector purges owed to Qdrant while the sidecar was down/booting;
      // drained on the next semantic search activation.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_vector_purges (
          space_id   INTEGER PRIMARY KEY,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this._initVectorChangeJournal();
      try {
        noteUndo.initializeNoteUndo(this.db);
        this.noteUndoReady = true;
      } catch (error) {
        // Undo is a convenience: it must never keep the notes database from
        // opening. Without it, assistant edits save as plain updates.
        debugLogger.error("Assistant note Undo unavailable", { error: error.message }, "database");
      }
      try {
        this.mergedNoteIds = this.mergeDuplicateCloudNotes();
      } catch (error) {
        debugLogger.error("Merging note copies failed", { error: error.message }, "database");
      }

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
      routeKind = null,
      clientTranscriptionId = randomUUID(),
      analyticsOccurredAt = null,
    } = {}
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      // With an occurrence time this column carries when the dictation was
      // spoken rather than when the row was written -- earlier by the length
      // of the recording plus transcription. History reads it through
      // normalizeDbDate, which already branches on a trailing zone.
      // Keep the existing SQLite-friendly separator so mixed old/new rows
      // continue to sort chronologically, while the trailing Z marks this as
      // an exact client-captured instant for clear-state reconciliation.
      const occurredAt = toDbTimestamp(analyticsOccurredAt);
      const stmt = this.db.prepare(
        `INSERT INTO transcriptions (
           text, raw_text, status, error_message, error_code, route_kind,
           client_transcription_id, timestamp, account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`
      );
      const result = stmt.run(
        text,
        rawText,
        status,
        errorMessage,
        errorCode,
        routeKind,
        clientTranscriptionId,
        occurredAt,
        this._accountSpokenUnder(analyticsOccurredAt)
      );

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      return { id: result.lastInsertRowid, success: true, transcription };
    } catch (error) {
      debugLogger.error("Error saving transcription", { error: error.message }, "database");
      throw error;
    }
  }

  _ensureAnalyticsHistoryBackfillState(version) {
    this.db
      .prepare(
        `INSERT INTO analytics_history_backfill_state (
           id, version, scanned_through_transcription_id
         ) VALUES (1, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           scanned_through_transcription_id = 0
         WHERE analytics_history_backfill_state.version <> excluded.version`
      )
      .run(version);
    return this.db
      .prepare(
        `SELECT version, scanned_through_transcription_id
         FROM analytics_history_backfill_state WHERE id = 1`
      )
      .get();
  }

  getAnalyticsHistoryBackfillState(version = ANALYTICS_HISTORY_BACKFILL_VERSION) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const safeVersion = Math.max(1, Math.trunc(Number(version)) || 1);
      return this.db.transaction(() => {
        const state = this._ensureAnalyticsHistoryBackfillState(safeVersion);
        const target = this.db
          .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM transcriptions")
          .get();
        return {
          version: safeVersion,
          scannedThroughId: Number(state.scanned_through_transcription_id),
          targetId: Number(target.id),
        };
      })();
    } catch (error) {
      debugLogger.error(
        "Error reading analytics history backfill state",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  _invalidateAnalyticsHistoryFromTranscription(id) {
    const resumeBeforeId = Math.max(0, Math.trunc(Number(id)) - 1);
    this.db
      .prepare(
        `INSERT INTO analytics_history_backfill_state (
           id, version, scanned_through_transcription_id
         ) VALUES (1, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           scanned_through_transcription_id = CASE
             WHEN analytics_history_backfill_state.version = excluded.version
             THEN MIN(
               analytics_history_backfill_state.scanned_through_transcription_id,
               ?
             )
             ELSE 0
           END`
      )
      .run(ANALYTICS_HISTORY_BACKFILL_VERSION, resumeBeforeId);
  }

  backfillAnalyticsHistoryBatch({
    afterId = 0,
    throughId = null,
    checkpointVersion = null,
    limit = 250,
  } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit)) || 250, 1_000));
      const safeAfterId = Math.max(0, Math.trunc(Number(afterId)) || 0);
      const safeThroughId =
        throughId === null || throughId === undefined
          ? null
          : Math.max(0, Math.trunc(Number(throughId)) || 0);
      const safeCheckpointVersion =
        checkpointVersion === null || checkpointVersion === undefined
          ? null
          : Math.max(1, Math.trunc(Number(checkpointVersion)) || 1);

      return this.db.transaction(() => {
        const checkpoint =
          safeCheckpointVersion === null
            ? null
            : this._ensureAnalyticsHistoryBackfillState(safeCheckpointVersion);
        const effectiveAfterId = checkpoint
          ? Number(checkpoint.scanned_through_transcription_id)
          : safeAfterId;
        if (safeThroughId !== null && effectiveAfterId >= safeThroughId) {
          return {
            complete: true,
            nextCursor: effectiveAfterId,
            scanned: 0,
            inserted: 0,
            skipped: 0,
          };
        }

        // The latest Clear history covering the row: the account's own, or the
        // device-wide one older builds recorded.
        const clearedThroughSql = `NULLIF(MAX(
          COALESCE(device_clear.cleared_through, ''),
          COALESCE(account_clear.cleared_through, '')
        ), '')`;
        // Legacy SQLite timestamps are completion times without an offset. Once
        // the user has cleared Insights, only a client-captured occurrence time
        // can prove that a historical row happened afterward, so an ambiguous
        // legacy row stays out rather than reviving a cleared counter. That is
        // the eligibility rule below; the boundary on the instant actually
        // written is enforced in the loop, where the chosen value is known.
        const rows = this.db
          .prepare(
            `SELECT transcription.id, transcription.client_transcription_id,
                    transcription.text, transcription.raw_text, transcription.timestamp,
                    transcription.created_at, transcription.account_id,
                    audio_duration_ms, provider, model,
                    ${clearedThroughSql} AS cleared_through
             FROM transcriptions transcription
             LEFT JOIN analytics_device_clear_state device_clear ON device_clear.id = 1
             LEFT JOIN analytics_account_clear_state account_clear
               ON account_clear.account_scope = COALESCE(transcription.account_id, '')
             WHERE transcription.id > ?
               AND (? IS NULL OR transcription.id <= ?)
               AND transcription.deleted_at IS NULL
               AND transcription.status = 'completed'
               AND TRIM(COALESCE(NULLIF(TRIM(transcription.raw_text), ''), transcription.text, '')) != ''
               AND NOT EXISTS (
                 SELECT 1 FROM analytics_events event
                 WHERE event.event_id = TRIM(transcription.client_transcription_id)
               )
               AND (
                 ${clearedThroughSql} IS NULL
                 OR (
                   (TRIM(transcription.timestamp) LIKE '%Z'
                    OR SUBSTR(TRIM(transcription.timestamp), -6, 1) IN ('+', '-'))
                   AND JULIANDAY(transcription.timestamp) > JULIANDAY(${clearedThroughSql})
                 )
               )
             ORDER BY transcription.id ASC
             LIMIT ?`
          )
          .all(effectiveAfterId, safeThroughId, safeThroughId, safeLimit);

        let inserted = 0;
        let skipped = 0;
        const insert = this.db.prepare(
          `INSERT INTO analytics_events (
             event_id, account_id, occurred_at, local_date, word_count,
             spoken_duration_ms, mode, provider, model, counter_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME(?))
           ON CONFLICT(event_id) DO NOTHING`
        );
        const assignClientId = this.db.prepare(
          `UPDATE transcriptions SET client_transcription_id = ?
           WHERE id = ? AND (client_transcription_id IS NULL OR TRIM(client_transcription_id) = '')`
        );

        for (const row of rows) {
          const sourceText = row.raw_text?.trim() ? row.raw_text : row.text;
          const wordCount = countSpokenWords(sourceText);
          if (wordCount === 0) {
            skipped += 1;
            continue;
          }

          const createdAt = parseDbTimestamp(row.created_at);
          // A naive timestamp can be a sync artifact rather than an occurrence
          // time, so it is never the answer: created_at carries the cloud row's
          // own instant, while timestamp defaulted to the moment of the pull.
          const occurredAt =
            (hasExplicitTimeZone(row.timestamp) ? parseDbTimestamp(row.timestamp) : null) ??
            createdAt;
          // Guessing a date would put an old dictation on today, inflating
          // today's counters and manufacturing a current streak out of a row
          // whose age we could not read. It stays out instead.
          if (!occurredAt) {
            skipped += 1;
            continue;
          }
          // Not a restatement of the query's clear filter: that one decides
          // eligibility from transcription.timestamp, while this guards the
          // instant actually chosen, which may be created_at. It also catches
          // what the SQL shape test cannot -- a bare YYYY-MM-DD reads as zoned
          // there, its day hyphen sitting six characters from the end.
          if (row.cleared_through && occurredAt.getTime() <= Date.parse(row.cleared_through)) {
            skipped += 1;
            continue;
          }

          const eventId = row.client_transcription_id?.trim() || randomUUID();
          if (!row.client_transcription_id?.trim()) assignClientId.run(eventId, row.id);
          // A counter belongs to whoever dictated it: a claim must never hand
          // another account's history to the one signed in.
          const result = insert.run(
            eventId,
            row.account_id ?? null,
            occurredAt.toISOString(),
            localDateKey(occurredAt),
            wordCount,
            Number(row.audio_duration_ms) > 0 ? Number(row.audio_duration_ms) : null,
            inferHistoricalAnalyticsMode(row.provider),
            row.provider || null,
            row.model || null,
            ANALYTICS_HISTORICAL_COUNTER_VERSION,
            (createdAt ?? occurredAt).toISOString()
          );
          if (result.changes > 0) inserted += 1;
          else skipped += 1;
        }

        const complete = rows.length < safeLimit;
        const lastCandidateId =
          rows.length > 0 ? Number(rows[rows.length - 1].id) : effectiveAfterId;
        const nextCursor = complete && safeThroughId !== null ? safeThroughId : lastCandidateId;
        if (checkpoint) {
          this.db
            .prepare(
              `UPDATE analytics_history_backfill_state
               SET scanned_through_transcription_id = ?
               WHERE id = 1 AND version = ?`
            )
            .run(nextCursor, safeCheckpointVersion);
        }

        return {
          complete,
          nextCursor,
          scanned: rows.length,
          inserted,
          skipped,
        };
      })();
    } catch (error) {
      debugLogger.error(
        "Error backfilling analytics history",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  recordAnalyticsEvent({
    eventId,
    wordCount,
    occurredAt,
    localDate,
    spokenDurationMs = null,
    mode = "unknown",
    provider = null,
    model = null,
  }) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (wordCount === 0) return { success: true, ignored: true };
      // A recording in flight when any account cleared its history stays
      // cleared, even if the account changes before this late write lands.
      const cleared = this.db
        .prepare(
          `SELECT 1 FROM (
             SELECT cleared_through FROM analytics_device_clear_state
             UNION ALL
             SELECT cleared_through FROM analytics_account_clear_state
           ) WHERE ? <= cleared_through`
        )
        .get(occurredAt);
      if (cleared) return { success: true, ignored: true };
      this.db
        .prepare(
          `INSERT INTO analytics_events (
             event_id, account_id, occurred_at, local_date, word_count,
             spoken_duration_ms, mode, provider, model, counter_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             account_id = COALESCE(analytics_events.account_id, excluded.account_id),
             occurred_at = excluded.occurred_at,
             local_date = excluded.local_date,
             word_count = excluded.word_count,
             spoken_duration_ms = COALESCE(
               excluded.spoken_duration_ms,
               analytics_events.spoken_duration_ms
             ),
             mode = excluded.mode,
             provider = COALESCE(excluded.provider, analytics_events.provider),
             model = COALESCE(excluded.model, analytics_events.model),
             counter_version = excluded.counter_version,
             sync_status = 'pending'
           WHERE analytics_events.deleted_at IS NULL`
        )
        .run(
          eventId,
          this._accountSpokenUnder(occurredAt),
          occurredAt,
          localDate,
          wordCount,
          Number(spokenDurationMs) > 0 ? Number(spokenDurationMs) : null,
          mode,
          provider,
          model,
          ANALYTICS_COUNTER_VERSION
        );
      return { success: true, eventId };
    } catch (error) {
      debugLogger.error("Error recording analytics event", { error: error.message }, "database");
      throw error;
    }
  }

  getAnalyticsSummary() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // Grouped in SQL so the row count is bounded by distinct days rather than
      // by dictations; summarizeAnalyticsDays still owns every derived figure.
      // Whatever the history above it can show: the active account's and
      // unattributed counters, and signed out only the unattributed ones.
      const accountFilter = this.activeAccountId
        ? "AND (account_id IS NULL OR account_id = ?)"
        : "AND account_id IS NULL";
      const days = this.db
        .prepare(
          `SELECT local_date AS date,
                  SUM(word_count) AS words,
                  COUNT(*) AS dictations,
                  SUM(CASE WHEN spoken_duration_ms > 0 THEN spoken_duration_ms ELSE 0 END)
                    AS spokenDurationMs,
                  SUM(CASE WHEN spoken_duration_ms > 0 THEN word_count ELSE 0 END)
                    AS coveredWords
           FROM analytics_events
           WHERE deleted_at IS NULL ${accountFilter}
           GROUP BY local_date`
        )
        .all(...(this.activeAccountId ? [this.activeAccountId] : []));
      return summarizeAnalyticsDays(days);
    } catch (error) {
      debugLogger.error("Error reading analytics summary", { error: error.message }, "database");
      throw error;
    }
  }

  analyticsAccountId(expectedAccountId) {
    if (expectedAccountId == null) return this.activeAccountId;
    if (expectedAccountId !== this.activeAccountId) {
      throw Object.assign(new Error("Analytics account context changed"), {
        code: "AUTH_CONTEXT_CHANGED",
      });
    }
    return expectedAccountId;
  }

  getPendingAnalyticsEvents(limit = 200, expectedAccountId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.analyticsAccountId(expectedAccountId);
      if (!accountId) return [];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 200));
      // The projection is the wire shape: AnalyticsService posts these rows
      // verbatim, so every column here has to satisfy the batch endpoint's
      // event schema -- occurred_at included, which that schema requires
      // alongside local_date. Exact events go first so rejected historical
      // rows cannot block current activity during an API rollback.
      return this.db
        .prepare(
          `SELECT event_id, occurred_at, local_date, word_count, spoken_duration_ms,
                  mode, provider, model, counter_version
           FROM analytics_events
           WHERE account_id = ? AND sync_status = 'pending' AND deleted_at IS NULL
           ORDER BY (counter_version = 0) ASC, occurred_at ASC LIMIT ?`
        )
        .all(accountId, safeLimit);
    } catch (error) {
      debugLogger.error("Error reading pending analytics", { error: error.message }, "database");
      throw error;
    }
  }

  markAnalyticsEventsSynced(eventIds, expectedAccountId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.analyticsAccountId(expectedAccountId);
      if (!accountId || !Array.isArray(eventIds) || eventIds.length === 0) {
        return { success: true, updated: 0 };
      }
      const placeholders = eventIds.map(() => "?").join(", ");
      const result = this.db
        .prepare(
          `UPDATE analytics_events SET sync_status = 'synced'
           WHERE account_id = ? AND deleted_at IS NULL
             AND event_id IN (${placeholders})`
        )
        .run(accountId, ...eventIds);
      return { success: true, updated: result.changes };
    } catch (error) {
      debugLogger.error("Error marking analytics synced", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingAnalyticsDeletes(limit = 200, expectedAccountId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.analyticsAccountId(expectedAccountId);
      if (!accountId) return [];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 200));
      return this.db
        .prepare(
          `SELECT event_id FROM analytics_events
           WHERE account_id = ? AND deleted_at IS NOT NULL AND sync_status = 'pending'
           ORDER BY occurred_at ASC LIMIT ?`
        )
        .all(accountId, safeLimit);
    } catch (error) {
      debugLogger.error(
        "Error reading pending analytics deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteAnalyticsEvents(eventIds, expectedAccountId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.analyticsAccountId(expectedAccountId);
      if (!accountId || !Array.isArray(eventIds) || eventIds.length === 0) {
        return { success: true, deleted: 0 };
      }
      const placeholders = eventIds.map(() => "?").join(", ");
      const result = this.db
        .prepare(
          `DELETE FROM analytics_events
           WHERE account_id = ? AND deleted_at IS NOT NULL
             AND event_id IN (${placeholders})`
        )
        .run(accountId, ...eventIds);
      return { success: true, deleted: result.changes };
    } catch (error) {
      debugLogger.error(
        "Error deleting synced analytics tombstones",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getPendingAnalyticsClear(expectedAccountId) {
    if (!this.db) throw new Error("Database not initialized");
    const accountId = this.analyticsAccountId(expectedAccountId);
    if (!accountId) return null;
    return (
      this.db
        .prepare(
          `SELECT cleared_through FROM analytics_clear_requests
           WHERE account_id = ? AND synced = 0`
        )
        .get(accountId) ?? null
    );
  }

  completeAnalyticsClear(clearedThrough, expectedAccountId) {
    if (!this.db) throw new Error("Database not initialized");
    const accountId = this.analyticsAccountId(expectedAccountId);
    if (!accountId || typeof clearedThrough !== "string") {
      return { success: false, deleted: 0 };
    }

    const complete = this.db.transaction(() => {
      const request = this.db
        .prepare(
          `UPDATE analytics_clear_requests SET synced = 1
           WHERE account_id = ? AND cleared_through = ? AND synced = 0`
        )
        .run(accountId, clearedThrough);
      if (request.changes === 0) return 0;
      return this.db
        .prepare(
          `DELETE FROM analytics_events
           WHERE account_id = ? AND occurred_at <= ?`
        )
        .run(accountId, clearedThrough).changes;
    });
    return { success: true, deleted: complete() };
  }

  // An unattributed counter isn't on offer if its dictation is another
  // account's, or on a shared device could be: a legacy dictation is claimed only
  // when the account's own cloud proves it.
  _claimableAnalyticsSql() {
    const unproven = this.hasOtherAccountRows()
      ? "OR (dictation.account_id IS NULL AND dictation.legacy_unattributed != 0)"
      : "";
    return `(analytics_events.account_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM transcriptions dictation
      WHERE dictation.client_transcription_id = analytics_events.event_id
        AND ((dictation.account_id IS NOT NULL AND dictation.account_id IS NOT ?) ${unproven})
    ))`;
  }

  countUnclaimedAnalyticsEvents() {
    if (!this.db) throw new Error("Database not initialized");
    return this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM analytics_events
         WHERE deleted_at IS NULL AND ${this._claimableAnalyticsSql()}`
      )
      .get(this.activeAccountId).count;
  }

  // Everything turning Insights sync on would upload: this account's queued
  // rows plus the pre-sign-in ones the prompt offers to claim.
  //
  // The claim count alone is not that number and badly understates it. Every
  // dictation made while signed in is already attributed to the account, so a
  // user who had been signed in for months had nothing "unclaimed" — the
  // consent prompt never opened, and flipping the toggle uploaded their entire
  // history in one pass.
  countAnalyticsEventsAwaitingUpload(expectedAccountId) {
    if (!this.db) throw new Error("Database not initialized");
    const accountId = this.analyticsAccountId(expectedAccountId);
    return this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM analytics_events
         WHERE deleted_at IS NULL AND sync_status <> 'synced'
           AND (account_id = ? OR ${this._claimableAnalyticsSql()})`
      )
      .get(accountId, accountId).count;
  }

  // Device-local rows stay unattributed until the signed-in user explicitly
  // asks for them, so signing in never silently adopts someone else's history.
  claimAnonymousAnalyticsEvents(expectedAccountId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId =
        typeof expectedAccountId === "string" && expectedAccountId.trim().length > 0
          ? expectedAccountId.trim()
          : null;
      if (!accountId || accountId !== this.activeAccountId) {
        return { success: false, claimed: 0 };
      }
      const result = this.db
        .prepare(
          `UPDATE analytics_events SET account_id = ?
           WHERE deleted_at IS NULL AND ${this._claimableAnalyticsSql()}`
        )
        .run(accountId, accountId);
      return { success: true, claimed: result.changes };
    } catch (error) {
      debugLogger.error("Error claiming analytics events", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptions(limit = 50, { includeDiscarded = false } = {}) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const statusFilter = includeDiscarded ? "" : " AND status != 'discarded'";
      const scope = this._ownedRowScope("transcriptions");
      const stmt = this.db.prepare(
        `SELECT * FROM transcriptions WHERE deleted_at IS NULL${statusFilter} AND ${scope.sql} ORDER BY timestamp DESC LIMIT ?`
      );
      const transcriptions = stmt.all(...scope.params, limit);
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
      // Clear history clears the active account's history. Another account's
      // rows, and the cloud copies only its token can delete, stay.
      const scope = this._ownedRowScope("transcriptions");
      const clearedIds = this.db.prepare(
        `SELECT id FROM transcriptions WHERE deleted_at IS NULL AND ${scope.sql}`
      );
      // A tombstone is the clearing account's to push. Its token can only delete
      // its own cloud's copy, so a legacy row's copy in another account's stays.
      const tombstone = this.db.prepare(
        `UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending', account_id = COALESCE(account_id, ?) WHERE cloud_id IS NOT NULL AND deleted_at IS NULL AND ${scope.sql}`
      );
      const hardDelete = this.db.prepare(
        `DELETE FROM transcriptions WHERE cloud_id IS NULL AND ${scope.sql}`
      );
      // One rule decides every row: a counter the cloud never received is
      // erased outright, and only a counter it did receive leaves a tombstone
      // behind for the delete pusher.
      //
      // It matters in both directions. Tombstoning a row that was never
      // uploaded sent its event id to the server on the next pass — for an
      // account that never turned Insights sync on, that was the only
      // analytics traffic it ever produced, and the server stores a row per id
      // it is asked to delete. Hard-deleting a row that *was* uploaded stranded
      // it in the cloud with nothing left on the device to erase it, which is
      // what signing out before clearing used to do.
      //
      // Like the history itself, only the active account's counters (and
      // unattributed ones) are cleared; another account's stay with its history.
      const hardDeleteLocalAnalytics = this.db.prepare(
        `DELETE FROM analytics_events
         WHERE account_id IS NULL
            OR (account_id = ? AND sync_status <> 'synced' AND deleted_at IS NULL)`
      );
      const tombstoneSyncedAnalytics = this.db.prepare(
        `UPDATE analytics_events
         SET deleted_at = ?, sync_status = 'pending'
         WHERE account_id = ? AND sync_status = 'synced' AND deleted_at IS NULL`
      );
      const countSyncedAnalytics = this.db.prepare(
        "SELECT COUNT(*) AS count FROM analytics_events WHERE account_id = ? AND sync_status = 'synced'"
      );
      const queueAnalyticsClear = this.db.prepare(
        `INSERT INTO analytics_clear_requests (account_id, cleared_through, synced)
         VALUES (?, ?, 0)
         ON CONFLICT(account_id) DO UPDATE SET
           cleared_through = MAX(analytics_clear_requests.cleared_through, excluded.cleared_through),
           synced = 0`
      );
      // The cutoff keeps the history backfill from rebuilding cleared counters.
      // Unattributed rows were cleared too, so they get one of their own.
      const updateClearState = this.db.prepare(
        `INSERT INTO analytics_account_clear_state (account_scope, cleared_through)
         VALUES (?, ?)
         ON CONFLICT(account_scope) DO UPDATE SET
           cleared_through = MAX(analytics_account_clear_state.cleared_through, excluded.cleared_through)`
      );
      const clearedThrough = new Date().toISOString();
      const clearAll = this.db.transaction(() => {
        const ids = clearedIds.all(...scope.params).map((row) => row.id);
        const cleared =
          tombstone.run(this.activeAccountId, ...scope.params).changes +
          hardDelete.run(...scope.params).changes;
        updateClearState.run("", clearedThrough);
        if (this.activeAccountId) updateClearState.run(this.activeAccountId, clearedThrough);
        // The account-wide cutoff is what erases rows this device no longer
        // has — another device's uploads. It is only meaningful once this
        // account has actually put something in the cloud; queueing it for an
        // account that never synced would be a bare request to the analytics
        // API from a user who never opted in.
        const hasSyncedRows =
          this.activeAccountId && countSyncedAnalytics.get(this.activeAccountId).count > 0;
        tombstoneSyncedAnalytics.run(clearedThrough, this.activeAccountId);
        hardDeleteLocalAnalytics.run(this.activeAccountId);
        if (hasSyncedRows) {
          queueAnalyticsClear.run(this.activeAccountId, clearedThrough);
        }
        return { cleared, ids };
      });
      return { ...clearAll(), success: true };
    } catch (error) {
      debugLogger.error("Error clearing transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  /** Purges transcriptions and their Insights counters older than the retention window.
   *  Returns the affected transcription ids so callers can drop the matching audio files.
   *  Runs even with no expired transcriptions: counters outlive tombstoned rows. */
  deleteTranscriptionsExpiredBefore(retentionDays) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      // Resolve the cutoff once so the ids we report are exactly the rows we purge.
      const cutoff = this.db
        .prepare("SELECT datetime('now', ?) AS cutoff")
        .get(`-${retentionDays} days`).cutoff;
      // As with Clear history: another account's rows wait for that account.
      const scope = this._ownedRowScope("transcriptions");
      const expired = this.db
        .prepare(
          `SELECT id FROM transcriptions WHERE deleted_at IS NULL AND created_at < ? AND ${scope.sql}`
        )
        .all(cutoff, ...scope.params)
        .map((row) => row.id);

      const tombstone = this.db.prepare(
        `UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending', account_id = COALESCE(account_id, ?) WHERE cloud_id IS NOT NULL AND deleted_at IS NULL AND created_at < ? AND ${scope.sql}`
      );
      const hardDelete = this.db.prepare(
        `DELETE FROM transcriptions WHERE cloud_id IS NULL AND created_at < ? AND ${scope.sql}`
      );
      // Counters follow the transcripts they describe, on the same cutoff and
      // in the same transaction. Matched on created_at, never occurred_at:
      // created_at uses the same SQLite timestamp format as the cutoff.
      //
      // Same rule as clearTranscriptions: only a row the cloud actually holds
      // leaves a tombstone. Attribution alone is not enough — every dictation
      // made while signed in carries an account_id whether or not Insights
      // sync was ever turned on, so tombstoning on that basis shipped the event
      // ids of a user who never opted in.
      const tombstoneSyncedAnalytics = this.db.prepare(
        `UPDATE analytics_events
         SET deleted_at = datetime('now'), sync_status = 'pending'
         WHERE sync_status = 'synced' AND deleted_at IS NULL AND created_at < ? AND account_id = ?`
      );
      const purgeUnsyncedAnalytics = this.db.prepare(
        `DELETE FROM analytics_events
         WHERE (account_id IS NULL OR (account_id = ? AND sync_status <> 'synced'))
           AND deleted_at IS NULL AND created_at < ?`
      );
      let analyticsPurged = 0;
      this.db.transaction(() => {
        tombstone.run(this.activeAccountId, cutoff, ...scope.params);
        hardDelete.run(cutoff, ...scope.params);
        analyticsPurged =
          tombstoneSyncedAnalytics.run(cutoff, this.activeAccountId).changes +
          purgeUnsyncedAnalytics.run(this.activeAccountId, cutoff).changes;
      })();
      return { ids: expired, analyticsPurged };
    } catch (error) {
      debugLogger.error(
        "Error purging expired transcriptions",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  deleteTranscription(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const scope = this._ownedRowScope("transcriptions");
      const row = this.db
        .prepare(`SELECT cloud_id, deleted_at FROM transcriptions WHERE id = ? AND ${scope.sql}`)
        .get(id, ...scope.params);
      if (!row || row.deleted_at) return { success: false, id };
      // As with Clear history, the tombstone is the deleter's to push.
      const result = row.cloud_id
        ? this.db
            .prepare(
              "UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending', account_id = COALESCE(account_id, ?) WHERE id = ? AND deleted_at IS NULL"
            )
            .run(this.activeAccountId, id)
        : this.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
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
      this.db.transaction(() => {
        const existing = this.db
          .prepare("SELECT text, raw_text FROM transcriptions WHERE id = ?")
          .get(id);
        if (existing && (existing.text !== text || existing.raw_text !== rawText)) {
          this._invalidateAnalyticsHistoryFromTranscription(id);
        }
        stmt.run(text, rawText, id);
      })();
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
      this.db.transaction(() => {
        const existing = this.db.prepare("SELECT status FROM transcriptions WHERE id = ?").get(id);
        if (existing && existing.status !== status && status === "completed") {
          this._invalidateAnalyticsHistoryFromTranscription(id);
        }
        stmt.run(status, errorMessage, errorCode, id);
      })();
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
      const scope = this._ownedRowScope("transcriptions");
      const stmt = this.db.prepare(`SELECT * FROM transcriptions WHERE id = ? AND ${scope.sql}`);
      return stmt.get(id, ...scope.params) || null;
    } catch (error) {
      debugLogger.error("Error getting transcription by id", { error: error.message }, "database");
      throw error;
    }
  }

  // Recordings are named by transcription id: these belong to someone else.
  getOtherAccountTranscriptionIds() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT id FROM transcriptions WHERE account_id IS NOT NULL AND account_id IS NOT ?"
        )
        .all(this._visibleAccountId())
        .map((row) => row.id);
    } catch (error) {
      debugLogger.error(
        "Error getting other accounts' transcription ids",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getTranscriptionIdsWithAudio() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("transcriptions");
      return this.db
        .prepare(`SELECT id FROM transcriptions WHERE has_audio = 1 AND ${scope.sql}`)
        .all(...scope.params)
        .map((row) => row.id);
    } catch (error) {
      debugLogger.error(
        "Error getting transcription ids with audio",
        { error: error.message },
        "database"
      );
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
      const scope = this._ownedRowScope("custom_dictionary");
      const rows = this.db
        .prepare(
          `SELECT word FROM custom_dictionary WHERE deleted_at IS NULL AND ${scope.sql} ORDER BY id ASC`
        )
        .all(...scope.params);
      return rows.map((row) => row.word);
    } catch (error) {
      debugLogger.error("Error getting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  // Every dictionary mutation rule lives here once, so the whole-list and
  // delta write paths cannot drift apart.
  _dictionaryWriteStatements() {
    return {
      // The tombstone of an unattributed word is the deleter's to push, as
      // with Clear history: another account's token would delete its own copy.
      tombstone: this.db.prepare(
        "UPDATE custom_dictionary SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = 'pending', account_id = COALESCE(account_id, ?) WHERE id = ? AND deleted_at IS NULL"
      ),
      restore: this.db.prepare(
        "UPDATE custom_dictionary SET deleted_at = NULL, shared_at = NULL, shared_at_dirty = 1, fallback_retired = 0, source = CASE WHEN source = 'learned' AND ? = 'manual' THEN 'manual' ELSE source END, word = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?"
      ),
      // Pending and dirty, so the next push tells the server the word is
      // personal again.
      clearShared: this.db.prepare(
        "UPDATE custom_dictionary SET shared_at = NULL, shared_at_dirty = 1, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND shared_at IS NOT NULL"
      ),
      promoteSource: this.db.prepare(
        "UPDATE custom_dictionary SET word = ?, source = 'manual', updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND source = 'learned'"
      ),
      // Guarded on word != ? so an unchanged row keeps its sync_status.
      updateWord: this.db.prepare(
        "UPDATE custom_dictionary SET word = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND word != ?"
      ),
      // INSERT OR IGNORE in case a legacy case-variant row collides on the
      // case-sensitive per-account UNIQUE(word) that the lowercase lookup
      // didn't catch.
      insert: this.db.prepare(
        "INSERT OR IGNORE INTO custom_dictionary (word, source, client_dict_id, sync_status, updated_at, account_id) VALUES (?, ?, ?, 'pending', datetime('now'), ?)"
      ),
    };
  }

  // Dedupe by folded key, keeping the first occurrence's casing, so no caller
  // can present two spellings of the same word to a write loop.
  _normalizeDictionaryWords(words) {
    const byLower = new Map();
    for (const raw of Array.isArray(words) ? words : []) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lower = foldKey(trimmed);
      if (!byLower.has(lower)) byLower.set(lower, trimmed);
    }
    return byLower;
  }

  _dictionaryRows() {
    const scope = this._ownedRowScope("custom_dictionary");
    const rows = this.db
      .prepare(
        `SELECT id, word, source, deleted_at, shared_at, cloud_id, account_id FROM custom_dictionary WHERE ${scope.sql}`
      )
      .all(...scope.params);
    return { rows, byLower: rowsByFoldedKey(rows, "word") };
  }

  // Returns true when the word became present, so callers can report how many
  // words they actually added rather than how many they asked for.
  // `isReAdd` marks an explicit add, which takes a shared word back into
  // Personal. A whole-list write that merely keeps the word isn't one, or
  // every settings write would undo every share.
  _upsertDictionaryWord(stmts, word, existing, source, { isReAdd = false } = {}) {
    if (!existing) {
      return stmts.insert.run(word, source, randomUUID(), this.activeAccountId).changes > 0;
    }
    if (existing.deleted_at) {
      stmts.restore.run(source, word, existing.id);
      return true;
    }
    if (source === "manual" && existing.source === "learned") {
      stmts.promoteSource.run(word, existing.id);
    } else {
      stmts.updateWord.run(word, existing.id, word);
    }
    if (isReAdd && existing.shared_at) stmts.clearShared.run(existing.id);
    return false;
  }

  // Hard-delete when the row never reached the cloud, else tombstone so the
  // next push tells the server about the deletion.
  _deleteDictionaryRow(stmts, existing) {
    if (!existing || existing.deleted_at) return false;
    if (existing.cloud_id) {
      this._dropHiddenDuplicates("custom_dictionary", existing.word);
      stmts.tombstone.run(this.activeAccountId, existing.id);
    } else {
      this._hardDeleteKeyedRow("custom_dictionary", existing.id, existing);
    }
    return true;
  }

  // Add and/or remove specific words, leaving every other row untouched.
  // Prefer this over setDictionary, which deletes whatever the caller omitted
  // and so lets a stale snapshot destroy the rest (#1295).
  // `source` tags additions ('manual' for user-typed, 'learned' for auto-learn).
  applyDictionaryChanges({ add = [], remove = [] } = {}, source = "manual") {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const additions = this._normalizeDictionaryWords(add);
      const removals = this._normalizeDictionaryWords(remove);
      // A word on both sides is a rename to itself; adding wins.
      for (const lower of additions.keys()) removals.delete(lower);
      if (additions.size === 0 && removals.size === 0) {
        return { success: true, added: 0, removed: 0 };
      }

      const { byLower } = this._dictionaryRows();
      const stmts = this._dictionaryWriteStatements();
      let added = 0;
      let removed = 0;

      this.db.transaction(() => {
        for (const lower of removals.keys()) {
          if (this._deleteDictionaryRow(stmts, byLower.get(lower))) removed += 1;
        }
        for (const [lower, word] of additions) {
          const existing = byLower.get(lower);
          if (this._upsertDictionaryWord(stmts, word, existing, source, { isReAdd: true })) {
            added += 1;
          }
        }
      })();

      return { success: true, added, removed };
    } catch (error) {
      debugLogger.error("Error applying dictionary changes", { error: error.message }, "database");
      throw error;
    }
  }

  // Replace the entire dictionary: anything absent from `words` is deleted.
  // Only for deliberate replace-everything callers (settings restore, clear
  // all, first write into an empty database). Everything else wants
  // applyDictionaryChanges.
  //
  // Diff-based so unchanged rows keep their source/created_at/cloud_id.
  setDictionary(words, sourceForNewWords = "manual") {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const incomingByLower = this._normalizeDictionaryWords(words);
      const { rows, byLower } = this._dictionaryRows();
      const stmts = this._dictionaryWriteStatements();

      this.db.transaction(() => {
        for (const existing of rows) {
          if (incomingByLower.has(foldKey(existing.word))) continue;
          this._deleteDictionaryRow(stmts, existing);
        }
        for (const [lower, word] of incomingByLower) {
          this._upsertDictionaryWord(stmts, word, byLower.get(lower), sourceForNewWords);
        }
      })();

      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  // First write of a renderer's cached list, for a database that has never
  // held one. Once any account has rows here, a cache this scope can't see in
  // SQLite is another scope's, and writing it would copy that list into this one.
  seedDictionary(words) {
    if (!this.db) throw new Error("Database not initialized");
    if (this.db.prepare("SELECT 1 FROM custom_dictionary LIMIT 1").get()) {
      return { success: true, seeded: false };
    }
    return { ...this.setDictionary(words), seeded: true };
  }

  getPendingDictionary() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._syncRowScope("custom_dictionary");
      return this.db
        .prepare(
          `SELECT * FROM custom_dictionary WHERE sync_status = 'pending' AND deleted_at IS NULL AND ${scope.sql}`
        )
        .all(...scope.params);
    } catch (error) {
      debugLogger.error("Error getting pending dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingDictionaryDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._syncRowScope("custom_dictionary");
      return this.db
        .prepare(
          `SELECT * FROM custom_dictionary WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending' AND ${scope.sql}`
        )
        .all(...scope.params);
    } catch (error) {
      debugLogger.error(
        "Error getting pending dictionary deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteDictionaryEntry(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("custom_dictionary");
      return this.db.transaction(() => {
        const row = this.db
          .prepare(
            `SELECT word, account_id, deleted_at FROM custom_dictionary WHERE id = ? AND ${scope.sql}`
          )
          .get(id, ...scope.params);
        if (!row) return { success: false, id };
        this._hardDeleteKeyedRow("custom_dictionary", id, row);
        return { success: true, id };
      })();
    } catch (error) {
      debugLogger.error(
        "Error hard deleting dictionary entry",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getDictionaryEntryByClientId(clientDictId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._syncRowScope("custom_dictionary");
      return (
        this.db
          .prepare(`SELECT * FROM custom_dictionary WHERE client_dict_id = ? AND ${scope.sql}`)
          .get(clientDictId, ...scope.params) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting dictionary entry by client id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertDictionaryFromCloud(cloudEntry) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // Reject incomplete payloads rather than corrupt a row with defaults.
      if (!cloudEntry || typeof cloudEntry !== "object") return null;
      if (typeof cloudEntry.id !== "string" || !cloudEntry.id) return null;

      const word = typeof cloudEntry.word === "string" ? cloudEntry.word.trim() : "";
      if (!word) return null;

      const clientDictId =
        typeof cloudEntry.client_dict_id === "string" && cloudEntry.client_dict_id
          ? cloudEntry.client_dict_id
          : randomUUID();
      const incomingSource = cloudEntry.source === "learned" ? "learned" : "manual";
      const updatedAt =
        typeof cloudEntry.updated_at === "string" && cloudEntry.updated_at
          ? cloudEntry.updated_at
          : typeof cloudEntry.created_at === "string" && cloudEntry.created_at
            ? cloudEntry.created_at
            : new Date().toISOString();
      const createdAt =
        typeof cloudEntry.created_at === "string" && cloudEntry.created_at
          ? cloudEntry.created_at
          : updatedAt;
      // An API from before sharing sends no shared_at at all; keep the local
      // value then, rather than read the missing field as "not shared".
      const hasSharedAt = Object.hasOwn(cloudEntry, "shared_at");
      const incomingSharedAt =
        typeof cloudEntry.shared_at === "string" && cloudEntry.shared_at
          ? cloudEntry.shared_at
          : null;

      // Resolve the local row deterministically: client_dict_id, then cloud_id,
      // then word. Only this account's rows (and unattributed ones) can merge.
      const scope = this._syncRowScope("custom_dictionary");
      const byClient = this.db
        .prepare(
          `SELECT *, ${scope.sql} AS in_scope FROM custom_dictionary WHERE client_dict_id = ? LIMIT 1`
        )
        .get(...scope.params, clientDictId);
      if (byClient && !byClient.in_scope) {
        debugLogger.warn(
          "Skipping cloud dictionary entry whose local row this account can't see",
          {},
          "database"
        );
        return null;
      }
      const byCloud =
        byClient ||
        this.db
          .prepare(`SELECT * FROM custom_dictionary WHERE cloud_id = ? AND ${scope.sql} LIMIT 1`)
          .get(cloudEntry.id, ...scope.params);
      const existing =
        byCloud ||
        this.db
          .prepare(
            `SELECT * FROM custom_dictionary
             WHERE fold_key(word) = fold_key(?) AND ${scope.sql}
               AND ${this._mergeableByKeySql("custom_dictionary")}
             ORDER BY account_id IS NULL LIMIT 1`
          )
          .get(word, ...scope.params);

      if (existing) {
        const claim = this._claimUnattributedSql("custom_dictionary", {
          proven: Boolean(byCloud),
        });
        // A row at the same version can still owe the cloud its shared_at, and a
        // fallback retired here is only this device's guess (see pullDictionary).
        const takesCloudAnyway =
          (existing.deleted_at && existing.fallback_retired) ||
          (hasSharedAt &&
            existing.sync_status !== "pending" &&
            !isCloudEntryNewer(existing.updated_at, updatedAt) &&
            Boolean(incomingSharedAt) !== Boolean(existing.shared_at));
        if (
          byCloud &&
          !existing.account_id &&
          this.activeAccountId &&
          !takesCloudAnyway &&
          !isCloudEntryNewer(updatedAt, existing.updated_at)
        ) {
          this.db
            .prepare(`UPDATE custom_dictionary SET ${claim.sql} WHERE id = ?`)
            .run(...claim.params, existing.id);
          return this.db.prepare("SELECT * FROM custom_dictionary WHERE id = ?").get(existing.id);
        }
        // Manual is sticky — a pull never demotes a local manual row to learned.
        const mergedSource =
          existing.source === "manual" || incomingSource === "manual" ? "manual" : "learned";
        // A local edit can follow the push ACK within the same SQLite second.
        // Its timestamp cannot safely order it against the server's echo.
        if (existing.sync_status === "pending") {
          this.db
            .prepare(
              `UPDATE custom_dictionary SET cloud_id = COALESCE(cloud_id, ?), source = ?, ${claim.sql} WHERE id = ?`
            )
            .run(cloudEntry.id, mergedSource, ...claim.params, existing.id);
          return this.db.prepare("SELECT * FROM custom_dictionary WHERE id = ?").get(existing.id);
        }
        if (foldKey(existing.word) !== foldKey(word)) {
          this._dropHiddenDuplicates("custom_dictionary", existing.word);
        }
        // Renamed onto a word the same account already has: they merge, as the
        // cloud does, rather than fail the pull on the unique index every pass.
        const collision = this.db
          .prepare(
            `SELECT * FROM custom_dictionary
             WHERE id != ? AND word = ? AND COALESCE(account_id, '') = COALESCE(?, '')`
          )
          .get(existing.id, word, existing.account_id ?? this.activeAccountId);
        if (collision) {
          this.db.prepare("DELETE FROM custom_dictionary WHERE id = ?").run(existing.id);
          return collision;
        }
        const sharedAt = hasSharedAt ? incomingSharedAt : existing.shared_at;
        this.db
          .prepare(
            `UPDATE custom_dictionary
             SET cloud_id = ?, client_dict_id = ?, word = ?, source = ?, shared_at = ?,
                 shared_at_dirty = 0, fallback_retired = 0,
                 sync_status = 'synced', deleted_at = NULL, updated_at = ?,
                 ${claim.sql}
             WHERE id = ?`
          )
          .run(
            cloudEntry.id,
            clientDictId,
            word,
            mergedSource,
            sharedAt,
            updatedAt,
            ...claim.params,
            existing.id
          );
        return this.db.prepare("SELECT * FROM custom_dictionary WHERE id = ?").get(existing.id);
      }

      this.db
        .prepare(
          `INSERT INTO custom_dictionary
             (word, source, client_dict_id, cloud_id, shared_at, sync_status, created_at, updated_at, account_id)
           VALUES (?, ?, ?, ?, ?, 'synced', ?, ?, ?)`
        )
        .run(
          word,
          incomingSource,
          clientDictId,
          cloudEntry.id,
          incomingSharedAt,
          createdAt,
          updatedAt,
          this.activeAccountId
        );
      return this.db
        .prepare("SELECT * FROM custom_dictionary WHERE client_dict_id = ?")
        .get(clientDictId);
    } catch (error) {
      debugLogger.error(
        "Error upserting dictionary entry from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  markDictionaryEntrySynced(
    id,
    cloudId,
    serverUpdatedAt = null,
    expectedWord = null,
    expectedSource = null,
    serverSource = null,
    pushed = null
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM custom_dictionary WHERE id = ?").get(id);
        if (!current || current.deleted_at) return { success: false, changes: 0 };

        const unchanged =
          (expectedWord === null || current.word === expectedWord) &&
          (expectedSource === null || current.source === expectedSource) &&
          (!pushed ||
            (current.word === pushed.word &&
              current.shared_at === (pushed.shared_at ?? null) &&
              current.updated_at === pushed.updated_at));
        const claim = this._claimUnattributedSql("custom_dictionary");
        // Edited rows still adopt the cloud identity, so they can PATCH next
        // pass. Only missing/deleted rows authorize orphan cleanup (changes=0).
        const result = this.db
          .prepare(
            `UPDATE custom_dictionary
             SET cloud_id = ?, sync_status = ?, updated_at = COALESCE(?, updated_at),
                 shared_at_dirty = CASE WHEN ? THEN 0 ELSE shared_at_dirty END,
                 source = CASE WHEN ? = 'manual' THEN 'manual' ELSE source END,
                 ${claim.sql}
             WHERE id = ? AND (account_id IS NULL OR account_id = ?)`
          )
          .run(
            cloudId,
            unchanged ? "synced" : "pending",
            unchanged ? serverUpdatedAt : null,
            unchanged ? 1 : 0,
            serverSource,
            ...claim.params,
            id,
            this.activeAccountId
          );
        return { success: result.changes > 0, changes: result.changes };
      })();
    } catch (error) {
      debugLogger.error(
        "Error marking dictionary entry synced",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Clears cloud_id after a 404 so the next push re-creates the row via
  // batchCreate instead of retrying the dead PATCH. Only for a row this account
  // owns, or could only own: on a device another account has used, an
  // unattributed row's cloud id may be that account's, and re-creating it would
  // copy its word into this one. It stays pending instead, so its owner's next
  // pass can still deliver the edit.
  _clearCloudIdOfOwnRow(tableName, id) {
    const owned = this._ownOrOnlyAccountRowSql(tableName);
    return this.db
      .prepare(
        `UPDATE ${tableName} SET cloud_id = NULL, sync_status = 'pending' WHERE id = ? AND ${owned}`
      )
      .run(id, this.activeAccountId).changes;
  }

  _ownOrOnlyAccountRowSql(tableName) {
    return this.activeAccountId && !this.hasOtherAccountRows()
      ? `(${tableName}.account_id = ? OR ${tableName}.account_id IS NULL)`
      : `${tableName}.account_id = ?`;
  }

  // A tombstone from the signed-in account's cloud for a row whose local edit
  // is newer: the edit wins. The tombstone matched the row by its client or
  // cloud id, which proves the row is this account's, so it is claimed and
  // loses the dead cloud id, and the next push re-creates it.
  _keepNewerEditOverCloudDelete(tableName, id) {
    if (!this.activeAccountId) return 0;
    return this.db
      .prepare(
        `UPDATE ${tableName} SET account_id = ?, cloud_id = NULL
         WHERE id = ? AND deleted_at IS NULL AND sync_status = 'pending'
           AND (account_id IS NULL OR account_id = ?)`
      )
      .run(this.activeAccountId, id, this.activeAccountId).changes;
  }

  keepNewerDictionaryEdit(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return { success: this._keepNewerEditOverCloudDelete("custom_dictionary", id) > 0 };
    } catch (error) {
      debugLogger.error(
        "Error keeping a dictionary edit over its cloud deletion",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  clearDictionaryCloudId(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return { success: this._clearCloudIdOfOwnRow("custom_dictionary", id) > 0 };
    } catch (error) {
      debugLogger.error("Error clearing dictionary cloud_id", { error: error.message }, "database");
      throw error;
    }
  }

  // Live personal rows keyed by the folding the write paths dedupe with.
  _livePersonalRowsByLower() {
    const scope = this._ownedRowScope("custom_dictionary");
    const rows = this.db
      .prepare(
        `SELECT id, word, cloud_id, account_id FROM custom_dictionary WHERE deleted_at IS NULL AND ${scope.sql}`
      )
      .all(...scope.params);
    return rowsByFoldedKey(rows, "word");
  }

  getDictionaryEntriesByWords(words) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const byLower = this._livePersonalRowsByLower();
      const entries = [];
      for (const lower of this._normalizeDictionaryWords(words).keys()) {
        const row = byLower.get(lower);
        if (row) {
          entries.push({
            word: row.word,
            cloudId: row.cloud_id ?? null,
            accountId: row.account_id ?? null,
          });
        }
      }
      return entries;
    } catch (error) {
      debugLogger.error(
        "Error getting dictionary entries by words",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // The server already recorded the share, so this leaves sync_status and
  // updated_at alone, and the marker clean: a pending push would only echo it
  // back. `pendingWords` went as plain words (cloud backup off, the personal
  // row changed elsewhere), so the server's personal row never got shared_at:
  // those stay pending and dirty, and the push sends it once backup is on.
  markDictionaryWordsShared(words, sharedAt, { pendingWords = [] } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (typeof sharedAt !== "string" || !sharedAt) {
        throw new Error("sharedAt must be a non-empty string");
      }
      const byLower = this._livePersonalRowsByLower();
      const pending = new Set(this._normalizeDictionaryWords(pendingWords).keys());
      const mark = this.db.prepare(
        "UPDATE custom_dictionary SET shared_at = ?, shared_at_dirty = 0 WHERE id = ?"
      );
      const markPending = this.db.prepare(
        "UPDATE custom_dictionary SET shared_at = ?, shared_at_dirty = 1, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?"
      );
      const marked = [];
      this.db.transaction(() => {
        for (const lower of this._normalizeDictionaryWords(words).keys()) {
          const row = byLower.get(lower);
          if (!row) continue;
          (pending.has(lower) ? markPending : mark).run(sharedAt, row.id);
          marked.push(row.word);
        }
      })();
      return { marked };
    } catch (error) {
      debugLogger.error(
        "Error marking dictionary words shared",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Removes the sharer's fallback once its shared copy was hidden or deleted
  // for everyone, as the API does. Only moved rows (shared_at set) qualify.
  // Every row is tombstoned and flagged so a restore or un-hide can revive it;
  // the tombstone is local only (see `retire`), and a never-synced one is
  // never re-created either (pending creates skip deleted rows).
  // `includeSynced: false` leaves synced rows to the personal pull: an
  // untouched cloud row (the server kept it) never comes back in a delta, so a
  // local tombstone of it would never be undone.
  retireMovedDictionaryWords(words, { includeSynced = true } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("custom_dictionary");
      const rows = this.db
        .prepare(
          `SELECT id, word FROM custom_dictionary
           WHERE deleted_at IS NULL AND shared_at IS NOT NULL ${includeSynced ? "" : "AND cloud_id IS NULL"} AND ${scope.sql}
           ORDER BY id ASC`
        )
        .all(...scope.params);
      const requested = new Set(
        [...this._normalizeDictionaryWords(words).values()].map(dictionaryWordKey)
      );
      // A synced row is never pushed as a delete: the server retires it in the
      // same request, or keeps it when the word still applies through a list
      // this device never mirrored. The personal pull then settles it.
      const retire = this.db.prepare(
        "UPDATE custom_dictionary SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = CASE WHEN cloud_id IS NULL THEN 'pending' ELSE 'synced' END, fallback_retired = 1 WHERE id = ? AND deleted_at IS NULL"
      );
      const retired = [];
      this.db.transaction(() => {
        for (const row of rows) {
          if (!requested.has(dictionaryWordKey(row.word))) continue;
          retire.run(row.id);
          retired.push(row.word);
        }
      })();
      return { retired };
    } catch (error) {
      debugLogger.error(
        "Error retiring moved dictionary words",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Undoes retireMovedDictionaryWords for these words, as the API does when the
  // shared copy is restored or un-hidden. A tombstone the push already sent is
  // gone; the personal pull brings the server's revived row back instead. A
  // synced row comes back as synced: the server owns the revive, and the pull
  // reconciles whatever it decided.
  reviveRetiredDictionaryWords(words) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("custom_dictionary");
      const rows = this.db
        .prepare(
          `SELECT id, word FROM custom_dictionary WHERE deleted_at IS NOT NULL AND fallback_retired = 1 AND ${scope.sql} ORDER BY id ASC`
        )
        .all(...scope.params);
      const requested = new Set(
        [...this._normalizeDictionaryWords(words).values()].map(dictionaryWordKey)
      );
      const live = new Set(
        [...this._livePersonalRowsByLower().values()].map((row) => dictionaryWordKey(row.word))
      );
      const revive = this.db.prepare(
        "UPDATE custom_dictionary SET deleted_at = NULL, fallback_retired = 0, sync_status = CASE WHEN cloud_id IS NULL THEN 'pending' ELSE 'synced' END WHERE id = ?"
      );
      const revived = [];
      this.db.transaction(() => {
        for (const row of rows) {
          const key = dictionaryWordKey(row.word);
          // A live row with the same word (re-added meanwhile) already covers it.
          if (!requested.has(key) || live.has(key)) continue;
          revive.run(row.id);
          live.add(key);
          revived.push(row.word);
        }
      })();
      return { revived };
    } catch (error) {
      debugLogger.error(
        "Error reviving retired dictionary words",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getMovedDictionaryWords() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("custom_dictionary");
      return this.db
        .prepare(
          `SELECT word FROM custom_dictionary WHERE deleted_at IS NULL AND shared_at IS NOT NULL AND ${scope.sql} ORDER BY id ASC`
        )
        .all(...scope.params)
        .map((row) => row.word);
    } catch (error) {
      debugLogger.error(
        "Error getting moved dictionary words",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getSharedDictionary(workspaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const entries = this.db
        .prepare(
          `SELECT cloud_id, space_id, word, added_by_user_id, created_at, updated_at
           FROM shared_dictionary_entries WHERE workspace_id = ?
           ORDER BY created_at ASC, cloud_id ASC`
        )
        .all(workspaceId)
        .map((row) => ({
          cloudId: row.cloud_id,
          spaceId: row.space_id ?? null,
          word: row.word,
          addedByUserId: row.added_by_user_id ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      const hiddenIds = this.db
        .prepare(
          "SELECT entry_id FROM shared_dictionary_hides WHERE workspace_id = ? ORDER BY entry_id ASC"
        )
        .all(workspaceId)
        .map((row) => row.entry_id);
      const metaRow = this.db
        .prepare("SELECT * FROM shared_dictionary_meta WHERE workspace_id = ?")
        .get(workspaceId);
      return { entries, hiddenIds, meta: this._parseSharedDictionaryMeta(metaRow) };
    } catch (error) {
      debugLogger.error("Error getting shared dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  _parseSharedDictionaryMeta(row) {
    if (!row) return null;
    try {
      const scopes = JSON.parse(row.scopes_json);
      const contributors = JSON.parse(row.contributors_json);
      if (!Array.isArray(scopes) || !Array.isArray(contributors)) return null;
      return { scopes, contributors, paused: row.paused === 1, syncedAt: row.synced_at };
    } catch {
      return null;
    }
  }

  // Shared-dictionary writes keep each rule in one place so the delta and
  // snapshot paths can't drift apart.
  _sharedDictionaryStatements() {
    return {
      // Guarded so a re-applied, unchanged row (the sync's read overlap)
      // reports no change.
      upsertEntry: this.db.prepare(
        `INSERT INTO shared_dictionary_entries
           (cloud_id, workspace_id, space_id, word, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cloud_id) DO UPDATE SET
           workspace_id = excluded.workspace_id, space_id = excluded.space_id,
           word = excluded.word, added_by_user_id = excluded.added_by_user_id,
           created_at = excluded.created_at, updated_at = excluded.updated_at
         WHERE workspace_id IS NOT excluded.workspace_id OR space_id IS NOT excluded.space_id
           OR word IS NOT excluded.word OR added_by_user_id IS NOT excluded.added_by_user_id
           OR created_at IS NOT excluded.created_at OR updated_at IS NOT excluded.updated_at`
      ),
      deleteEntry: this.db.prepare(
        "DELETE FROM shared_dictionary_entries WHERE cloud_id = ? AND workspace_id = ?"
      ),
      entryIds: this.db.prepare(
        "SELECT cloud_id, space_id FROM shared_dictionary_entries WHERE workspace_id = ?"
      ),
      upsertHide: this.db.prepare(
        `INSERT INTO shared_dictionary_hides (entry_id, workspace_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           workspace_id = excluded.workspace_id, updated_at = excluded.updated_at
         WHERE workspace_id IS NOT excluded.workspace_id OR updated_at IS NOT excluded.updated_at`
      ),
      deleteHide: this.db.prepare(
        "DELETE FROM shared_dictionary_hides WHERE entry_id = ? AND workspace_id = ?"
      ),
      hideIds: this.db.prepare(
        "SELECT entry_id FROM shared_dictionary_hides WHERE workspace_id = ?"
      ),
      deleteOrphanHides: this.db.prepare(
        `DELETE FROM shared_dictionary_hides WHERE workspace_id = ? AND entry_id NOT IN
           (SELECT cloud_id FROM shared_dictionary_entries WHERE workspace_id = ?)`
      ),
      writeMeta: this.db.prepare(
        `INSERT OR REPLACE INTO shared_dictionary_meta
           (workspace_id, scopes_json, contributors_json, paused, synced_at)
         VALUES (?, ?, ?, ?, ?)`
      ),
    };
  }

  // Returns the rows changed; a row that can't be stored as-is (missing
  // fields, or another workspace's entry) is skipped so a malformed page never
  // corrupts the mirror.
  _upsertSharedEntry(stmts, workspaceId, entry) {
    if (!entry || typeof entry !== "object") return 0;
    if (typeof entry.id !== "string" || !entry.id) return 0;
    if (entry.workspace_id != null && entry.workspace_id !== workspaceId) return 0;
    const word = typeof entry.word === "string" ? entry.word.trim() : "";
    if (!word) return 0;
    if (typeof entry.created_at !== "string" || typeof entry.updated_at !== "string") return 0;
    if (entry.deleted_at) return this._deleteSharedEntry(stmts, workspaceId, entry.id);
    return stmts.upsertEntry.run(
      entry.id,
      workspaceId,
      typeof entry.space_id === "string" ? entry.space_id : null,
      word,
      typeof entry.added_by_user_id === "string" ? entry.added_by_user_id : null,
      entry.created_at,
      entry.updated_at
    ).changes;
  }

  // A hide never outlives its entry.
  _deleteSharedEntry(stmts, workspaceId, entryId) {
    const changes = stmts.deleteEntry.run(entryId, workspaceId).changes;
    stmts.deleteHide.run(entryId, workspaceId);
    return changes;
  }

  _writeSharedDictionaryMeta(stmts, workspaceId, meta) {
    if (
      !meta ||
      !Array.isArray(meta.scopes) ||
      !Array.isArray(meta.contributors) ||
      typeof meta.paused !== "boolean"
    ) {
      throw new Error("meta must have scopes and contributors arrays and a boolean paused");
    }
    stmts.writeMeta.run(
      workspaceId,
      JSON.stringify(meta.scopes),
      JSON.stringify(meta.contributors),
      meta.paused ? 1 : 0,
      new Date().toISOString()
    );
  }

  // Applies one delta page. The last page of a pass carries `meta`; its
  // scopes are the lists the member can still read, so words of a space they
  // lost go now rather than linger until the next snapshot.
  applySharedDictionaryPull(workspaceId, { upserts = [], deletedIds = [], meta } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmts = this._sharedDictionaryStatements();
      let changed = 0;
      this.db.transaction(() => {
        for (const entry of upserts) changed += this._upsertSharedEntry(stmts, workspaceId, entry);
        for (const id of deletedIds) {
          if (typeof id === "string" && id)
            changed += this._deleteSharedEntry(stmts, workspaceId, id);
        }
        if (meta === undefined) return;
        this._writeSharedDictionaryMeta(stmts, workspaceId, meta);
        const allowedSpaces = new Set(
          meta.scopes.map((s) => s?.space_id).filter((id) => typeof id === "string")
        );
        for (const row of stmts.entryIds.all(workspaceId)) {
          if (row.space_id !== null && !allowedSpaces.has(row.space_id)) {
            changed += stmts.deleteEntry.run(row.cloud_id, workspaceId).changes;
          }
        }
        stmts.deleteOrphanHides.run(workspaceId, workspaceId);
      })();
      return { changed };
    } catch (error) {
      debugLogger.error(
        "Error applying shared dictionary pull",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Snapshot write: the workspace's entries become exactly `entries`.
  replaceSharedDictionary(workspaceId, { entries = [], meta } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmts = this._sharedDictionaryStatements();
      let changed = 0;
      this.db.transaction(() => {
        const incomingIds = new Set(
          entries.filter((e) => e && !e.deleted_at && typeof e.id === "string").map((e) => e.id)
        );
        for (const row of stmts.entryIds.all(workspaceId)) {
          if (!incomingIds.has(row.cloud_id)) {
            changed += stmts.deleteEntry.run(row.cloud_id, workspaceId).changes;
          }
        }
        for (const entry of entries) changed += this._upsertSharedEntry(stmts, workspaceId, entry);
        this._writeSharedDictionaryMeta(stmts, workspaceId, meta);
        stmts.deleteOrphanHides.run(workspaceId, workspaceId);
      })();
      return { changed };
    } catch (error) {
      debugLogger.error("Error replacing shared dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  // A hide for an entry not mirrored yet is kept: the entry can arrive on a
  // later pass, and the hides cursor will have moved past the hide by then.
  _upsertSharedHide(stmts, workspaceId, hide) {
    if (!hide || typeof hide.entryId !== "string" || !hide.entryId) return 0;
    if (typeof hide.updatedAt !== "string" || !hide.updatedAt) return 0;
    return stmts.upsertHide.run(hide.entryId, workspaceId, hide.updatedAt).changes;
  }

  applySharedDictionaryHides(workspaceId, { hidden = [], unhidden = [] } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmts = this._sharedDictionaryStatements();
      let changed = 0;
      this.db.transaction(() => {
        for (const hide of hidden) changed += this._upsertSharedHide(stmts, workspaceId, hide);
        for (const id of unhidden) {
          if (typeof id === "string" && id)
            changed += stmts.deleteHide.run(id, workspaceId).changes;
        }
      })();
      return { changed };
    } catch (error) {
      debugLogger.error(
        "Error applying shared dictionary hides",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  replaceSharedDictionaryHides(workspaceId, hidden = []) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmts = this._sharedDictionaryStatements();
      let changed = 0;
      this.db.transaction(() => {
        const incomingIds = new Set(hidden.map((hide) => hide?.entryId));
        for (const row of stmts.hideIds.all(workspaceId)) {
          if (!incomingIds.has(row.entry_id)) {
            changed += stmts.deleteHide.run(row.entry_id, workspaceId).changes;
          }
        }
        for (const hide of hidden) changed += this._upsertSharedHide(stmts, workspaceId, hide);
      })();
      return { changed };
    } catch (error) {
      debugLogger.error(
        "Error replacing shared dictionary hides",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // With no workspace, clears every workspace (account change, sign-out).
  // `changed` counts the rows removed, meta rows included.
  clearSharedDictionary(workspaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      let changed = 0;
      this.db.transaction(() => {
        for (const table of SHARED_DICTIONARY_TABLES) {
          changed +=
            workspaceId == null
              ? this.db.prepare(`DELETE FROM ${table}`).run().changes
              : this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId)
                  .changes;
        }
      })();
      return { changed };
    } catch (error) {
      debugLogger.error("Error clearing shared dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  // Clears every workspace except the ones the member still belongs to.
  pruneSharedDictionary(keepWorkspaceIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const keep = JSON.stringify(keepWorkspaceIds.filter((id) => typeof id === "string"));
      let changed = 0;
      this.db.transaction(() => {
        for (const table of SHARED_DICTIONARY_TABLES) {
          changed += this.db
            .prepare(
              `DELETE FROM ${table} WHERE workspace_id NOT IN (SELECT value FROM json_each(?))`
            )
            .run(keep).changes;
        }
      })();
      return { changed };
    } catch (error) {
      debugLogger.error("Error pruning shared dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  getSnippets() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const scope = this._ownedRowScope("snippets");
      return this.db
        .prepare(
          `SELECT trigger, replacement FROM snippets WHERE deleted_at IS NULL AND ${scope.sql} ORDER BY id ASC`
        )
        .all(...scope.params);
    } catch (error) {
      debugLogger.error("Error getting snippets", { error: error.message }, "database");
      throw error;
    }
  }

  setSnippets(snippets) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }

      const incomingByLower = new Map();
      for (const raw of Array.isArray(snippets) ? snippets : []) {
        if (!raw || typeof raw !== "object") continue;
        const trigger = typeof raw.trigger === "string" ? raw.trigger.trim() : "";
        const replacement = typeof raw.replacement === "string" ? raw.replacement.trim() : "";
        if (!trigger || !replacement) continue;
        if (trigger.length > MAX_SNIPPET_TRIGGER_LENGTH) continue;
        const lower = foldKey(trigger);
        if (!incomingByLower.has(lower)) incomingByLower.set(lower, { trigger, replacement });
      }
      const cleaned = Array.from(incomingByLower.values());
      const incomingLower = new Set(incomingByLower.keys());

      const scope = this._ownedRowScope("snippets");
      const existingRows = this.db
        .prepare(`SELECT * FROM snippets WHERE ${scope.sql}`)
        .all(...scope.params);
      const existingByLower = rowsByFoldedKey(existingRows, "trigger");

      // As with dictionary words, the deleter pushes an unattributed tombstone.
      const tombstone = this.db.prepare(
        "UPDATE snippets SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = 'pending', account_id = COALESCE(account_id, ?) WHERE id = ? AND deleted_at IS NULL"
      );
      const restore = this.db.prepare(
        "UPDATE snippets SET deleted_at = NULL, trigger = ?, replacement = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?"
      );
      const updateActive = this.db.prepare(
        "UPDATE snippets SET trigger = ?, replacement = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND (trigger != ? OR replacement != ?)"
      );
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO snippets (trigger, replacement, client_snippet_id, sync_status, updated_at, account_id) VALUES (?, ?, ?, 'pending', datetime('now'), ?)"
      );

      this.db.transaction(() => {
        for (const existing of existingRows) {
          if (incomingLower.has(foldKey(existing.trigger))) continue;
          if (existing.deleted_at) continue;
          if (existing.cloud_id) {
            this._dropHiddenDuplicates("snippets", existing.trigger);
            tombstone.run(this.activeAccountId, existing.id);
          } else {
            this._hardDeleteKeyedRow("snippets", existing.id, existing);
          }
        }

        for (const snippet of cleaned) {
          const existing = existingByLower.get(foldKey(snippet.trigger));
          if (existing) {
            if (existing.deleted_at) {
              restore.run(snippet.trigger, snippet.replacement, existing.id);
            } else {
              updateActive.run(
                snippet.trigger,
                snippet.replacement,
                existing.id,
                snippet.trigger,
                snippet.replacement
              );
            }
            continue;
          }
          insert.run(snippet.trigger, snippet.replacement, randomUUID(), this.activeAccountId);
        }
      })();

      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting snippets", { error: error.message }, "database");
      throw error;
    }
  }

  // As seedDictionary.
  seedSnippets(snippets) {
    if (!this.db) throw new Error("Database not initialized");
    if (this.db.prepare("SELECT 1 FROM snippets LIMIT 1").get()) {
      return { success: true, seeded: false };
    }
    return { ...this.setSnippets(snippets), seeded: true };
  }

  getPendingSnippets() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._syncRowScope("snippets");
      return this.db
        .prepare(
          `SELECT * FROM snippets WHERE sync_status = 'pending' AND deleted_at IS NULL AND ${scope.sql}`
        )
        .all(...scope.params);
    } catch (error) {
      debugLogger.error("Error getting pending snippets", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingSnippetDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._syncRowScope("snippets");
      return this.db
        .prepare(
          `SELECT * FROM snippets WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending' AND ${scope.sql}`
        )
        .all(...scope.params);
    } catch (error) {
      debugLogger.error(
        "Error getting pending snippet deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteSnippet(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("snippets");
      return this.db.transaction(() => {
        const row = this.db
          .prepare(
            `SELECT trigger, account_id, deleted_at FROM snippets WHERE id = ? AND ${scope.sql}`
          )
          .get(id, ...scope.params);
        if (!row) return { success: false, id };
        this._hardDeleteKeyedRow("snippets", id, row);
        return { success: true, id };
      })();
    } catch (error) {
      debugLogger.error("Error hard deleting snippet", { error: error.message }, "database");
      throw error;
    }
  }

  getSnippetForCloudMerge(cloudEntry) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!cloudEntry || typeof cloudEntry !== "object") return null;

      const clientSnippetId =
        typeof cloudEntry.client_snippet_id === "string" && cloudEntry.client_snippet_id
          ? cloudEntry.client_snippet_id
          : "";
      // Only this account's rows (and unattributed ones) can merge.
      const scope = this._syncRowScope("snippets");
      if (clientSnippetId) {
        const byClient = this.db
          .prepare(`SELECT * FROM snippets WHERE client_snippet_id = ? AND ${scope.sql} LIMIT 1`)
          .get(clientSnippetId, ...scope.params);
        if (byClient) return byClient;
      }

      if (typeof cloudEntry.id === "string" && cloudEntry.id) {
        const byCloud = this.db
          .prepare(`SELECT * FROM snippets WHERE cloud_id = ? AND ${scope.sql} LIMIT 1`)
          .get(cloudEntry.id, ...scope.params);
        if (byCloud) return byCloud;
      }

      const trigger = typeof cloudEntry.trigger === "string" ? cloudEntry.trigger.trim() : "";
      if (!trigger) return null;
      const byTrigger = (deleted) =>
        this.db
          .prepare(
            `SELECT * FROM snippets
             WHERE fold_key(trigger) = fold_key(?) AND deleted_at IS ${deleted ? "NOT " : ""}NULL
               AND ${scope.sql} AND ${this._mergeableByKeySql("snippets")}
             ORDER BY account_id IS NULL LIMIT 1`
          )
          .get(trigger, ...scope.params) || null;
      return byTrigger(false) || byTrigger(true);
    } catch (error) {
      debugLogger.error(
        "Error getting snippet for cloud merge",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertSnippetFromCloud(cloudEntry) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!cloudEntry || typeof cloudEntry !== "object") return null;
      if (typeof cloudEntry.id !== "string" || !cloudEntry.id) return null;

      const trigger = typeof cloudEntry.trigger === "string" ? cloudEntry.trigger.trim() : "";
      const replacement =
        typeof cloudEntry.replacement === "string" ? cloudEntry.replacement.trim() : "";
      if (!trigger || !replacement) return null;

      const clientSnippetId =
        typeof cloudEntry.client_snippet_id === "string" && cloudEntry.client_snippet_id
          ? cloudEntry.client_snippet_id
          : randomUUID();
      const updatedAt =
        typeof cloudEntry.updated_at === "string" && cloudEntry.updated_at
          ? cloudEntry.updated_at
          : typeof cloudEntry.created_at === "string" && cloudEntry.created_at
            ? cloudEntry.created_at
            : new Date().toISOString();
      const createdAt =
        typeof cloudEntry.created_at === "string" && cloudEntry.created_at
          ? cloudEntry.created_at
          : updatedAt;

      const scope = this._syncRowScope("snippets");
      const sameClientId = this.db
        .prepare(
          `SELECT ${scope.sql} AS in_scope FROM snippets WHERE client_snippet_id = ? LIMIT 1`
        )
        .get(...scope.params, clientSnippetId);
      if (sameClientId && !sameClientId.in_scope) {
        debugLogger.warn(
          "Skipping cloud snippet whose local row this account can't see",
          {},
          "database"
        );
        return null;
      }

      const existing = this.getSnippetForCloudMerge({
        ...cloudEntry,
        client_snippet_id: clientSnippetId,
        trigger,
      });

      if (existing) {
        if (
          !existing.account_id &&
          this.activeAccountId &&
          (existing.client_snippet_id === clientSnippetId || existing.cloud_id === cloudEntry.id) &&
          !isCloudEntryNewer(updatedAt, existing.updated_at)
        ) {
          const claim = this._claimUnattributedSql("snippets", { proven: true });
          this.db
            .prepare(`UPDATE snippets SET ${claim.sql} WHERE id = ?`)
            .run(...claim.params, existing.id);
          return this.db.prepare("SELECT * FROM snippets WHERE id = ?").get(existing.id);
        }
        // A different active row may already hold this trigger (cross-device
        // rename); it must yield first or the UPDATE trips the active-trigger
        // unique index and aborts the pull.
        const collidingActive = this.db
          .prepare(
            `SELECT * FROM snippets
             WHERE fold_key(trigger) = fold_key(?) AND deleted_at IS NULL AND id != ?
               AND ${scope.sql} AND ${this._mergeableByKeySql("snippets")}
             LIMIT 1`
          )
          .get(trigger, existing.id, ...scope.params);
        // Tombstone existing → keep the active collider; else keep existing and
        // drop the stale collider.
        const target = existing.deleted_at && collidingActive ? collidingActive : existing;
        const orphanId = target.id === existing.id ? collidingActive?.id : existing.id;
        if (orphanId) {
          this.db.prepare("DELETE FROM snippets WHERE id = ?").run(orphanId);
        }
        if (foldKey(target.trigger) !== foldKey(trigger)) {
          this._dropHiddenDuplicates("snippets", target.trigger);
        }
        const claim = this._claimUnattributedSql("snippets", {
          proven: target.client_snippet_id === clientSnippetId || target.cloud_id === cloudEntry.id,
        });
        this.db
          .prepare(
            `UPDATE snippets
             SET cloud_id = ?, client_snippet_id = ?, trigger = ?, replacement = ?,
                 sync_status = 'synced', deleted_at = NULL, updated_at = ?,
                 ${claim.sql}
             WHERE id = ?`
          )
          .run(
            cloudEntry.id,
            clientSnippetId,
            trigger,
            replacement,
            updatedAt,
            ...claim.params,
            target.id
          );
        return this.db.prepare("SELECT * FROM snippets WHERE id = ?").get(target.id);
      }

      this.db
        .prepare(
          `INSERT INTO snippets
             (trigger, replacement, client_snippet_id, cloud_id, sync_status, created_at, updated_at, account_id)
           VALUES (?, ?, ?, ?, 'synced', ?, ?, ?)`
        )
        .run(
          trigger,
          replacement,
          clientSnippetId,
          cloudEntry.id,
          createdAt,
          updatedAt,
          this.activeAccountId
        );
      return this.db
        .prepare("SELECT * FROM snippets WHERE client_snippet_id = ?")
        .get(clientSnippetId);
    } catch (error) {
      debugLogger.error("Error upserting snippet from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markSnippetSynced(
    id,
    cloudId,
    serverUpdatedAt = null,
    expectedTrigger = null,
    expectedReplacement = null
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // If a user edit landed between push and ack, the row no longer matches
      // what was pushed — leave it 'pending' so the next sync re-pushes it.
      const claim = this._claimUnattributedSql("snippets");
      const result = this.db
        .prepare(
          `UPDATE snippets
           SET sync_status = 'synced',
               cloud_id = ?,
               updated_at = COALESCE(?, updated_at),
               ${claim.sql}
           WHERE id = ? AND deleted_at IS NULL
             AND (account_id IS NULL OR account_id = ?)
             AND (? IS NULL OR trigger = ?)
             AND (? IS NULL OR replacement = ?)`
        )
        .run(
          cloudId,
          serverUpdatedAt,
          ...claim.params,
          id,
          this.activeAccountId,
          expectedTrigger,
          expectedTrigger,
          expectedReplacement,
          expectedReplacement
        );
      return { success: result.changes > 0, changes: result.changes };
    } catch (error) {
      debugLogger.error("Error marking snippet synced", { error: error.message }, "database");
      throw error;
    }
  }

  clearSnippetCloudId(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // As with dictionary words.
      return { success: this._clearCloudIdOfOwnRow("snippets", id) > 0 };
    } catch (error) {
      debugLogger.error("Error clearing snippet cloud_id", { error: error.message }, "database");
      throw error;
    }
  }

  keepNewerSnippetEdit(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return { success: this._keepNewerEditOverCloudDelete("snippets", id) > 0 };
    } catch (error) {
      debugLogger.error(
        "Error keeping a snippet edit over its cloud deletion",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getSkillStates() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const toIso = (value) => parseDbTimestamp(value)?.toISOString() ?? null;
      return this.db
        .prepare("SELECT * FROM skills ORDER BY created_at DESC, id DESC")
        .all()
        .map((row) => ({
          name: row.name,
          enabled: row.enabled === 1,
          contentHash: row.content_hash,
          lastUsedAt: toIso(row.last_used_at),
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
        }));
    } catch (error) {
      debugLogger.error("Error getting skill states", { error: error.message }, "database");
      throw error;
    }
  }

  // Inserts the row (on unless told otherwise) or updates the states given; a new
  // content hash also stamps updated_at.
  upsertSkillState(name, { enabled, contentHash } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          `INSERT INTO skills (name, enabled, content_hash)
           VALUES (@name, COALESCE(@enabled, 1), @contentHash)
           ON CONFLICT(name) DO UPDATE SET
             enabled = COALESCE(@enabled, enabled),
             content_hash = COALESCE(@contentHash, content_hash),
             updated_at = CASE
               WHEN @contentHash IS NOT NULL AND content_hash IS NOT @contentHash
               THEN datetime('now') ELSE updated_at END`
        )
        .run({
          name,
          enabled: enabled === undefined ? null : Number(enabled),
          contentHash: contentHash ?? null,
        });
    } catch (error) {
      debugLogger.error("Error saving skill state", { error: error.message }, "database");
      throw error;
    }
  }

  // Recovery restores the original timestamps too, without recording a new content change.
  restoreSkillState(name, state) {
    if (state === null) return this.deleteSkillState(name);
    try {
      if (!this.db) throw new Error("Database not initialized");
      const toSkillTimestamp = (value) => toDbTimestamp(value)?.replace(/(?:\.000)?Z$/, "") ?? null;
      this.db
        .prepare(
          `INSERT INTO skills (name, enabled, content_hash, last_used_at, created_at, updated_at)
           VALUES (@name, @enabled, @contentHash, @lastUsedAt, @createdAt, @updatedAt)
           ON CONFLICT(name) DO UPDATE SET
             enabled = excluded.enabled,
             content_hash = excluded.content_hash,
             last_used_at = excluded.last_used_at,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`
        )
        .run({
          name,
          enabled: Number(state.enabled),
          contentHash: state.contentHash,
          lastUsedAt: toSkillTimestamp(state.lastUsedAt),
          createdAt: toSkillTimestamp(state.createdAt),
          updatedAt: toSkillTimestamp(state.updatedAt),
        });
    } catch (error) {
      debugLogger.error("Error restoring skill state", { error: error.message }, "database");
      throw error;
    }
  }

  setSkillEnabled(name, enabled) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("UPDATE skills SET enabled = ? WHERE name = ?")
        .run(Number(enabled), name);
      return result.changes > 0;
    } catch (error) {
      debugLogger.error("Error switching skill", { error: error.message }, "database");
      throw error;
    }
  }

  markSkillUsed(name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE skills SET last_used_at = datetime('now') WHERE name = ?").run(name);
    } catch (error) {
      debugLogger.error("Error marking skill used", { error: error.message }, "database");
      throw error;
    }
  }

  deleteSkillState(name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM skills WHERE name = ?").run(name);
    } catch (error) {
      debugLogger.error("Error deleting skill state", { error: error.message }, "database");
      throw error;
    }
  }

  saveNote(
    title,
    content,
    noteType = "personal",
    sourceFile = null,
    audioDuration = null,
    folderId = null,
    spaceId = null,
    transcript = null
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      if (folderId) {
        // D2: a note's space always follows its folder's space.
        const folder = this._getFolderInAccountScope(folderId);
        if (!folder) throw new Error("Folder not found in the active account scope");
        spaceId = folder.space_id;
      } else {
        if (spaceId == null) spaceId = this.getPrivateSpaceId();
        const space = this.getSpace(spaceId);
        if (!space) throw new Error("Space not found in the active account scope");
        const defaultFolderName = noteType === "meeting" ? "Meetings" : "Personal";
        if (space.kind === "private") {
          this.ensureDefaultFolders(spaceId);
          folderId = this._privateFolderNamed(spaceId, space.account_id, defaultFolderName);
        } else {
          const folderScope = this._accountScopeCondition("folders");
          const defaultFolder = this.db
            .prepare(
              `SELECT id FROM folders
               WHERE name = ? AND is_default = 1 AND space_id = ? AND ${folderScope.sql}`
            )
            .get(defaultFolderName, spaceId, ...folderScope.params);
          folderId = defaultFolder?.id || null;
        }
      }
      const clientNoteId = randomUUID();
      const accountId = this._accountIdForSpace(spaceId);
      const stmt = this.db.prepare(
        "INSERT INTO notes (title, content, content_sync_operation, note_type, source_file, audio_duration_seconds, folder_id, space_id, client_note_id, account_id, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(
        title,
        content,
        typedTextOperation(content),
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        spaceId,
        clientNoteId,
        accountId,
        transcript
      );

      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(result.lastInsertRowid);

      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error saving note", { error: error.message }, "notes");
      throw error;
    }
  }

  /**
   * Bulk-insert externally imported notes (e.g. a Granola CSV export).
   * Unlike saveNote, rows carry their own client_note_id and original
   * created_at/updated_at; the UNIQUE client_note_id index makes re-imports
   * idempotent (duplicates are skipped, never overwritten).
   */
  importNotes(rows, { noteType = "meeting", folderName = "Imported" } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const spaceId = this.getPrivateSpaceId();
      const accountId = this._accountIdForSpace(spaceId);

      let folderId = null;
      try {
        const folderScope = this._accountScopeCondition("folders");
        const existing = this.db
          .prepare(
            `SELECT id FROM folders
             WHERE name = ? AND space_id = ? AND deleted_at IS NULL AND ${folderScope.sql}`
          )
          .get(folderName, spaceId, ...folderScope.params);
        folderId = existing?.id ?? this.createFolder(folderName, spaceId)?.folder?.id ?? null;
      } catch (folderError) {
        debugLogger.error(
          "Import folder resolution failed; importing without a folder",
          { error: folderError.message },
          "notes"
        );
      }

      const insert = this.db.prepare(`
        INSERT INTO notes (client_note_id, title, content, content_sync_operation, note_type, source_file,
          folder_id, space_id, account_id, transcript, participants, sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
          COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
        ON CONFLICT(client_note_id) DO NOTHING
      `);

      // A note that moved into a teamspace took a new client id (D39), so
      // the source key it stored is what still recognises it.
      const importedSources = this._storedNoteValues(
        "source_file",
        rows.map((row) => row.sourceFile).filter(Boolean)
      );

      let imported = 0;
      let skipped = 0;
      const noteIds = [];
      const errors = [];
      this.db.transaction(() => {
        for (const row of rows) {
          try {
            if (row.sourceFile && importedSources.has(row.sourceFile)) {
              skipped++;
              continue;
            }
            const result = insert.run(
              row.clientNoteId,
              row.title,
              row.content,
              typedTextOperation(row.content),
              noteType,
              row.sourceFile,
              folderId,
              spaceId,
              accountId,
              row.transcript,
              row.participants,
              row.createdAt,
              row.createdAt
            );
            if (result.changes === 1) {
              imported++;
              noteIds.push(Number(result.lastInsertRowid));
              if (row.sourceFile) importedSources.add(row.sourceFile);
            } else {
              skipped++;
            }
          } catch (rowError) {
            errors.push({ clientNoteId: row.clientNoteId, error: rowError.message });
          }
        }
      })();

      return { success: true, imported, skipped, folderId, noteIds, errors };
    } catch (error) {
      debugLogger.error("Error importing notes", { error: error.message }, "notes");
      throw error;
    }
  }

  // The values of a notes column already stored, among the ones given.
  _storedNoteValues(column, values) {
    const stored = new Set();
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      for (const value of this.db
        .prepare(`SELECT ${column} FROM notes WHERE ${column} IN (${placeholders})`)
        .pluck()
        .all(...chunk)) {
        stored.add(value);
      }
    }
    return stored;
  }

  // The import rows importNotes would skip: their client id or their source
  // key is already stored. Answers their client ids.
  getImportedClientNoteIds(rows) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const clientIds = this._storedNoteValues(
        "client_note_id",
        rows.map((row) => row.clientNoteId)
      );
      const sources = this._storedNoteValues(
        "source_file",
        rows.map((row) => row.sourceFile).filter(Boolean)
      );
      return rows
        .filter(
          (row) =>
            clientIds.has(row.clientNoteId) || (row.sourceFile && sources.has(row.sourceFile))
        )
        .map((row) => row.clientNoteId);
    } catch (error) {
      debugLogger.error("Error checking imported notes", { error: error.message }, "notes");
      throw error;
    }
  }

  getNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const accountScope = this._accountScopeCondition("notes");
      const stmt = this.db.prepare(`SELECT * FROM notes WHERE id = ? AND ${accountScope.sql}`);
      return stmt.get(id, ...accountScope.params) || null;
    } catch (error) {
      debugLogger.error("Error getting note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNoteByCloudId(cloudId) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const accountScope = this._accountScopeCondition("notes");
      const stmt = this.db.prepare(
        `SELECT * FROM notes
         WHERE cloud_id = ? AND deleted_at IS NULL AND ${accountScope.sql}
         LIMIT 1`
      );
      return stmt.get(cloudId, ...accountScope.params) || null;
    } catch (error) {
      debugLogger.error("Error getting note by cloud_id", { error: error.message }, "notes");
      throw error;
    }
  }

  getNotes(noteType = null, limit = 100, folderId = null, spaceId = null, spaceIds = null) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      const accountScope = this._accountScopeCondition("notes");
      conditions.push(accountScope.sql);
      params.push(...accountScope.params);
      if (noteType) {
        conditions.push("note_type = ?");
        params.push(noteType);
      }
      if (folderId != null) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      } else if (spaceId != null) {
        // spaceId without folderId lists a space's root: folderless notes only.
        conditions.push("folder_id IS NULL");
      }
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      const spaceList = noteSpaceListCondition("space_id", spaceIds);
      if (spaceList) {
        conditions.push(spaceList.sql);
        params.push(spaceList.param);
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

  // Unlike getNotes(null, limit, null, spaceId) — which is root-only — this
  // lists every note in the space, foldered or not (space overview list).
  getNotesForSpace(spaceId, limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("notes");
      return this.db
        .prepare(
          `SELECT * FROM notes
           WHERE space_id = ? AND deleted_at IS NULL AND ${accountScope.sql}
           ORDER BY updated_at DESC LIMIT ?`
        )
        .all(spaceId, ...accountScope.params, limit);
    } catch (error) {
      debugLogger.error("Error getting notes for space", { error: error.message }, "notes");
      throw error;
    }
  }

  getNoteIdsInFolder(folderId) {
    return this.getNoteIdsInScope(null, folderId);
  }

  // Authoritative scope membership for semantic-search candidates. Qdrant
  // payload writes are asynchronous/best-effort, so its filters are only an
  // optimization and must not decide which space or folder a hit belongs to:
  // a note moved since it was indexed still carries its old space there.
  getNoteIdsInScope(spaceId = null, folderId = null, candidateIds = null, spaceIds = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (candidateIds && candidateIds.length === 0) return [];
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      const accountScope = this._accountScopeCondition("notes");
      conditions.push(accountScope.sql);
      params.push(...accountScope.params);
      if (candidateIds) {
        conditions.push(`id IN (${candidateIds.map(() => "?").join(", ")})`);
        params.push(...candidateIds);
      }
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      if (folderId != null) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      }
      const spaceList = noteSpaceListCondition("space_id", spaceIds);
      if (spaceList) {
        conditions.push(spaceList.sql);
        params.push(spaceList.param);
      }
      return this.db
        .prepare(`SELECT id FROM notes WHERE ${conditions.join(" AND ")}`)
        .all(...params)
        .map((row) => row.id);
    } catch (error) {
      debugLogger.error("Error getting scoped note ids", { error: error.message }, "notes");
      throw error;
    }
  }

  getNoteUndos() {
    return this.noteUndoReady ? noteUndo.getNoteUndos(this) : [];
  }

  claimNoteUndo(token) {
    return this.noteUndoReady && noteUndo.claimNoteUndo(this, token);
  }

  undoNoteUpdate(token) {
    if (!this.noteUndoReady) return { success: false, error: "note_changed" };
    return noteUndo.undoNoteUpdate(this, token);
  }

  discardNoteUndo(id, token) {
    if (this.noteUndoReady) noteUndo.discardNoteUndo(this, id, token);
  }

  updateNote(id, updates, options) {
    if (options?.undoable && this.noteUndoReady) {
      return noteUndo.updateNoteWithUndo(this, id, updates, options.expected, options.turn);
    }
    try {
      if (!this.db) throw new Error("Database not initialized");
      const previous = this.getNote(id);
      if (!previous) return { success: false, error: "Note not found" };
      updates = { ...updates };
      const onlyMoves = Object.keys(updates).every(
        (key) => key === "space_id" || key === "folder_id"
      );
      let localMove = false;
      // An unlink is stored as "" so it syncs: the cloud keeps a NULL as "unchanged".
      if (updates.calendar_event_id === null && previous.calendar_event_id != null) {
        updates.calendar_event_id = "";
      }
      const clears = updates.clear_fields ?? [];
      if (!Array.isArray(clears) || clears.some((field) => !NOTE_TEXT_FIELDS.includes(field))) {
        return { success: false, error: "Invalid note clear fields" };
      }
      for (const field of NOTE_TEXT_FIELDS) {
        delete updates[`${field}_sync_operation`];
        delete updates[`${field}_edit_generation`];
        if (clears.includes(field)) {
          if (
            updates[field] != null &&
            (typeof updates[field] !== "string" || updates[field].trim())
          ) {
            return { success: false, error: "A clear cannot include nonempty text" };
          }
          updates[field] = field === "content" ? "" : null;
          updates[`${field}_sync_operation`] = "clear";
          if (field === "enhanced_content") {
            for (const key of SUMMARY_CLEARED_METADATA) updates[key] = null;
          }
        } else if (
          typeof updates[field] === "string" &&
          updates[field].trim() &&
          updates[field] !== previous[field]
        ) {
          updates[`${field}_sync_operation`] = "set";
        } else if (updates[field] !== undefined && !updates[field]?.trim()) {
          // Preserve the existing local save contract, but never turn an
          // untrusted blank into a sync operation.
          updates[`${field}_sync_operation`] =
            !previous[field]?.trim() && previous[`${field}_sync_operation`] === "clear"
              ? "clear"
              : null;
        }
      }
      if (
        !clears.includes("enhanced_content") &&
        (updates.enhanced_content === undefined || updates.enhanced_content?.trim()) &&
        (updates.enhanced_content ?? previous.enhanced_content)?.trim() &&
        SUMMARY_METADATA.some((key) => updates[key] !== undefined && updates[key] !== previous[key])
      ) {
        updates.enhanced_content_sync_operation = "set";
      }
      delete updates.clear_fields;
      delete updates.account_id;
      delete updates.cloud_revision;
      delete updates.cloud_create_rejected;
      delete updates.cloud_create_pending;
      delete updates.cloud_create_attempted;
      const newIdentity =
        updates.client_note_id && updates.client_note_id !== previous.client_note_id;
      if (updates.cloud_id === null || newIdentity) {
        updates.cloud_revision = null;
        updates.cloud_create_rejected = 0;
        updates.cloud_create_pending = null;
      }
      // A new identity has never been sent. A note that only lost its cloud link
      // keeps its identity, which an earlier create may have stored.
      if (newIdentity) updates.cloud_create_attempted = 0;
      if (updates.folder_id != null) {
        // D2: a note's space always follows its folder's space.
        const folder = this._getFolderInAccountScope(updates.folder_id);
        if (folder) updates = { ...updates, space_id: folder.space_id };
        else return { success: false, error: "Folder not found" };
      }
      if (updates.space_id !== undefined) {
        if (!this.getSpace(updates.space_id)) {
          return { success: false, error: "Space not found" };
        }
        updates.account_id = this._accountIdForSpace(updates.space_id);
        // A team note the cloud holds never moves to a Private (D31). Identity
        // forks null the cloud_id in the same write, so they still land there;
        // a note whose create is still in flight has no cloud_id yet and moves,
        // its acknowledgement detaching it (_leftTeamDuringPush).
        const current = this.db
          .prepare(
            "SELECT n.space_id, n.cloud_id, n.is_shared, s.kind AS space_kind FROM notes n LEFT JOIN spaces s ON s.id = n.space_id WHERE n.id = ?"
          )
          .get(id);
        if (current && current.space_id !== updates.space_id) {
          const newKind = this.db
            .prepare("SELECT kind FROM spaces WHERE id = ?")
            .get(updates.space_id)?.kind;
          const keepsCloudId =
            updates.cloud_id === undefined ? current.cloud_id != null : updates.cloud_id != null;
          if (current.space_kind === "private" && newKind === "private") {
            // Between two of the account's own Private sections. The cloud
            // never knew which one held the note: a move alone is local, with
            // nothing to retract and nothing to upload.
            if (!this._ownPrivateSpaces(current.space_id, updates.space_id)) {
              return { success: false, error: "Space not found" };
            }
            localMove = onlyMoves;
          } else if (current.space_kind === "team" && newKind === "private" && keepsCloudId) {
            return teamRowSyncedRefusal();
          } else if (newKind === "team") {
            updates = { ...updates, left_team: 0 };
            if (
              current.space_kind === "private" &&
              updates.cloud_id === undefined &&
              updates.client_note_id === undefined &&
              !isLegacySharedNote(current)
            ) {
              updates = {
                ...updates,
                ...BACKUP_NOTE_CLOUD_IDENTITY,
                client_note_id: randomUUID(),
              };
            }
          }
        }
      }
      const allowedFields = [
        "content_sync_operation",
        "enhanced_content_sync_operation",
        "cloud_revision",
        "cloud_create_rejected",
        "cloud_create_pending",
        "cloud_create_attempted",
        "title",
        "content",
        "enhanced_content",
        "enhancement_prompt",
        "enhancement_template_id",
        "enhanced_at_content_hash",
        "folder_id",
        "space_id",
        "transcript",
        "calendar_event_id",
        "participants",
        "diarization_enabled",
        "expected_speaker_count",
        "sync_status",
        "deleted_at",
        "client_note_id",
        "cloud_id",
        "cloud_updated_at",
        "owner_user_id",
        "updated_by_user_id",
        "left_team",
        "account_id",
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
      // Undo can return to the submitted text within the same SQLite second.
      // Keep that newer intent distinct from the in-flight request snapshot.
      for (const field of NOTE_TEXT_FIELDS) {
        const keys = [
          field,
          `${field}_sync_operation`,
          ...(field === "enhanced_content" ? SUMMARY_METADATA : []),
        ];
        if (
          clears.includes(field) ||
          keys.some((key) => updates[key] !== undefined && updates[key] !== previous[key])
        ) {
          fields.push(`${field}_edit_generation = ${field}_edit_generation + 1`);
        }
      }
      // Re-queue for cloud sync on any local edit, so post-sync field changes aren't
      // left local-only and overwritten by a later pull. A move between Private
      // sections changes nothing the cloud holds.
      if (!localMove) {
        if (!("sync_status" in updates)) {
          fields.push("sync_status = 'pending'");
        }
        fields.push("updated_at = CURRENT_TIMESTAMP");
      }
      values.push(id);
      const accountScope = this._accountScopeCondition("notes");
      const stmt = this.db.prepare(
        `UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND ${accountScope.sql}`
      );
      const result = stmt.run(...values, ...accountScope.params);
      if (result.changes === 0) return { success: false, error: "Note not found" };
      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(id);
      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error updating note", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolders(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      const accountScope = this._accountScopeCondition("folders");
      conditions.push(accountScope.sql);
      params.push(...accountScope.params);
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      return this.db
        .prepare(
          `SELECT * FROM folders WHERE ${conditions.join(" AND ")} ORDER BY sort_order ASC, created_at ASC`
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error getting folders", { error: error.message }, "notes");
      throw error;
    }
  }

  createFolder(name, spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      if (spaceId == null) spaceId = this.getPrivateSpaceId();
      if (!this.getSpace(spaceId)) {
        return { success: false, error: "Space not found" };
      }
      const accountScope = this._accountScopeCondition("folders");
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND ${FOLDER_NAME_TAKEN_FILTER}
             AND ${accountScope.sql}`
        )
        .get(trimmed, spaceId, ...accountScope.params);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      const maxOrder = this.db
        .prepare("SELECT MAX(sort_order) as max_order FROM folders WHERE space_id = ?")
        .get(spaceId);
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const clientFolderId = randomUUID();
      const accountId = this._accountIdForSpace(spaceId);
      const result = this.db
        .prepare(
          "INSERT INTO folders (name, sort_order, space_id, client_folder_id, account_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run(trimmed, sortOrder, spaceId, clientFolderId, accountId);
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, folder };
    } catch (error) {
      debugLogger.error("Error creating folder", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteAccountData(accountId) {
    if (!this.db) throw new Error("Database not initialized");
    if (!accountId || accountId !== this.activeAccountId) {
      throw new Error("Account deletion must match the active account scope");
    }

    // The account's private spaces go with everything in them, and so does
    // anything of the account's left in the stand-in.
    const deletedSpaceIds = this.db
      .prepare("SELECT id FROM spaces WHERE kind = 'private' AND account_id = ? ORDER BY id")
      .all(accountId)
      .map((row) => row.id);
    const deletedNoteIds = this.db
      .prepare(
        `SELECT notes.id
         FROM notes
         JOIN spaces ON spaces.id = notes.space_id
         WHERE spaces.kind = 'private' AND (notes.account_id = ? OR spaces.account_id = ?)
         ORDER BY notes.id`
      )
      .all(accountId, accountId)
      .map((row) => row.id);
    const deletedFolderIds = this.db
      .prepare(
        `SELECT folders.id
         FROM folders
         JOIN spaces ON spaces.id = folders.space_id
         WHERE spaces.kind = 'private' AND (folders.account_id = ? OR spaces.account_id = ?)
         ORDER BY folders.id`
      )
      .all(accountId, accountId)
      .map((row) => row.id);

    // The account's own history, chats, words and snippets, in every space. Rows
    // from before attribution are the account's too if nobody else used this
    // device; otherwise they may be someone else's, and stay.
    const legacyRowsAreOwned = !this.hasOtherAccountRows();
    const owned = (tableName) =>
      legacyRowsAreOwned
        ? `(account_id = ? OR (account_id IS NULL AND ${tableName}.legacy_unattributed != 0))`
        : "account_id = ?";
    const deletedTranscriptionIds = this.db
      .prepare(`SELECT id FROM transcriptions WHERE ${owned("transcriptions")} ORDER BY id`)
      .all(accountId)
      .map((row) => row.id);

    const notePlaceholders = deletedNoteIds.map(() => "?").join(", ");
    const folderPlaceholders = deletedFolderIds.map(() => "?").join(", ");
    const spacePlaceholders = deletedSpaceIds.map(() => "?").join(", ");
    const deleteRows = () => {
      const conversationConditions = [owned("agent_conversations")];
      const conversationParams = [accountId];
      if (deletedSpaceIds.length > 0) {
        conversationConditions.push(`space_id IN (${spacePlaceholders})`);
        conversationParams.push(...deletedSpaceIds);
      }
      if (deletedNoteIds.length > 0) {
        conversationConditions.push(`note_id IN (${notePlaceholders})`);
        conversationParams.push(...deletedNoteIds);
      }
      if (deletedFolderIds.length > 0) {
        conversationConditions.push(`folder_id IN (${folderPlaceholders})`);
        conversationParams.push(...deletedFolderIds);
      }
      const conversationIds = this.db
        .prepare(`SELECT id FROM agent_conversations WHERE ${conversationConditions.join(" OR ")}`)
        .all(...conversationParams)
        .map((row) => row.id);
      if (conversationIds.length > 0) {
        const conversationPlaceholders = conversationIds.map(() => "?").join(", ");
        // Chats are personal in every space, so one in a team folder another
        // account's held delete journaled goes too; its restore can't find it.
        this.db
          .prepare(
            `DELETE FROM optimistic_folder_delete_rows WHERE entity_type = 'conversation' AND entity_id IN (${conversationPlaceholders})`
          )
          .run(...conversationIds);
        this.db
          .prepare(
            `DELETE FROM agent_messages WHERE conversation_id IN (${conversationPlaceholders})`
          )
          .run(...conversationIds);
        this.db
          .prepare(`DELETE FROM agent_conversations WHERE id IN (${conversationPlaceholders})`)
          .run(...conversationIds);
      }

      if (deletedNoteIds.length > 0) {
        this.db
          .prepare(`DELETE FROM speaker_mappings WHERE note_id IN (${notePlaceholders})`)
          .run(...deletedNoteIds);
        this.db
          .prepare(`DELETE FROM note_speaker_embeddings WHERE note_id IN (${notePlaceholders})`)
          .run(...deletedNoteIds);
        this.db
          .prepare(`DELETE FROM notes WHERE id IN (${notePlaceholders})`)
          .run(...deletedNoteIds);
      }
      if (deletedFolderIds.length > 0) {
        this.db
          .prepare(
            `DELETE FROM optimistic_folder_delete_rows WHERE folder_id IN (${folderPlaceholders})`
          )
          .run(...deletedFolderIds);
        this.db
          .prepare(`DELETE FROM folders WHERE id IN (${folderPlaceholders})`)
          .run(...deletedFolderIds);
      }
      if (deletedSpaceIds.length > 0) {
        this.db
          .prepare(`DELETE FROM spaces WHERE id IN (${spacePlaceholders})`)
          .run(...deletedSpaceIds);
      }
      for (const table of ["transcriptions", "custom_dictionary", "snippets"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE ${owned(table)}`).run(accountId);
      }
      this.db.prepare("DELETE FROM analytics_events WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM analytics_clear_requests WHERE account_id = ?").run(accountId);
      this.db
        .prepare("DELETE FROM analytics_account_clear_state WHERE account_scope = ?")
        .run(accountId);
      this.db.prepare("DELETE FROM connector_actions WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM space_accounts WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM device_accounts WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM account_workspace_scopes WHERE account_id = ?").run(accountId);
    };

    if (typeof this.db.transaction === "function") {
      this.db.transaction(deleteRows)();
    } else {
      this.db.exec("BEGIN");
      try {
        deleteRows();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    return { deletedNoteIds, deletedFolderIds, deletedTranscriptionIds };
  }

  deleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getFolderInAccountScope(id);
      if (folder?.deleted_at) return { success: false, error: "Folder not found" };
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot delete default folders" };
      const allChildNotes = "SELECT id FROM notes WHERE folder_id = ?";
      const childNotes = `${allChildNotes} AND deleted_at IS NULL`;
      const accountScope = this._accountScopeCondition("notes");
      const noteIds = this.db
        .prepare(`${childNotes} AND ${accountScope.sql}`)
        .all(id, ...accountScope.params)
        .map((row) => row.id);
      let relocatedNotes = [];
      this.db.transaction(() => {
        relocatedNotes = this._releaseOutOfScopeChildNotes(id);
        if (!folder.cloud_id) {
          // There is no server operation to deny. Local-only folders can
          // finalize immediately, including their local-only child content.
          this._retireConversationsWhere(`note_id IN (${allChildNotes})`, [id], {
            scrubSyncedMessages: true,
          });
          this._deleteSpeakerRowsForNotes(allChildNotes, id);
          this.db.prepare("DELETE FROM notes WHERE folder_id = ?").run(id);
          this._retireConversationsWhere("folder_id = ?", [id], {
            scrubSyncedMessages: true,
          });
          this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
          return;
        }

        const journal = this.db.prepare(
          `INSERT OR IGNORE INTO optimistic_folder_delete_rows
             (folder_id, entity_type, entity_id, original_sync_status,
              original_deleted_at, original_updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        journal.run(
          id,
          "folder",
          id,
          folder.sync_status ?? "synced",
          folder.deleted_at ?? null,
          folder.updated_at ?? null
        );

        const activeNotes = this.db.prepare(
          "SELECT id, sync_status, deleted_at, updated_at FROM notes WHERE folder_id = ? AND deleted_at IS NULL"
        );
        for (const note of activeNotes.all(id)) {
          journal.run(
            id,
            "note",
            note.id,
            note.sync_status ?? "pending",
            note.deleted_at ?? null,
            note.updated_at ?? null
          );
        }

        // Only live conversations belong to this rollback. A tombstone that
        // predates the folder action is an independent user-requested delete
        // and must remain pending on both denial and confirmation.
        const activeConversations = this.db
          .prepare(
            `SELECT id, sync_status, deleted_at, updated_at
             FROM agent_conversations
             WHERE deleted_at IS NULL
               AND (folder_id = ? OR note_id IN (${childNotes}))`
          )
          .all(id, id);
        for (const conversation of activeConversations) {
          journal.run(
            id,
            "conversation",
            conversation.id,
            conversation.sync_status ?? "pending",
            conversation.deleted_at ?? null,
            conversation.updated_at ?? null
          );
        }

        // Keep every child row and message body in place while hiding them
        // from normal readers and all per-note/per-conversation sync queues.
        this.db
          .prepare(
            `UPDATE notes
             SET deleted_at = datetime('now'), sync_status = 'folder_delete_pending',
                 updated_at = datetime('now')
             WHERE id IN (
               SELECT entity_id FROM optimistic_folder_delete_rows
               WHERE folder_id = ? AND entity_type = 'note'
             )`
          )
          .run(id);
        this.db
          .prepare(
            `UPDATE agent_conversations
             SET deleted_at = datetime('now'), sync_status = 'folder_delete_pending',
                 updated_at = datetime('now')
             WHERE id IN (
               SELECT entity_id FROM optimistic_folder_delete_rows
               WHERE folder_id = ? AND entity_type = 'conversation'
             )`
          )
          .run(id);
        this.db
          .prepare(
            `UPDATE folders
             SET deleted_at = datetime('now'), updated_at = datetime('now'),
                 sync_status = 'pending'
             WHERE id = ?`
          )
          .run(id);
      })();
      return { success: true, id, noteIds, relocatedNotes };
    } catch (error) {
      debugLogger.error("Error deleting folder", { error: error.message }, "notes");
      throw error;
    }
  }

  renameFolder(id, name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getFolderInAccountScope(id);
      if (folder?.deleted_at) return { success: false, error: "Folder not found" };
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot rename default folders" };
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const folderScope = this._accountScopeCondition("folders");
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND id != ? AND ${FOLDER_NAME_TAKEN_FILTER}
             AND ${folderScope.sql}`
        )
        .get(trimmed, folder.space_id, id, ...folderScope.params);
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

  moveFolderToSpace(id, spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getFolderInAccountScope(id);
      if (folder?.deleted_at) return { success: false, error: "Folder not found" };
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot move default folders" };
      const space = this.getSpace(spaceId);
      if (!space) return { success: false, error: "Space not found" };
      if (folder.space_id === spaceId) return { success: true, folder, notes: [] };
      const folderScope = this._accountScopeCondition("folders");
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND id != ? AND ${FOLDER_NAME_TAKEN_FILTER}
             AND ${folderScope.sql}`
        )
        .get(folder.name, spaceId, id, ...folderScope.params);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      const oldKind = this.db
        .prepare("SELECT kind FROM spaces WHERE id = ?")
        .get(folder.space_id)?.kind;
      // Between two of the account's own Private sections the move is local:
      // the cloud never knew which one held the folder, so nothing is
      // retracted or queued, and its deleted notes go with it too.
      const localMove = oldKind === "private" && space.kind === "private";
      if (localMove && !this._ownPrivateSpaces(folder.space_id, spaceId)) {
        return { success: false, error: "Space not found" };
      }
      // A team folder the cloud holds, or one holding a note it holds, stays
      // in its teamspace (D31).
      if (oldKind === "team" && space.kind === "private") {
        const syncedNote = this.db
          .prepare(
            "SELECT 1 FROM notes WHERE folder_id = ? AND deleted_at IS NULL AND cloud_id IS NOT NULL LIMIT 1"
          )
          .get(id);
        if (folder.cloud_id || syncedNote) return teamRowSyncedRefusal();
      }
      const nextAccountId = this._accountIdForSpace(spaceId);
      const notes = this.db.transaction(() => {
        if (localMove) {
          this.db
            .prepare("UPDATE folders SET space_id = ?, account_id = ? WHERE id = ?")
            .run(spaceId, nextAccountId, id);
          this.db
            .prepare(
              "UPDATE notes SET space_id = ?, account_id = ? WHERE folder_id = ? AND space_id = ?"
            )
            .run(spaceId, nextAccountId, id, folder.space_id);
        } else {
          // Nothing that reaches here leaves a team with a cloud copy (D31), so
          // no row keeps a pending retraction (left_team). Out of Private, the
          // folder and its notes drop what Backup left them, and the notes take
          // new client ids (D32, D32a, D39). The folder keeps its client id:
          // the server's folder upsert revives a deleted row.
          const intoTeam = oldKind === "private" && space.kind === "team";
          this.db
            .prepare(
              `UPDATE folders SET space_id = ?, account_id = ?, sync_status = 'pending', updated_at = datetime('now'), left_team = 0${intoTeam ? ", cloud_id = NULL" : ""} WHERE id = ?`
            )
            .run(spaceId, nextAccountId, id);
          if (intoTeam) {
            const rekey = this.db.prepare(
              `UPDATE notes SET ${CLEAR_BACKUP_NOTE_CLOUD_IDENTITY_SQL}, client_note_id = ? WHERE id = ?`
            );
            const unshared = this.db
              .prepare(
                `SELECT id FROM notes WHERE folder_id = ? AND deleted_at IS NULL AND ${NOT_LEGACY_SHARED_NOTE_SQL}`
              )
              .pluck()
              .all(id);
            for (const noteId of unshared) rekey.run(randomUUID(), noteId);
          }
          this.db
            .prepare(
              "UPDATE notes SET space_id = ?, account_id = ?, sync_status = 'pending', updated_at = datetime('now'), left_team = 0 WHERE folder_id = ? AND deleted_at IS NULL"
            )
            .run(spaceId, nextAccountId, id);
        }
        this.db
          .prepare("UPDATE agent_conversations SET space_id = ? WHERE folder_id = ?")
          .run(spaceId, id);
        return this.db
          .prepare("SELECT * FROM notes WHERE folder_id = ? AND deleted_at IS NULL")
          .all(id);
      })();
      const updated = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      return { success: true, folder: updated, notes };
    } catch (error) {
      debugLogger.error("Error moving folder to space", { error: error.message }, "spaces");
      throw error;
    }
  }

  getFolderNoteCounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // folder_id NULL rows are space-root notes; grouping by space_id too
      // attributes them per space so the tree shows true space totals.
      const accountScope = this._accountScopeCondition("notes");
      return this.db
        .prepare(
          `SELECT space_id, folder_id, COUNT(*) as count
           FROM notes
           WHERE deleted_at IS NULL AND ${accountScope.sql}
           GROUP BY space_id, folder_id`
        )
        .all(...accountScope.params);
    } catch (error) {
      debugLogger.error("Error getting folder note counts", { error: error.message }, "notes");
      throw error;
    }
  }

  // The private space a note goes to when its creator names none. Signed
  // out, the stand-in. Signed in, the account's own row for the workspace
  // (the active one unless another is named); for the default workspace, or
  // one not known yet, the account's default row. Made the first time.
  getPrivateSpaceId(workspaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.activeAccountId;
      if (!accountId) {
        return this._standInPrivateSpaceId() ?? this._insertPrivateSpace(null, null);
      }
      const target = workspaceIdOrNull(workspaceId) ?? this.activeWorkspaceId ?? null;
      if (target == null || target === this.defaultWorkspaceId) {
        return this.getDefaultPrivateSpaceId();
      }
      return (
        this._findPrivateSpace(accountId, target) ?? this._insertPrivateSpace(accountId, target)
      );
    } catch (error) {
      debugLogger.error("Error getting private space id", { error: error.message }, "spaces");
      throw error;
    }
  }

  // The account's default private space. With the default workspace known,
  // that workspace's row; unknown (main forgets the workspaces on every
  // account change), the row the account last bound as its default. Failing
  // that, its pending row (no workspace yet), which bindDefaultPrivateSpace
  // binds, made if missing: for an account that has never bound, or whose
  // new default has no row before its bind. Signed out, the stand-in.
  getDefaultPrivateSpaceId() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.activeAccountId;
      if (!accountId) return this.getPrivateSpaceId();
      return this._defaultPrivateSpaceIdOf(accountId, this.defaultWorkspaceId);
    } catch (error) {
      debugLogger.error(
        "Error getting default private space id",
        { error: error.message },
        "spaces"
      );
      throw error;
    }
  }

  // Any account's default private space. With its default workspace unknown,
  // the row it last bound as its default.
  _defaultPrivateSpaceIdOf(accountId, defaultWorkspaceId = null) {
    // A known default without a row yet (it just changed, before its bind)
    // must not resolve to the earlier default's row: the note would stay
    // there once the new one is bound.
    const known = defaultWorkspaceId
      ? this._findPrivateSpace(accountId, defaultWorkspaceId)
      : this._boundDefaultPrivateSpace(accountId);
    return (
      known ?? this._findPrivateSpace(accountId, null) ?? this._insertPrivateSpace(accountId, null)
    );
  }

  // Where a team note forked out of its teamspace goes: its account's Private
  // for the teamspace's workspace when main knows that workspace (the active
  // or the default one), else the account's default Private. A workspace main
  // doesn't know may be one the account has lost, and a row made for it would
  // keep the note where no workspace shows it. Main forgets the workspaces on
  // every account change, and knows none for an account that isn't signed in.
  // No account: the stand-in.
  _forkPrivateSpaceId(workspaceId, accountId = this.activeAccountId) {
    if (accountId == null) {
      return this._standInPrivateSpaceId() ?? this._insertPrivateSpace(null, null);
    }
    if (accountId !== this.activeAccountId) return this._defaultPrivateSpaceIdOf(accountId);
    const workspace = workspaceIdOrNull(workspaceId);
    const known =
      workspace != null &&
      (workspace === this.activeWorkspaceId || workspace === this.defaultWorkspaceId);
    return known ? this.getPrivateSpaceId(workspace) : this.getDefaultPrivateSpaceId();
  }

  // Where merging puts a team note's other edit. Merging runs as the database
  // opens, before anyone signs in, when main knows no workspace: the owner's
  // Private for the note's workspace is used when this device already has
  // one. None is made here, since the workspace may be one the owner lost; a
  // lost workspace's row moves to the default with the rest of its Private.
  // Otherwise, as any fork.
  _detachedPrivateSpaceId(workspaceId, ownerId) {
    const workspace = workspaceIdOrNull(workspaceId);
    const existing =
      ownerId != null && workspace != null ? this._findPrivateSpace(ownerId, workspace) : null;
    return existing ?? this._forkPrivateSpaceId(workspace, ownerId);
  }

  // Every one of these is a live private space of the signed-in account.
  _ownPrivateSpaces(...spaceIds) {
    if (!this.activeAccountId) return false;
    const own = this.db.prepare(
      `SELECT 1 FROM spaces
       WHERE id = ? AND kind = 'private' AND account_id = ? AND deleted_at IS NULL`
    );
    return spaceIds.every((id) => own.get(id, this.activeAccountId));
  }

  // A pull never moves a note or folder from one of an account's private
  // spaces to another: the cloud has one personal space, and which
  // workspace's Private holds the row is this device's choice. True when the
  // row sits in another live private space of the target's account.
  _keepsPrivatePlacement(currentSpaceId, targetSpaceId) {
    if (currentSpaceId == null || currentSpaceId === targetSpaceId) return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM spaces current_space
           JOIN spaces target_space ON target_space.id = ?
           WHERE current_space.id = ? AND current_space.kind = 'private'
             AND target_space.kind = 'private' AND current_space.deleted_at IS NULL
             AND current_space.account_id = target_space.account_id`
        )
        .get(targetSpaceId, currentSpaceId)
    );
  }

  _findPrivateSpace(accountId, workspaceId) {
    return (
      this.db
        .prepare(
          `SELECT id FROM spaces
           WHERE kind = 'private' AND account_id IS ? AND workspace_id IS ? AND deleted_at IS NULL
           ORDER BY id LIMIT 1`
        )
        .get(accountId, workspaceId)?.id ?? null
    );
  }

  _boundDefaultPrivateSpace(accountId) {
    return (
      this.db
        .prepare(
          `SELECT id FROM spaces
           WHERE kind = 'private' AND account_id = ? AND is_default_private = 1
             AND deleted_at IS NULL
           ORDER BY id LIMIT 1`
        )
        .get(accountId)?.id ?? null
    );
  }

  _insertPrivateSpace(accountId, workspaceId) {
    return Number(
      this.db
        .prepare(
          `INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status, account_id, workspace_id)
           VALUES (?, 'private', 'Personal', 0, 'synced', ?, ?)`
        )
        .run(randomUUID(), accountId, workspaceId).lastInsertRowid
    );
  }

  // Which private spaces the active scope sees: the account's own, one per
  // workspace, or, signed out, the stand-in alone.
  _visiblePrivateSpaceCondition(tableName) {
    return this.activeAccountId
      ? { sql: `${tableName}.account_id = ?`, params: [this.activeAccountId] }
      : {
          sql: `(${tableName}.account_id IS NULL AND ${tableName}.workspace_id IS NULL)`,
          params: [],
        };
  }

  // The live folder of that name in a private space, its default first: a
  // folder the user made with a default's name still takes that default's
  // notes rather than leaving them at the root.
  _privateFolderNamed(spaceId, accountId, name) {
    return (
      this.db
        .prepare(
          `SELECT id FROM folders
           WHERE space_id = ? AND name = ? AND deleted_at IS NULL
             AND (account_id IS NULL OR account_id IS ?)
           ORDER BY is_default DESC, id LIMIT 1`
        )
        .get(spaceId, name, accountId)?.id ?? null
    );
  }

  // Gives a private space its own Personal and Meetings folders, the first
  // time a note needs one. A folder already holding the name (a default the
  // split moved or copied there, or one the user made) is kept as it is.
  // Never synced: private folders stay on the device.
  ensureDefaultFolders(spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const space = this.db
        .prepare("SELECT kind, account_id FROM spaces WHERE id = ? AND deleted_at IS NULL")
        .get(spaceId);
      if (space?.kind !== "private") return;
      const insert = this.db.prepare(
        `INSERT INTO folders (name, is_default, sort_order, client_folder_id, sync_status, space_id, account_id)
         VALUES (?, 1, ?, ?, 'synced', ?, ?)`
      );
      for (const { name, sortOrder } of PRIVATE_DEFAULT_FOLDERS) {
        if (this._privateFolderNamed(spaceId, space.account_id, name) != null) continue;
        insert.run(name, sortOrder, randomUUID(), spaceId, space.account_id);
      }
    } catch (error) {
      debugLogger.error("Error ensuring default folders", { error: error.message }, "spaces");
      throw error;
    }
  }

  // "Name", or "Name (2)", "Name (3)"... while a folder in that space holds
  // it, as a preserved revoked folder is renamed.
  _uniqueFolderName(spaceId, accountId, name, exceptId = null) {
    const taken = this.db.prepare(
      `SELECT 1 FROM folders
       WHERE space_id = ? AND name = ? AND id IS NOT ?
         AND (account_id IS NULL OR account_id IS ?) AND ${FOLDER_NAME_TAKEN_FILTER}`
    );
    let candidate = name;
    for (let n = 2; taken.get(spaceId, candidate, exceptId, accountId); n++) {
      candidate = `${name} (${n})`;
    }
    return candidate;
  }

  // The default workspace's id is known: the account's pending row becomes
  // that workspace's. A row made for it meanwhile (the active workspace was
  // known first) takes in the pending row's notes, folders and chats instead.
  // The row is marked as the account's default, which it stays across
  // launches and sign-ins. A different default later (the old one's
  // ownership moved on, and the server made a new one) takes the mark; the
  // old row stays as its workspace's Private, notes and all.
  bindDefaultPrivateSpace(defaultWorkspaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const workspaceId = workspaceIdOrNull(defaultWorkspaceId);
      const accountId = this.activeAccountId;
      if (!workspaceId || !accountId) return;
      this.db.transaction(() => {
        let boundId = this._findPrivateSpace(accountId, workspaceId);
        const pendingId = this._findPrivateSpace(accountId, null);
        if (pendingId != null && boundId == null) {
          this.db
            .prepare("UPDATE spaces SET workspace_id = ? WHERE id = ?")
            .run(workspaceId, pendingId);
          boundId = pendingId;
        } else if (pendingId != null) {
          // Both rows are the default's Private (one made before main knew
          // the workspace was the default), so their namesakes become one (D41).
          this._mergePrivateSpace(pendingId, boundId, accountId, { foldNamesakes: true });
        }
        boundId ??= this._insertPrivateSpace(accountId, workspaceId);
        this.db
          .prepare(
            `UPDATE spaces SET is_default_private = 0
             WHERE kind = 'private' AND account_id = ? AND is_default_private = 1 AND id != ?`
          )
          .run(accountId, boundId);
        this.db.prepare("UPDATE spaces SET is_default_private = 1 WHERE id = ?").run(boundId);
      })();
      // Only once bound: defaults resolve to that row before the renderer's
      // next scope, and a bind that rolled back leaves main's default as it was.
      this.defaultWorkspaceId = workspaceId;
      this._saveWorkspaceScope();
    } catch (error) {
      debugLogger.error(
        "Error binding the default private space",
        { error: error.message },
        "spaces"
      );
      throw error;
    }
  }

  // Moves everything in one of the account's private spaces into another and
  // retires the emptied row. A local move: sync state, updated_at and cloud
  // ids stay. A default folder (Personal, Meetings) and the target's folder
  // of that name (its default, else one the user made) become one: the one
  // no cloud holds and no held delete needs is retired after its notes and
  // chats join the other, which takes the target folder's place. A cloud-held
  // folder always survives, so its link is never lost. With foldNamesakes
  // (two rows of the same workspace's Private, D41) every folder folds that
  // way. When both are held, or for any other folder whose name the target
  // holds (another workspace's Private), the moved folder becomes
  // "Name (2)" and stops being a default. Returns the live notes moved, and
  // the live folders moved rather than folded into a namesake.
  _mergePrivateSpace(fromId, toId, accountId, { foldNamesakes = false } = {}) {
    const moved = {
      notes: this.db
        .prepare("SELECT COUNT(*) AS count FROM notes WHERE space_id = ? AND deleted_at IS NULL")
        .get(fromId).count,
      folders: 0,
    };
    const moveFolder = this.db.prepare(
      "UPDATE folders SET space_id = ?, name = ?, is_default = ?, account_id = COALESCE(account_id, ?) WHERE id = ?"
    );
    const targetNamed = this.db.prepare(
      `SELECT id, name, is_default, cloud_id FROM folders
       WHERE space_id = ? AND name = ? AND deleted_at IS NULL
         AND (account_id IS NULL OR account_id IS ?)
       ORDER BY is_default DESC, id LIMIT 1`
    );
    const foldNotes = this.db.prepare(
      "UPDATE notes SET space_id = ?, folder_id = ?, account_id = COALESCE(account_id, ?) WHERE folder_id = ?"
    );
    const foldChats = this.db.prepare(
      "UPDATE agent_conversations SET space_id = ?, folder_id = ? WHERE folder_id = ?"
    );
    const heldDelete = this.db.prepare(
      "SELECT 1 FROM optimistic_folder_delete_rows WHERE folder_id = ? LIMIT 1"
    );
    const retireFolder = this.db.prepare("DELETE FROM folders WHERE id = ?");
    const folders = this.db
      .prepare(
        "SELECT id, name, is_default, cloud_id, deleted_at FROM folders WHERE space_id = ? ORDER BY id"
      )
      .all(fromId);
    const retirable = (row) => row.cloud_id == null && !heldDelete.get(row.id);
    const fold = (fromFolderId, intoFolderId) => {
      foldNotes.run(toId, intoFolderId, accountId, fromFolderId);
      foldChats.run(toId, intoFolderId, fromFolderId);
      retireFolder.run(fromFolderId);
    };
    for (const folder of folders) {
      const target =
        (folder.is_default || foldNamesakes) && !folder.deleted_at
          ? targetNamed.get(toId, folder.name, accountId)
          : null;
      if (target && retirable(folder)) {
        fold(folder.id, target.id);
        continue;
      }
      if (!folder.deleted_at) moved.folders += 1;
      if (target && retirable(target)) {
        // Retired first: the survivor takes its name.
        fold(target.id, folder.id);
        moveFolder.run(toId, target.name, target.is_default, accountId, folder.id);
        continue;
      }
      // A deleted folder holds no name, and keeps its own for a rollback.
      const name = folder.deleted_at
        ? folder.name
        : this._uniqueFolderName(toId, accountId, folder.name, folder.id);
      moveFolder.run(
        toId,
        name,
        name === folder.name ? folder.is_default : 0,
        accountId,
        folder.id
      );
    }
    this.db
      .prepare(
        "UPDATE notes SET space_id = ?, account_id = COALESCE(account_id, ?) WHERE space_id = ?"
      )
      .run(toId, accountId, fromId);
    this.db
      .prepare(
        `UPDATE agent_conversations SET space_id = ?
         WHERE space_id = ? OR folder_id IN (SELECT id FROM folders WHERE space_id = ?)`
      )
      .run(toId, fromId, toId);
    this.db.prepare("UPDATE spaces SET deleted_at = datetime('now') WHERE id = ?").run(fromId);
    return moved;
  }

  // A workspace the account lost (left, removed from, or deleted) takes its
  // Private with it on no device: its notes, folders and chats move into the
  // default workspace's Private (null) or the named workspace's, folded as
  // the default's bind folds them, and the emptied row is retired. A local
  // move: nothing is queued for upload and nothing is retracted. The
  // default's own Private never moves, since everything else lands there.
  // Signed out, or with no such row, nothing moves.
  relocatePrivateSpace(fromWorkspaceId, toWorkspaceId = null) {
    let moved = { notes: 0, folders: 0 };
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.activeAccountId;
      const from = workspaceIdOrNull(fromWorkspaceId);
      if (!accountId || !from) return moved;
      const to = workspaceIdOrNull(toWorkspaceId);
      this.db.transaction(() => {
        // Found by account and workspace: never the stand-in or a pending row.
        const sourceId = this._findPrivateSpace(accountId, from);
        if (sourceId == null) return;
        const isDefault = this.db
          .prepare("SELECT is_default_private FROM spaces WHERE id = ?")
          .get(sourceId).is_default_private;
        // The default stays where it is, before the target (which can make a
        // row) is resolved.
        let targetId = sourceId;
        if (!isDefault) {
          targetId = to == null ? this.getDefaultPrivateSpaceId() : this.getPrivateSpaceId(to);
        }
        if (targetId === sourceId) {
          debugLogger.warn(
            "Not relocating the default private space, or into itself",
            { sourceId, targetId },
            "spaces"
          );
          return;
        }
        moved = this._mergePrivateSpace(sourceId, targetId, accountId);
      })();
      return moved;
    } catch (error) {
      debugLogger.error("Error relocating a private space", { error: error.message }, "spaces");
      throw error;
    }
  }

  // Copy to Private: a new local note in one of the active account's private
  // spaces, holding the source's text, summary, transcript (its segments, and
  // the speakers named and voices kept for them) and meeting links. None of
  // the source's cloud identity, sharing or ownership comes along, and the
  // source stays as it was: the copy of a team note is the user's own, and
  // outlives the teamspace. Without a folder it goes where a new note of its
  // type goes. Null when the note, space or folder isn't the account's to use.
  copyNoteToSpace(noteId, targetSpaceId, folderId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const source = this.getNote(noteId);
      if (!source || source.deleted_at) return null;
      const space = this.getSpace(targetSpaceId);
      if (space?.kind !== "private") return null;
      if (folderId != null) {
        const folder = this._getFolderInAccountScope(folderId);
        if (!folder || folder.deleted_at || folder.space_id !== space.id) return null;
      }
      const accountId = this._accountIdForSpace(space.id);
      const copyId = this.db.transaction(() => {
        let targetFolderId = folderId;
        if (targetFolderId == null) {
          this.ensureDefaultFolders(space.id);
          targetFolderId = this._privateFolderNamed(
            space.id,
            space.account_id,
            source.note_type === "meeting" ? "Meetings" : "Personal"
          );
        }
        const id = Number(
          this.db
            .prepare(
              `INSERT INTO notes (client_note_id, title, content, content_sync_operation,
                 enhanced_content, enhanced_content_sync_operation, enhancement_prompt,
                 enhancement_template_id, enhanced_at_content_hash, note_type, source_file,
                 audio_duration_seconds, transcript, participants, calendar_event_id,
                 diarization_enabled, expected_speaker_count, folder_id, space_id, account_id,
                 sync_status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
            )
            .run(
              randomUUID(),
              source.title,
              source.content,
              typedTextOperation(source.content),
              source.enhanced_content,
              typedTextOperation(source.enhanced_content),
              source.enhancement_prompt,
              source.enhancement_template_id,
              source.enhanced_at_content_hash,
              source.note_type,
              source.source_file,
              source.audio_duration_seconds,
              source.transcript,
              source.participants,
              source.calendar_event_id,
              source.diarization_enabled,
              source.expected_speaker_count,
              targetFolderId,
              space.id,
              accountId,
              source.created_at
            ).lastInsertRowid
        );
        this.db
          .prepare(
            `INSERT INTO speaker_mappings (note_id, speaker_id, profile_id, display_name)
             SELECT ?, speaker_id, profile_id, display_name FROM speaker_mappings WHERE note_id = ?`
          )
          .run(id, source.id);
        this.db
          .prepare(
            `INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding, embedding_version)
             SELECT ?, speaker_id, embedding, embedding_version FROM note_speaker_embeddings WHERE note_id = ?`
          )
          .run(id, source.id);
        return id;
      })();
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(copyId);
    } catch (error) {
      debugLogger.error("Error copying note", { error: error.message }, "notes");
      throw error;
    }
  }

  // At sign-in, what was written signed out goes to the account that signs
  // in, the rule #2924 uses for history and chats: only on a device no other
  // account has used. Anywhere else it stays in the stand-in, seen only signed
  // out. A folder holding such notes goes with them, ids and cloud ids kept,
  // as "Name (2)" when the account has one of that name; the stand-in's own
  // defaults stay, and their notes join the account's folder of that name.
  // The sign-in claims that run first give the account signed-out chats;
  // those leave the stand-in on any device, following their folder, or to the
  // root when it stays. Running it again finds nothing left.
  claimSignedOutPrivateNotes() {
    const claimed = { notes: 0, folders: 0 };
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountId = this.activeAccountId;
      const standInId = accountId ? this._standInPrivateSpaceId() : null;
      if (standInId == null) return claimed;
      const claimsNotes = !this.hasOtherAccountRows();
      this.db.transaction(() => {
        const notesToClaim =
          claimsNotes &&
          this.db
            .prepare("SELECT 1 FROM notes WHERE space_id = ? AND account_id IS NULL LIMIT 1")
            .get(standInId);
        const strayChats = this.db
          .prepare(
            `SELECT 1 FROM agent_conversations
             WHERE account_id = ? AND ((space_id = ? AND folder_id IS NULL)
               OR folder_id IN (SELECT id FROM folders WHERE space_id = ? AND deleted_at IS NULL))
             LIMIT 1`
          )
          .get(accountId, standInId, standInId);
        if (!notesToClaim && !strayChats) return;
        const homeId = this.getDefaultPrivateSpaceId();
        // Stand-in folders that stay, and the account's folder their rows joined.
        const joined = new Map();
        if (notesToClaim) {
          const moved = this._claimStandInNotes(standInId, homeId, accountId, joined);
          claimed.notes = moved.notes;
          claimed.folders = moved.folders;
        }
        const moveFolderChats = this.db.prepare(
          "UPDATE agent_conversations SET space_id = ?, folder_id = ? WHERE account_id = ? AND folder_id = ?"
        );
        for (const [standInFolderId, homeFolderId] of joined) {
          moveFolderChats.run(homeId, homeFolderId, accountId, standInFolderId);
        }
        this.db
          .prepare(
            `UPDATE agent_conversations SET space_id = ?, folder_id = NULL
             WHERE account_id = ? AND ((space_id = ? AND folder_id IS NULL)
               OR folder_id IN (SELECT id FROM folders WHERE space_id = ? AND deleted_at IS NULL))`
          )
          .run(homeId, accountId, standInId, standInId);
      })();
      return claimed;
    } catch (error) {
      debugLogger.error(
        "Error claiming signed-out private notes",
        { error: error.message },
        "spaces"
      );
      throw error;
    }
  }

  // The notes half of claimSignedOutPrivateNotes. Moves are local: sync
  // state, updated_at and cloud ids stay.
  _claimStandInNotes(standInId, homeId, accountId, joined) {
    let notes = 0;
    let folders = 0;
    const claimNotesIn = this.db.prepare(
      `UPDATE notes SET space_id = ?, folder_id = ?, account_id = ?
       WHERE folder_id = ? AND space_id = ? AND account_id IS NULL`
    );
    const moveFolder = this.db.prepare(
      "UPDATE folders SET space_id = ?, account_id = ?, name = ? WHERE id = ?"
    );
    // A folder's deleted rows of the account's own (a held delete) go with it.
    const followFolder = this.db.prepare(
      "UPDATE notes SET space_id = ? WHERE folder_id = ? AND space_id = ? AND account_id = ?"
    );
    const followFolderChats = this.db.prepare(
      "UPDATE agent_conversations SET space_id = ? WHERE folder_id = ?"
    );
    const insertFolder = this.db.prepare(
      `INSERT INTO folders (name, is_default, sort_order, client_folder_id, sync_status, space_id, account_id)
       VALUES (?, ?, ?, ?, 'synced', ?, ?)`
    );
    const standInFolders = this.db
      .prepare(
        `SELECT * FROM folders f
         WHERE f.space_id = ? AND f.account_id IS NULL AND EXISTS (
           SELECT 1 FROM notes n
           WHERE n.folder_id = f.id AND n.space_id = ? AND n.account_id IS NULL
         )
         ORDER BY f.id`
      )
      .all(standInId, standInId);
    for (const folder of standInFolders) {
      if (folder.is_default) {
        const target =
          this._privateFolderNamed(homeId, accountId, folder.name) ??
          Number(
            insertFolder.run(
              folder.name,
              folder.is_default,
              folder.sort_order,
              randomUUID(),
              homeId,
              accountId
            ).lastInsertRowid
          );
        joined.set(folder.id, target);
        notes += claimNotesIn.run(homeId, target, accountId, folder.id, standInId).changes;
        continue;
      }
      // A deleted folder holds no name, and keeps its own for a rollback.
      const name = folder.deleted_at
        ? folder.name
        : this._uniqueFolderName(homeId, accountId, folder.name, folder.id);
      moveFolder.run(homeId, accountId, name, folder.id);
      notes += claimNotesIn.run(homeId, folder.id, accountId, folder.id, standInId).changes;
      followFolder.run(homeId, folder.id, standInId, accountId);
      followFolderChats.run(homeId, folder.id);
      folders += 1;
    }
    notes += this.db
      .prepare(
        `UPDATE notes SET space_id = ?, account_id = ?
         WHERE space_id = ? AND account_id IS NULL AND folder_id IS NULL`
      )
      .run(homeId, accountId, standInId).changes;
    return { notes, folders };
  }

  // The private row with no account and no workspace: what a signed-out user
  // sees, and the row every account's notes shared before user_version 6.
  _standInPrivateSpaceId() {
    return (
      this.db
        .prepare(
          `SELECT id FROM spaces
           WHERE kind = 'private' AND account_id IS NULL AND workspace_id IS NULL
             AND deleted_at IS NULL
           ORDER BY id LIMIT 1`
        )
        .get()?.id ?? null
    );
  }

  // Gives each account with rows in the stand-in its own pending private row
  // (no workspace yet) and moves its notes, folders and root chats there; the
  // stand-in keeps the rows with no account. One transaction, the version
  // included: a launch cut short leaves the old shape and the next one starts
  // over.
  _splitPrivateSpaceByAccount() {
    this.db.transaction(() => {
      const standInId = this._standInPrivateSpaceId();
      const accounts =
        standInId == null
          ? []
          : this.db
              .prepare(
                `SELECT account_id FROM notes WHERE space_id = ? AND account_id IS NOT NULL
                 UNION SELECT account_id FROM folders WHERE space_id = ? AND account_id IS NOT NULL
                 UNION SELECT account_id FROM agent_conversations
                   WHERE account_id IS NOT NULL AND ${SPACE_CONTAINER_CONVERSATION_FILTER}
                 ORDER BY account_id`
              )
              .all(standInId, standInId, standInId, standInId)
              .map((row) => row.account_id);
      if (accounts.length > 0) this._moveAccountsOutOfStandIn(standInId, accounts);
      this.db.pragma("user_version = 6");
    })();
  }

  // A move, not an edit: sync state, updated_at and cloud ids stay as they
  // are, so nothing is pushed or retracted. A folder goes whole, ids and all,
  // to the account that owns it, or that has every note and chat in it. A
  // folder several owners use stays, and every other owner of rows in it gets
  // a folder of the same name in its own row, so a note's folder is always in
  // the note's space. Empty folders (the seeded defaults among them) stay.
  _moveAccountsOutOfStandIn(standInId, accounts) {
    const findHome = this.db.prepare(
      "SELECT id FROM spaces WHERE kind = 'private' AND account_id = ? AND workspace_id IS NULL AND deleted_at IS NULL"
    );
    const insertHome = this.db.prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status, account_id) VALUES (?, 'private', 'Personal', 0, 'synced', ?)"
    );
    const homes = new Map();
    for (const accountId of accounts) {
      const existing = findHome.get(accountId)?.id;
      homes.set(
        accountId,
        existing ?? Number(insertHome.run(randomUUID(), accountId).lastInsertRowid)
      );
    }
    const homeOf = (accountId) => (accountId == null ? standInId : homes.get(accountId));

    // A chat from before attribution names no owner yet: it reads as
    // unattributed until the sign-in claim, which runs after this launch's
    // migration. It follows its folder rather than splitting it.
    const rowOwners = this.db.prepare(
      `SELECT account_id FROM notes WHERE folder_id = ? AND space_id = ?
       UNION SELECT account_id FROM agent_conversations
         WHERE folder_id = ? AND NOT (account_id IS NULL AND legacy_unattributed != 0)`
    );
    const plans = this.db
      .prepare("SELECT * FROM folders WHERE space_id = ? ORDER BY id")
      .all(standInId)
      .map((folder) => {
        const owners = rowOwners.all(folder.id, standInId, folder.id).map((row) => row.account_id);
        const soleOwner = owners.length === 1 ? owners[0] : null;
        return { folder, owners, ownerId: folder.account_id ?? soleOwner };
      });

    const liveFolderNamed = this.db.prepare(
      "SELECT id FROM folders WHERE space_id = ? AND account_id IS ? AND name = ? AND deleted_at IS NULL"
    );
    const moveFolder = this.db.prepare(
      "UPDATE folders SET space_id = ?, account_id = ? WHERE id = ?"
    );
    const moveWhole = (plan) => {
      const home = homeOf(plan.ownerId);
      // The account already has a live folder of that name there: rather than
      // break the name index, its rows join that folder below.
      if (!plan.folder.deleted_at && liveFolderNamed.get(home, plan.ownerId, plan.folder.name)) {
        plan.ownerId = null;
        return;
      }
      moveFolder.run(home, plan.ownerId, plan.folder.id);
    };
    // A deleted folder waits for its server delete with every row it holds,
    // so one that others still use is left as it is.
    const wholeMoves = plans.filter(
      (plan) =>
        plan.ownerId != null &&
        (!plan.folder.deleted_at || plan.owners.every((owner) => owner === plan.ownerId))
    );
    // Owned folders first, so adopting a folder never takes a name one holds.
    for (const plan of wholeMoves) if (plan.folder.account_id != null) moveWhole(plan);
    for (const plan of wholeMoves) if (plan.folder.account_id == null) moveWhole(plan);

    const insertFolder = this.db.prepare(
      "INSERT INTO folders (name, is_default, sort_order, client_folder_id, sync_status, space_id, account_id) VALUES (?, ?, ?, ?, 'synced', ?, ?)"
    );
    const repointNotes = this.db.prepare(
      "UPDATE notes SET folder_id = ? WHERE folder_id = ? AND space_id = ? AND account_id IS ?"
    );
    const repointChats = this.db.prepare(
      "UPDATE agent_conversations SET folder_id = ?, space_id = ? WHERE folder_id = ? AND account_id IS ?"
    );
    for (const { folder, owners, ownerId } of plans) {
      if (folder.deleted_at) continue;
      for (const owner of owners) {
        if (owner === ownerId) continue;
        const home = homeOf(owner);
        const target =
          liveFolderNamed.get(home, owner, folder.name)?.id ??
          Number(
            insertFolder.run(
              folder.name,
              folder.is_default,
              folder.sort_order,
              randomUUID(),
              home,
              owner
            ).lastInsertRowid
          );
        repointNotes.run(target, folder.id, standInId, owner);
        repointChats.run(target, home, folder.id, owner);
      }
    }

    const moveNotes = this.db.prepare(
      `UPDATE notes SET space_id = ?
       WHERE space_id = ? AND account_id = ?
         AND (folder_id IS NULL OR folder_id IN (SELECT id FROM folders WHERE space_id = ?))`
    );
    const moveRootChats = this.db.prepare(
      "UPDATE agent_conversations SET space_id = ? WHERE space_id = ? AND folder_id IS NULL AND account_id = ?"
    );
    // A folder's chats follow it, as in moveFolderToSpace.
    const followFolders = this.db.prepare(
      `UPDATE agent_conversations
       SET space_id = (SELECT space_id FROM folders WHERE folders.id = agent_conversations.folder_id)
       WHERE folder_id IN (SELECT id FROM folders WHERE space_id = ?)`
    );
    for (const [accountId, homeId] of homes) {
      moveNotes.run(homeId, standInId, accountId, homeId);
      moveRootChats.run(homeId, standInId, accountId);
      followFolders.run(homeId);
    }
  }

  // Parses the teams and capabilities JSON mirrors so renderer consumers only
  // ever see an array and an object-or-null.
  _spaceRow(row) {
    if (!row) return row;
    let teams = [];
    if (row.teams) {
      try {
        teams = JSON.parse(row.teams);
      } catch {
        teams = [];
      }
    }
    let capabilities = null;
    if (row.capabilities) {
      try {
        const parsed = JSON.parse(row.capabilities);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          capabilities = parsed;
        }
      } catch {
        capabilities = null;
      }
    }
    return { ...row, teams, capabilities };
  }

  getSpaces() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // The active workspace's Private always exists and comes first, so a
      // caller taking the first private space gets that one.
      const activePrivateId = this.getPrivateSpaceId();
      const privateScope = this._visiblePrivateSpaceCondition("spaces");
      return this.db
        .prepare(
          `SELECT * FROM spaces
           WHERE deleted_at IS NULL
             AND ((kind = 'private' AND ${privateScope.sql}) OR (kind != 'private' AND EXISTS (
               SELECT 1 FROM space_accounts
               WHERE space_accounts.space_id = spaces.id
                 AND space_accounts.account_id = ?
             )))
           ORDER BY CASE WHEN id = ? THEN 0 WHEN kind = 'private' THEN 1 ELSE 2 END,
             sort_order ASC, name ASC, id ASC`
        )
        .all(...privateScope.params, this.activeAccountId, activePrivateId)
        .map((row) => this._spaceRow(row));
    } catch (error) {
      debugLogger.error("Error getting spaces", { error: error.message }, "spaces");
      throw error;
    }
  }

  getSpace(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const privateScope = this._visiblePrivateSpaceCondition("spaces");
      const row = this.db
        .prepare(
          `SELECT * FROM spaces
           WHERE id = ? AND deleted_at IS NULL
             AND ((kind = 'private' AND ${privateScope.sql}) OR (kind != 'private' AND EXISTS (
               SELECT 1 FROM space_accounts
               WHERE space_accounts.space_id = spaces.id
                 AND space_accounts.account_id = ?
             )))`
        )
        .get(id, ...privateScope.params, this.activeAccountId);
      return row ? this._spaceRow(row) : null;
    } catch (error) {
      debugLogger.error("Error getting space", { error: error.message }, "spaces");
      throw error;
    }
  }

  updateSpace(id, { name, emoji } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const space = this.getSpace(id);
      if (!space) return { success: false, error: "Space not found" };
      const fields = [];
      const values = [];
      if (name !== undefined) {
        if (space.kind === "private") {
          return { success: false, error: "Cannot rename the private space" };
        }
        const trimmed = (name || "").trim();
        if (!trimmed) return { success: false, error: "Space name is required" };
        fields.push("name = ?");
        values.push(trimmed);
      }
      if (emoji !== undefined) {
        fields.push("emoji = ?");
        values.push(emoji);
      }
      if (fields.length === 0) return { success: false };
      fields.push("sync_status = 'pending'", "updated_at = datetime('now')");
      values.push(id);
      this.db.prepare(`UPDATE spaces SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const updated = this._spaceRow(this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id));
      return { success: true, space: updated };
    } catch (error) {
      debugLogger.error("Error updating space", { error: error.message }, "spaces");
      throw error;
    }
  }

  setSpaceSyncStatus(id, status) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getSpace(id)) return { success: false, space: null };
      const result = this.db
        .prepare("UPDATE spaces SET sync_status = ? WHERE id = ? AND deleted_at IS NULL")
        .run(status, id);
      const success = result.changes > 0;
      return { success, space: success ? this.getSpace(id) : null };
    } catch (error) {
      debugLogger.error("Error setting space sync status", { error: error.message }, "spaces");
      throw error;
    }
  }

  getSpaceByCloudSpaceId(cloudSpaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const row = this.db
        .prepare("SELECT * FROM spaces WHERE cloud_space_id = ?")
        .get(cloudSpaceId);
      return row ? this._spaceRow(row) : null;
    } catch (error) {
      debugLogger.error(
        "Error getting space by cloud space id",
        { error: error.message },
        "spaces"
      );
      throw error;
    }
  }

  upsertSpaceFromCloud(space) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.activeAccountId) {
        throw new Error("Cannot cache a cloud space without an active account scope");
      }
      const updatedAt = space.updated_at || space.created_at || new Date().toISOString();
      const teams = Array.isArray(space.teams) ? space.teams : [];
      const teamsJson = JSON.stringify(teams);
      const capabilitiesJson = space.capabilities ? JSON.stringify(space.capabilities) : null;
      let existing = this.db.prepare("SELECT * FROM spaces WHERE cloud_space_id = ?").get(space.id);
      if (!existing && teams.length === 1) {
        // Adopt a pre-spaces row: the server backfilled one space per legacy
        // team, so a single-team space claims the local row that mirrored that
        // team. Keeps local ids alive for chats, vector payloads and tree state.
        existing = this.db
          .prepare("SELECT * FROM spaces WHERE cloud_space_id IS NULL AND cloud_team_id = ?")
          .get(teams[0].id);
      }
      if (existing) {
        this.db
          .prepare(
            `UPDATE spaces SET cloud_space_id = ?, workspace_id = ?, name = ?, emoji = ?, my_role = ?,
               my_direct_role = ?, member_count = ?, teams = ?, capabilities = ?, deleted_at = NULL,
               updated_at = ?
             WHERE id = ?`
          )
          .run(
            space.id,
            space.workspace_id ?? null,
            space.name,
            space.emoji ?? null,
            space.my_role ?? null,
            space.my_direct_role ?? null,
            space.member_count ?? null,
            teamsJson,
            capabilitiesJson,
            updatedAt,
            existing.id
          );
        this.db
          .prepare("INSERT OR IGNORE INTO space_accounts (space_id, account_id) VALUES (?, ?)")
          .run(existing.id, this.activeAccountId);
        return this._spaceRow(
          this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(existing.id)
        );
      }
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM spaces").get();
      // New spaces insert as 'pending' (skeletons until the content backfill
      // completes); updates never touch sync_status, so an interrupted
      // backfill's 'pending' survives the next mirror pass and re-runs.
      const result = this.db
        .prepare(
          `INSERT INTO spaces (client_space_id, cloud_space_id, workspace_id, kind, name, emoji,
             sort_order, my_role, my_direct_role, member_count, teams, capabilities, sync_status,
             created_at, updated_at)
           VALUES (?, ?, ?, 'team', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          randomUUID(),
          space.id,
          space.workspace_id ?? null,
          space.name,
          space.emoji ?? null,
          (maxOrder?.max_order ?? 0) + 1,
          space.my_role ?? null,
          space.my_direct_role ?? null,
          space.member_count ?? null,
          teamsJson,
          capabilitiesJson,
          space.created_at || updatedAt,
          updatedAt
        );
      this.db
        .prepare("INSERT OR IGNORE INTO space_accounts (space_id, account_id) VALUES (?, ?)")
        .run(result.lastInsertRowid, this.activeAccountId);
      return this._spaceRow(
        this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(result.lastInsertRowid)
      );
    } catch (error) {
      debugLogger.error("Error upserting space from cloud", { error: error.message }, "spaces");
      throw error;
    }
  }

  // Speaker rows cascade on note delete (ON DELETE CASCADE), but callers that
  // only tombstone notes still need the explicit cleanup.
  _deleteSpeakerRowsForNotes(noteIdSubquery, param) {
    this.db.prepare(`DELETE FROM speaker_mappings WHERE note_id IN (${noteIdSubquery})`).run(param);
    this.db
      .prepare(`DELETE FROM note_speaker_embeddings WHERE note_id IN (${noteIdSubquery})`)
      .run(param);
  }

  // Conversations whose note or container is being removed must not survive
  // as global chats. Synced rows tombstone (like deleteAgentConversation) so
  // the next push retires the cloud copy; a hard local delete would let the
  // next pull resurrect the conversation. Irreversible purge/revocation
  // callers also scrub their messages, while an optimistic ordinary delete
  // retains synced messages until the server accepts it. A row whose create
  // request may have reached the server tombstones too, so its late receipt
  // links it to a cloud delete. Rows no create request has carried
  // hard-delete: there is no server row to retire, and a bare tombstone would
  // linger forever (getPendingConversationDeletes requires a cloud_id).
  _retireConversationsWhere(
    filter,
    params,
    { scrubSyncedMessages = false, syncedTombstoneStatus = "pending" } = {}
  ) {
    const neverSent = `cloud_id IS NULL AND cloud_create_attempted = 0 AND (${filter})`;
    const messageFilter = scrubSyncedMessages ? filter : neverSent;
    this.db
      .prepare(
        `DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE ${messageFilter})`
      )
      .run(...params);
    this.db.prepare(`DELETE FROM agent_conversations WHERE ${neverSent}`).run(...params);
    this.db
      .prepare(
        `UPDATE agent_conversations SET deleted_at = datetime('now'), sync_status = ?, updated_at = datetime('now') WHERE (cloud_id IS NOT NULL OR cloud_create_attempted = 1) AND deleted_at IS NULL AND (${filter})`
      )
      .run(syncedTombstoneStatus, ...params);
  }

  // Account transitions are a local privacy boundary, not a cloud mutation:
  // no old-account conversation row (including a pending cloud tombstone)
  // may remain for the next account to see or push.
  _hardDeleteConversationsWhere(filter, params) {
    this.db
      .prepare(
        `DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE ${filter})`
      )
      .run(...params);
    this.db.prepare(`DELETE FROM agent_conversations WHERE ${filter}`).run(...params);
  }

  purgeSpace(localSpaceId, options = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const mode = options?.mode ?? "preserve-dirty";
      if (mode !== "preserve-dirty" && mode !== "destructive") {
        return { success: false, error: "Invalid purge mode" };
      }
      const destructive = mode === "destructive";
      const space = this.getSpace(localSpaceId);
      if (!space) return { success: false, error: "Space not found" };
      if (space.kind === "private") {
        return { success: false, error: "Cannot purge the private space" };
      }
      if (this._releaseActiveSpaceMembershipIfShared(localSpaceId)) {
        return {
          success: true,
          noteIds: [],
          folderNames: [],
          spaceId: localSpaceId,
          relocatedNotes: [],
          relocatedCount: 0,
          relocatedTitles: [],
          preservedForOtherAccounts: true,
        };
      }
      if (!destructive) {
        // Space revocation supersedes any unresolved folder delete. Recover
        // the held rows first so dirty/local-only children are classified by
        // their real pre-delete state and can still relocate to Personal.
        const heldFolderIds = this.db
          .prepare(
            `SELECT DISTINCT r.folder_id
             FROM optimistic_folder_delete_rows r
             JOIN folders f ON f.id = r.folder_id
             WHERE r.entity_type = 'folder' AND f.space_id = ?`
          )
          .all(localSpaceId)
          .map((row) => row.folder_id);
        for (const folderId of heldFolderIds) {
          const rollback = this.restoreFolderAfterDeniedDelete(folderId);
          if (!rollback.success) return rollback;
        }
      }
      const { noteIds, folderNames, relocatedNotes } = this.db.transaction(() => {
        // Dirty or never-synced notes are the only surviving content (plan
        // §7.2, matching relocateRevokedFolder): they move to the root of the
        // account's Private for the teamspace's workspace with forked
        // identities — the server row (if any) stays the team's, and the forks
        // stay on this device, as every private note does (D2).
        let relocated = [];
        if (!destructive) {
          const preservedIds = this.db
            .prepare(
              "SELECT id FROM notes WHERE space_id = ? AND deleted_at IS NULL AND (sync_status != 'synced' OR cloud_id IS NULL)"
            )
            .all(localSpaceId)
            .map((row) => row.id);
          if (preservedIds.length > 0) {
            const privateSpaceId = this._forkPrivateSpaceId(space.workspace_id);
            const accountId = this._accountIdForSpace(privateSpaceId);
            const relocateNote = this.db.prepare(
              "UPDATE notes SET space_id = ?, folder_id = NULL, account_id = ?, client_note_id = ?, cloud_id = NULL, cloud_updated_at = NULL, cloud_revision = NULL, cloud_create_rejected = 0, cloud_create_pending = NULL, cloud_create_attempted = 0, owner_user_id = NULL, updated_by_user_id = NULL, sync_status = 'pending', left_team = 0, is_shared = 0, share_token = NULL, updated_at = datetime('now') WHERE id = ?"
            );
            const detachNoteConversation = this.db.prepare(
              "UPDATE agent_conversations SET space_id = NULL, folder_id = NULL WHERE note_id = ?"
            );
            for (const noteId of preservedIds) {
              relocateNote.run(privateSpaceId, accountId, randomUUID(), noteId);
              // A note chat follows the dirty note fork into Personal. Clear
              // any redundant team-container scope so the container cleanup
              // below cannot retire a conversation whose note survived.
              detachNoteConversation.run(noteId);
            }
            const getNote = this.db.prepare("SELECT * FROM notes WHERE id = ?");
            relocated = preservedIds.map((id) => getNote.get(id));
          }
        }
        const ids = this.db
          .prepare("SELECT id FROM notes WHERE space_id = ?")
          .all(localSpaceId)
          .map((row) => row.id);
        const names = this.db
          .prepare("SELECT name FROM folders WHERE space_id = ?")
          .all(localSpaceId)
          .map((row) => row.name);
        // Note chats normally carry only note_id, so container cleanup alone
        // cannot see them. Retire them while the doomed note rows still
        // identify the space; relocated dirty-note chats were moved above.
        if (destructive) {
          // Account-boundary cleanup must leave neither visible chats nor
          // cloud-delete tombstones. Match note-only chats and both kinds of
          // container scope before deleting their parent rows.
          this._hardDeleteConversationsWhere(
            `note_id IN (SELECT id FROM notes WHERE space_id = ?)
             OR ${SPACE_CONTAINER_CONVERSATION_FILTER}`,
            [localSpaceId, localSpaceId, localSpaceId]
          );
          this.db
            .prepare(
              `DELETE FROM optimistic_folder_delete_rows
               WHERE folder_id IN (SELECT id FROM folders WHERE space_id = ?)`
            )
            .run(localSpaceId);
        } else {
          this._retireConversationsWhere(
            "note_id IN (SELECT id FROM notes WHERE space_id = ?)",
            [localSpaceId],
            { scrubSyncedMessages: true }
          );
        }
        this._deleteSpeakerRowsForNotes("SELECT id FROM notes WHERE space_id = ?", localSpaceId);
        this.db.prepare("DELETE FROM notes WHERE space_id = ?").run(localSpaceId);
        // Deleted-note tombstones in other spaces can still reference folders
        // in this space (folder moved across spaces after the delete); clear
        // the refs or the folder delete below aborts on the FK.
        this.db
          .prepare(
            "UPDATE notes SET folder_id = NULL WHERE space_id != ? AND folder_id IN (SELECT id FROM folders WHERE space_id = ?)"
          )
          .run(localSpaceId, localSpaceId);
        if (!destructive) {
          this._retireConversationsWhere(
            SPACE_CONTAINER_CONVERSATION_FILTER,
            [localSpaceId, localSpaceId],
            { scrubSyncedMessages: true }
          );
        }
        this.db.prepare("DELETE FROM folders WHERE space_id = ?").run(localSpaceId);
        this.db.prepare("DELETE FROM spaces WHERE id = ?").run(localSpaceId);
        return { noteIds: ids, folderNames: names, relocatedNotes: relocated };
      })();
      return {
        success: true,
        noteIds,
        folderNames,
        spaceId: localSpaceId,
        relocatedNotes,
        relocatedCount: relocatedNotes.length,
        relocatedTitles: relocatedNotes.slice(0, 3).map((note) => note.title),
      };
    } catch (error) {
      debugLogger.error("Error purging space", { error: error.message }, "spaces");
      throw error;
    }
  }

  _initVectorChangeJournal() {
    this.db.transaction(() => {
      const journalExists = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_vector_changes'"
        )
        .get();
      // AUTOINCREMENT keeps acknowledgements unique even after the queue is
      // emptied or a deleted note id is reused while indexing is in flight.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_vector_changes (
          revision INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL UNIQUE
        );
        CREATE TRIGGER IF NOT EXISTS notes_vector_insert AFTER INSERT ON notes BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (NEW.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
        CREATE TRIGGER IF NOT EXISTS notes_vector_update
        AFTER UPDATE OF title, content, enhanced_content, space_id, folder_id, deleted_at ON notes
        WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content
          OR OLD.enhanced_content IS NOT NEW.enhanced_content
          OR OLD.space_id IS NOT NEW.space_id OR OLD.folder_id IS NOT NEW.folder_id
          OR OLD.deleted_at IS NOT NEW.deleted_at
        BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (NEW.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
        CREATE TRIGGER IF NOT EXISTS notes_vector_delete AFTER DELETE ON notes BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (OLD.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
      `);
      if (!journalExists) this.enqueueAllVectorChanges();
    })();
  }

  getPendingVectorChanges(limit = 50, afterRevision = 0) {
    if (!this.db) throw new Error("Database not initialized");
    return this.db
      .prepare(
        "SELECT note_id, revision FROM pending_vector_changes WHERE revision > ? ORDER BY revision LIMIT ?"
      )
      .all(afterRevision, limit);
  }

  clearPendingVectorChange(noteId, revision) {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db
      .prepare("DELETE FROM pending_vector_changes WHERE note_id = ? AND revision = ?")
      .run(noteId, revision);
    return { success: true, changes: result.changes };
  }

  enqueueAllVectorChanges() {
    if (!this.db) throw new Error("Database not initialized");
    this.db.exec(`
      INSERT INTO pending_vector_changes (note_id) SELECT id FROM notes WHERE TRUE
      ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision
    `);
    return { success: true };
  }

  getNoteForVectorIndex(noteId) {
    if (!this.db) throw new Error("Database not initialized");
    // The durable index spans accounts; renderer/search reads still use the
    // scoped getNote API before exposing any indexed result.
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) || null;
  }

  addPendingVectorPurge(spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("INSERT OR IGNORE INTO pending_vector_purges (space_id) VALUES (?)")
        .run(spaceId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error adding pending vector purge", { error: error.message }, "spaces");
      throw error;
    }
  }

  getPendingVectorPurges() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT space_id FROM pending_vector_purges").all();
    } catch (error) {
      debugLogger.error("Error getting pending vector purges", { error: error.message }, "spaces");
      throw error;
    }
  }

  clearPendingVectorPurge(spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM pending_vector_purges WHERE space_id = ?").run(spaceId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing pending vector purge", { error: error.message }, "spaces");
      throw error;
    }
  }

  getActions() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM actions ORDER BY sort_order ASC, created_at ASC")
        .all()
        .map(toActionItem);
    } catch (error) {
      debugLogger.error("Error getting actions", { error: error.message }, "notes");
      throw error;
    }
  }

  getAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return toActionItem(this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id));
    } catch (error) {
      debugLogger.error("Error getting action", { error: error.message }, "notes");
      throw error;
    }
  }

  createAction(
    name,
    description,
    prompt,
    icon = "sparkles",
    { kind = "template", sections, output } = {}
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (kind !== "template" && kind !== "action") {
        return { success: false, error: "Unknown action kind" };
      }
      const fields = resolveActionFields(kind, { name, description, prompt, sections, output });
      if (fields.error) return { success: false, error: fields.error };
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM actions").get();
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare(
          "INSERT INTO actions (name, description, prompt, icon, sort_order, client_id, kind, sections, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          fields.name,
          fields.description,
          fields.prompt,
          icon || "sparkles",
          sortOrder,
          randomUUID(),
          kind,
          fields.sections,
          fields.output
        );
      const action = toActionItem(
        this.db.prepare("SELECT * FROM actions WHERE id = ?").get(result.lastInsertRowid)
      );
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error creating action", { error: error.message }, "notes");
      throw error;
    }
  }

  // A row's kind and client id never change; every other field is replaced by
  // the update or kept, then validated as a whole.
  updateAction(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const current = this.getAction(id);
      if (!current) return { success: false, error: "Action not found" };
      const merged = { ...current };
      for (const key of [
        "name",
        "description",
        "prompt",
        "icon",
        "sort_order",
        "sections",
        "output",
      ]) {
        if (updates[key] !== undefined) merged[key] = updates[key];
      }
      const fields = resolveActionFields(current.kind, merged);
      if (fields.error) return { success: false, error: fields.error };
      this.db
        .prepare(
          "UPDATE actions SET name = ?, description = ?, prompt = ?, icon = ?, sort_order = ?, sections = ?, output = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(
          fields.name,
          fields.description,
          fields.prompt,
          merged.icon,
          merged.sort_order,
          fields.sections,
          fields.output,
          id
        );
      return { success: true, action: this.getAction(id) };
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
      const accountScope = this._accountScopeCondition("notes");
      const note = this.db
        .prepare(
          `SELECT cloud_id, cloud_create_attempted FROM notes
           WHERE id = ? AND deleted_at IS NULL AND ${accountScope.sql}`
        )
        .get(id, ...accountScope.params);
      // No create request has carried this note, so the server cannot hold it:
      // it leaves the device now, with its chats and speaker rows. Any other
      // note stays a tombstone until its cloud delete lands or a late create
      // receipt links it.
      if (note && !note.cloud_id && !note.cloud_create_attempted) return this.hardDeleteNote(id);
      const stmt = this.db.prepare(
        `UPDATE notes
         SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now')
         WHERE id = ? AND deleted_at IS NULL AND ${accountScope.sql}`
      );
      const result = stmt.run(id, ...accountScope.params);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting note", { error: error.message }, "notes");
      throw error;
    }
  }

  _getOwnedConversation(id) {
    const scope = this._ownedRowScope("agent_conversations");
    return (
      this.db
        .prepare(
          `SELECT * FROM agent_conversations WHERE id = ? AND deleted_at IS NULL AND ${scope.sql}`
        )
        .get(id, ...scope.params) || null
    );
  }

  createAgentConversation(title = "Untitled", noteId = null, spaceId = null, folderId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        let note = null;
        let space = null;
        let folder = null;

        if (noteId != null) {
          note = this.getNote(noteId);
          if (!note || note.deleted_at) return null;
          if (note.folder_id != null) {
            const noteFolder = this._getFolderInAccountScope(note.folder_id);
            if (!noteFolder || noteFolder.deleted_at || noteFolder.space_id !== note.space_id) {
              return null;
            }
          }
        }
        if (spaceId != null) {
          space = this.getSpace(spaceId);
          if (!space) return null;
        }
        if (folderId != null) {
          folder = this._getFolderInAccountScope(folderId);
          if (!folder || folder.deleted_at || !this.getSpace(folder.space_id)) return null;
        }
        if (folder && spaceId != null && folder.space_id !== spaceId) return null;
        if (note && spaceId != null && note.space_id !== spaceId) return null;
        if (note && folderId != null && note.folder_id !== folderId) return null;

        const clientConversationId = randomUUID();
        const result = this.db
          .prepare(
            "INSERT INTO agent_conversations (title, note_id, space_id, folder_id, client_conversation_id, account_id) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(title, noteId, spaceId, folderId, clientConversationId, this.activeAccountId);
        return this.db
          .prepare("SELECT * FROM agent_conversations WHERE id = ?")
          .get(result.lastInsertRowid);
      })();
    } catch (error) {
      debugLogger.error("Error creating agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  getConversationsForNote(noteId, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return [];
      // A team note is shared, but each member sees only their own chats about
      // it. Its delete retires all of them, as it does arriving by pull on each
      // member's own device, and each tombstone waits for its owner's token.
      const scope = this._ownedRowScope("agent_conversations", "c");
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          WHERE c.note_id = ? AND c.deleted_at IS NULL AND ${scope.sql}
          GROUP BY c.id
          ORDER BY datetime(c.updated_at) DESC
          LIMIT ?`
        )
        .all(noteId, ...scope.params, limit);
    } catch (error) {
      debugLogger.error(
        "Error getting conversations for note",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Space-root scope (folderId null) intentionally excludes folder-scoped
  // conversations — each container surfaces only its own chats.
  getConversationsForContainer(spaceId, folderId = null, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (folderId != null) {
        const folder = this._getFolderInAccountScope(folderId);
        if (!folder || folder.deleted_at) return [];
      } else if (!this.getSpace(spaceId)) {
        return [];
      }
      // A chat with no owner is device-owned (a guest's, or one from before
      // chats carried an account) and stays visible to everyone.
      const scopeFilter =
        folderId != null ? "c.folder_id = ?" : "c.space_id = ? AND c.folder_id IS NULL";
      const accountScope = this._ownedRowScope("agent_conversations", "c");
      const params = [folderId != null ? folderId : spaceId, ...accountScope.params, limit];
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          WHERE ${scopeFilter} AND c.deleted_at IS NULL AND ${accountScope.sql}
          GROUP BY c.id
          ORDER BY datetime(c.updated_at) DESC
          LIMIT ?`
        )
        .all(...params);
    } catch (error) {
      debugLogger.error(
        "Error getting conversations for container",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getAgentConversations(limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("agent_conversations");
      return this.db
        .prepare(
          `SELECT * FROM agent_conversations WHERE deleted_at IS NULL AND space_id IS NULL AND folder_id IS NULL AND ${scope.sql} ORDER BY datetime(updated_at) DESC LIMIT ?`
        )
        .all(...scope.params, limit);
    } catch (error) {
      debugLogger.error("Error getting agent conversations", { error: error.message }, "database");
      throw error;
    }
  }

  getAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // A fork names its parent only to an account that can open the parent.
      const scope = this._ownedRowScope("agent_conversations", "c");
      const parentScope = this._ownedRowScope("agent_conversations", "p");
      const conversation = this.db
        .prepare(
          `SELECT c.*, p.title AS parent_title
           FROM agent_conversations c
           LEFT JOIN agent_conversations p
             ON p.id = c.parent_conversation_id AND p.deleted_at IS NULL AND ${parentScope.sql}
           WHERE c.id = ? AND c.deleted_at IS NULL AND ${scope.sql}`
        )
        .get(...parentScope.params, id, ...scope.params);
      if (!conversation) return null;
      // In the order they were saved. Their times can't order them: a pulled
      // message's is ISO ("…T…Z") and a local one's SQLite's ("… …"), so as text
      // a local message sorts before every pulled one of its day.
      const messages = this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY id ASC")
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
      const scope = this._ownedRowScope("agent_conversations");
      // No create request has carried this chat, so it leaves the device now
      // with its messages. A chat held by a pending folder delete is already a
      // tombstone and stays one, so a denied folder delete can still restore it.
      const neverSent = this.db
        .prepare(
          `SELECT 1 FROM agent_conversations WHERE id = ? AND deleted_at IS NULL AND cloud_id IS NULL AND cloud_create_attempted = 0 AND ${scope.sql}`
        )
        .get(id, ...scope.params);
      if (neverSent) return this.hardDeleteConversation(id);
      // As with Clear history, the tombstone is the deleter's to push.
      const result = this.db
        .prepare(
          `UPDATE agent_conversations SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now'), account_id = COALESCE(account_id, ?) WHERE id = ? AND ${scope.sql}`
        )
        .run(this.activeAccountId, id, ...scope.params);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error deleting agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  updateAgentConversationTitle(id, title) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("agent_conversations");
      const result = this.db
        .prepare(
          `UPDATE agent_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL AND ${scope.sql}`
        )
        .run(title, id, ...scope.params);
      return { success: result.changes > 0 };
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
      return this.db.transaction(() => {
        const conversation = this._getOwnedConversation(conversationId);
        if (!conversation) return null;

        const metadataStr = metadata ? JSON.stringify(metadata) : null;
        const result = this.db
          .prepare(
            "INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)"
          )
          .run(conversationId, role, content, metadataStr);
        this.db
          .prepare(
            "UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL"
          )
          .run(conversationId);
        return this.db
          .prepare("SELECT * FROM agent_messages WHERE id = ?")
          .get(result.lastInsertRowid);
      })();
    } catch (error) {
      debugLogger.error("Error adding agent message", { error: error.message }, "database");
      throw error;
    }
  }

  // A reply saved while it waited on the user is completed in place.
  updateAgentMessage(id, content, metadata) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("agent_conversations", "c");
      return this.db.transaction(() => {
        const message = this.db
          .prepare(
            `SELECT m.conversation_id FROM agent_messages m
             JOIN agent_conversations c ON c.id = m.conversation_id
             WHERE m.id = ? AND c.deleted_at IS NULL AND ${scope.sql}`
          )
          .get(id, ...scope.params);
        if (!message) return null;

        this.db
          .prepare("UPDATE agent_messages SET content = ?, metadata = ? WHERE id = ?")
          .run(content, metadata ? JSON.stringify(metadata) : null, id);
        this.db
          .prepare("UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(message.conversation_id);
        return this.db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id);
      })();
    } catch (error) {
      debugLogger.error("Error updating agent message", { error: error.message }, "database");
      throw error;
    }
  }

  // A new chat with the history up to and including one message, in order and
  // with its metadata. The original is never modified. The fork is the forking
  // account's, like any chat it creates.
  forkAgentConversation(conversationId, throughMessageId, forkContext = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const forkId = this.db.transaction(() => {
        const source = this._getOwnedConversation(conversationId);
        const through = this.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM agent_messages
                      WHERE conversation_id = m.conversation_id AND id <= m.id) AS position
             FROM agent_messages m WHERE m.id = ? AND m.conversation_id = ?`
          )
          .get(throughMessageId, conversationId);
        if (!source || !through) return null;

        const result = this.db
          .prepare(
            `INSERT INTO agent_conversations
               (title, note_id, space_id, folder_id, client_conversation_id,
                parent_conversation_id, parent_client_conversation_id,
                fork_message_count, fork_context, account_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            source.title,
            source.note_id,
            source.space_id,
            source.folder_id,
            randomUUID(),
            conversationId,
            source.client_conversation_id,
            through.position,
            forkContext || null,
            // A fork copies its source's messages, so it stays with the source's
            // account: signed out, an unattributed copy would show them to the
            // next account to sign in.
            source.account_id ?? this.activeAccountId
          );
        this.db
          .prepare(
            `INSERT INTO agent_messages (conversation_id, role, content, metadata, created_at)
             SELECT ?, role, content, metadata, created_at FROM agent_messages
             WHERE conversation_id = ? AND id <= ? ORDER BY id`
          )
          .run(result.lastInsertRowid, conversationId, throughMessageId);
        return result.lastInsertRowid;
      })();
      return forkId == null ? null : this.getAgentConversation(forkId);
    } catch (error) {
      debugLogger.error("Error forking agent conversation", { error: error.message }, "database");
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
            .prepare(
              `DELETE FROM calendar_events WHERE provider = 'google' AND calendar_id IN (${placeholders})`
            )
            .run(...calendarIds);
        }
        this.db.prepare("DELETE FROM google_calendars WHERE account_email = ?").run(email);
        this.db.prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?").run(email);
        this._removeContactSources("source = ?", contactSource("google", email));
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
        `INSERT INTO google_calendars (id, summary, description, background_color, account_email, is_primary)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           description = excluded.description,
           background_color = excluded.background_color,
           account_email = excluded.account_email,
           is_primary = excluded.is_primary`
      );
      for (const cal of calendars) {
        stmt.run(
          cal.id,
          cal.summary,
          cal.description || null,
          cal.background_color || null,
          accountEmail,
          cal.is_primary ? 1 : 0
        );
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Google calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  applyPrimaryOnlyToSelection(primaryOnly) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE google_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
        )
        .run(primaryOnly ? 1 : 0);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error applying primary-only selection", { error: error.message }, "gcal");
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
      // Tombstoned chats keep their messages until the delete is final, so
      // only ownership is checked here, not liveness.
      const scope = this._ownedRowScope("agent_conversations");
      const owned = this.db
        .prepare(`SELECT 1 FROM agent_conversations WHERE id = ? AND ${scope.sql}`)
        .get(conversationId, ...scope.params);
      if (!owned) return [];
      return this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY id ASC")
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
          "INSERT OR REPLACE INTO calendar_events (id, calendar_id, provider, summary, start_time, end_time, is_all_day, status, availability_status, self_response_status, hangout_link, conference_data, organizer_email, attendees_count, attendees, web_link, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
        );
        for (const e of eventList) {
          stmt.run(
            e.id,
            e.calendar_id,
            e.provider || "google",
            e.summary || null,
            e.start_time,
            e.end_time,
            e.is_all_day ? 1 : 0,
            e.status || "confirmed",
            e.availability_status || "unknown",
            e.self_response_status || "unknown",
            e.hangout_link || null,
            e.conference_data || null,
            e.organizer_email || null,
            e.attendees_count || 0,
            e.attendees || null,
            e.web_link || null
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
          dedupedEventsQuery(
            "datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
          )
        )
        .all()
        .filter((event) => event.self_response_status !== "declined")
        .map(stripDedupeColumn);
    } catch (error) {
      debugLogger.error("Error getting active events", { error: error.message }, "gcal");
      throw error;
    }
  }

  searchNotes(query, limit = 50, spaceId = null, folderId = null, spaceIds = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const ftsQuery = buildNoteSearchQuery(query);
      if (!ftsQuery) return [];
      const accountScope = this._accountScopeCondition("n");
      const params = [ftsQuery, ...accountScope.params];
      let scopeFilter = "";
      if (spaceId != null) {
        scopeFilter += " AND n.space_id = ?";
        params.push(spaceId);
      }
      if (folderId != null) {
        scopeFilter += " AND n.folder_id = ?";
        params.push(folderId);
      }
      const spaceList = noteSpaceListCondition("n.space_id", spaceIds);
      if (spaceList) {
        scopeFilter += ` AND ${spaceList.sql}`;
        params.push(spaceList.param);
      }
      params.push(limit);
      return this.db
        .prepare(
          `
        SELECT n.*
        FROM notes n
        JOIN notes_fts ON notes_fts.rowid = n.id
        WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND ${accountScope.sql}${scopeFilter}
        ORDER BY notes_fts.rank
        LIMIT ?
      `
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error searching notes", { error: error.message }, "database");
      throw error;
    }
  }

  // includeAllDay adds all-day events from today up to the day the window
  // ends in, not that day itself: the assistant's calendar tool ends each
  // window at a local midnight, rounded up to whole minutes (reminders and the
  // meeting list skip all-day events).
  getUpcomingEvents(windowMinutes = 1440, { includeAllDay = false } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const timed =
        "((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0";
      const allDay = `is_all_day = 1 AND ${ALL_DAY_FIRST_DAY} < date('now', '+' || ? || ' minutes', 'localtime') AND ${ALL_DAY_END_DAY} > date('now', 'localtime')`;
      return this.db
        .prepare(
          dedupedEventsQuery(
            `(${includeAllDay ? `(${timed}) OR (${allDay})` : timed}) AND status IN ('confirmed', 'tentative')`
          )
        )
        .all(...(includeAllDay ? [windowMinutes, windowMinutes] : [windowMinutes]))
        .filter((event) => event.self_response_status !== "declined")
        .map(stripDedupeColumn);
    } catch (error) {
      debugLogger.error("Error getting upcoming events", { error: error.message }, "gcal");
      throw error;
    }
  }

  getCalendarEventsInRange(start, end, providers) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const rangeStart = Date.parse(start);
      const rangeEnd = Date.parse(end);
      if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
        throw new RangeError("Invalid calendar event range");
      }

      const selectedProviders = [...new Set(providers)].filter((provider) =>
        AVAILABILITY_PROVIDERS.has(provider)
      );
      if (selectedProviders.length === 0) return [];
      const placeholders = selectedProviders.map(() => "?").join(", ");
      const events = this.db
        .prepare(
          dedupedEventsQuery(
            `provider IN (${placeholders}) AND status IN ('confirmed', 'tentative') AND ${SELECTED_CALENDAR_EVENT_FILTER}`
          )
        )
        .all(...selectedProviders)
        .map(stripDedupeColumn);

      return events.filter((event) => {
        const isAllDay = event.is_all_day === true || event.is_all_day === 1;
        const eventStart = parseEventTime(event.start_time, isAllDay);
        const eventEnd = parseEventTime(event.end_time, isAllDay);
        return (
          Number.isFinite(eventStart) &&
          Number.isFinite(eventEnd) &&
          eventStart < rangeEnd &&
          eventEnd > rangeStart
        );
      });
    } catch (error) {
      debugLogger.error(
        "Error getting calendar events in range",
        { error: error.message },
        "calendar"
      );
      throw error;
    }
  }

  // The stored events on the user's selected calendars that a note can link
  // to (not cancelled or declined), with its calendar's colour for the picker.
  // `endsAfter` (ISO) leaves out old rows kept only because a note links them,
  // which would otherwise grow with every linked note.
  getLinkableCalendarEvents({ endsAfter = null } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const colors = new Map(
        this.db
          .prepare(
            `SELECT 'google' AS provider, id, background_color AS color FROM google_calendars
             UNION ALL
             SELECT 'microsoft', id, background_color FROM microsoft_calendars
             UNION ALL
             SELECT 'apple', id, color FROM apple_calendars`
          )
          .all()
          .map((row) => [`${row.provider}:${row.id}`, row.color])
      );
      return this.db
        .prepare(
          dedupedEventsQuery(
            `status IN ('confirmed', 'tentative') AND ${SELECTED_CALENDAR_EVENT_FILTER}
             AND (? IS NULL OR datetime(end_time) > datetime(?))`
          )
        )
        .all(endsAfter, endsAfter)
        .filter((event) => event.self_response_status !== "declined")
        .map((row) => {
          const event = stripDedupeColumn(row);
          const color = colors.get(`${event.provider}:${event.calendar_id}`);
          return {
            ...event,
            calendar_color: /^#[0-9a-f]{6}$/i.test(color ?? "") ? color : null,
          };
        });
    } catch (error) {
      debugLogger.error(
        "Error getting linkable calendar events",
        { error: error.message },
        "calendar"
      );
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

  // accountId is the account the action ran under (resolved from its
  // credential by the connector IPC), not this.activeAccountId, which lags a
  // sign-in or account switch.
  insertConnectorAction({
    id,
    accountId = null,
    connector,
    action,
    kind,
    destinationLabel = null,
    state,
    resultUrl = null,
    errorCode = null,
  }) {
    if (!this.db) throw new Error("Database not initialized");
    this.db
      .prepare(
        `INSERT INTO connector_actions
           (id, account_id, connector, action, kind, destination_label, state, result_url, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, accountId, connector, action, kind, destinationLabel, state, resultUrl, errorCode);
  }

  // With fromState, only a row still in that state moves, so a caller can tell
  // a durable transition (1 row) from a missing or already-moved row (0).
  updateConnectorActionState(
    id,
    { state, destinationLabel = null, resultUrl = null, errorCode = null },
    fromState = null
  ) {
    if (!this.db) throw new Error("Database not initialized");
    const guard = fromState === null ? "" : " AND state = ?";
    const params = [
      state,
      destinationLabel,
      resultUrl,
      errorCode,
      id,
      ...(fromState === null ? [] : [fromState]),
    ];
    return this.db
      .prepare(
        `UPDATE connector_actions
           SET state = ?,
               destination_label = COALESCE(?, destination_label),
               result_url = COALESCE(?, result_url),
               error_code = COALESCE(?, error_code),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?${guard}`
      )
      .run(...params).changes;
  }

  // Receipts name the people a user wrote to, so only the account that took
  // the action sees them.
  listRecentConnectorActions(connector, limit = 10, accountId = null) {
    if (!this.db) throw new Error("Database not initialized");
    if (!accountId) return [];
    return this.db
      .prepare(
        `SELECT id, connector, action, kind,
                destination_label AS destinationLabel, state,
                result_url AS resultUrl, error_code AS errorCode,
                created_at AS createdAt
           FROM connector_actions
          WHERE connector = ? AND account_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`
      )
      .all(connector, accountId, limit);
  }

  // A quit mid-send can't tell whether the provider acted, so committing rows
  // become unknown; pending rows were never sent. Rows without an account
  // (only pre-release builds wrote them) are listed to no one and no account
  // deletion reaches them, so they are deleted.
  reconcileInterruptedConnectorActions() {
    if (!this.db) throw new Error("Database not initialized");
    const unknown = this.db
      .prepare(
        "UPDATE connector_actions SET state = 'unknown', error_code = 'app_quit', updated_at = CURRENT_TIMESTAMP WHERE state = 'committing'"
      )
      .run().changes;
    const cancelled = this.db
      .prepare(
        "UPDATE connector_actions SET state = 'cancelled', error_code = 'app_quit', updated_at = CURRENT_TIMESTAMP WHERE state = 'pending'"
      )
      .run().changes;
    const orphaned = this.db
      .prepare("DELETE FROM connector_actions WHERE account_id IS NULL")
      .run().changes;
    return { unknown, cancelled, orphaned };
  }

  // What find_contact searches. calendar_events only holds a sync window
  // (about three days back to a month ahead), so the meetings nearest to now go
  // first, and the contacts table (every synced attendee until its last
  // source is disconnected) covers older ones, most recently seen first. Only
  // the user's own meetings count: not cancelled or declined ones, not a
  // colleague's shared Google calendar (whose people still come through
  // contacts). Contacts come only from hand-added rows and connected
  // accounts; rows older builds stored have no source and are left out.
  // excludedEmails are the user's own addresses and every address a stored
  // event flags as a room or resource.
  getContactLookupSources(meetingLimit = 1000) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const meetings = this.db
        .prepare(
          `SELECT start_time, is_all_day, organizer_email, attendees
             FROM calendar_events
            WHERE (attendees IS NOT NULL OR organizer_email IS NOT NULL)
              AND status IN ('confirmed', 'tentative')
              AND self_response_status != 'declined'
              AND ${SELECTED_CALENDAR_EVENT_FILTER}
              AND (provider != 'google' OR EXISTS (
                SELECT 1 FROM google_calendars
                 WHERE google_calendars.id = calendar_events.calendar_id
                   AND (google_calendars.is_primary = 1 OR google_calendars.id = google_calendars.account_email)
              ))
            ORDER BY ABS(julianday(start_time) - julianday('now')) IS NULL,
                     ABS(julianday(start_time) - julianday('now'))
            LIMIT ?`
        )
        .all(meetingLimit);
      const accounts = this.db
        .prepare(
          `SELECT 'google' AS provider, account_email FROM google_calendars
            WHERE account_email IS NOT NULL
           UNION
           SELECT 'microsoft', account_email FROM microsoft_calendars
            WHERE account_email IS NOT NULL`
        )
        .all();
      const appleConnected = Boolean(this.db.prepare("SELECT 1 FROM apple_calendars").get());
      const sources = [
        contactSource("manual"),
        ...(appleConnected ? [contactSource("apple")] : []),
        ...accounts.map((row) => contactSource(row.provider, row.account_email)),
      ];
      const contacts = this.db
        .prepare(
          `SELECT email, display_name FROM contacts
            WHERE email IN (
              SELECT email FROM contact_sources
               WHERE source IN (${sources.map(() => "?").join(", ")})
            )
            ORDER BY updated_at DESC`
        )
        .all(...sources);
      const microsoftAliases = this.db
        .prepare(
          "SELECT own_addresses FROM microsoft_calendar_tokens WHERE own_addresses IS NOT NULL"
        )
        .all()
        .flatMap((row) => JSON.parse(row.own_addresses));
      const resources = this.db
        .prepare(
          `SELECT DISTINCT attendee.value ->> '$.email' AS email
             FROM calendar_events, json_each(calendar_events.attendees) AS attendee
            WHERE json_valid(calendar_events.attendees)
              AND attendee.value ->> '$.resource' = 1`
        )
        .all()
        .map((row) => row.email);
      const excludedEmails = [
        ...accounts.map((row) => row.account_email),
        ...microsoftAliases,
        ...resources,
      ];
      return { meetings, contacts, excludedEmails };
    } catch (error) {
      debugLogger.error("Error reading contact lookup sources", { error: error.message });
      return { meetings: [], contacts: [], excludedEmails: [] };
    }
  }

  // Join & transcribe resumes this note. Google gives every invitee's copy of an
  // event the same id, so a teammate's synced note for the meeting must never
  // match, or both apps record into one note. Ownership follows ownsNote() in
  // spacePermissions.ts, plus Personal rows synced before owners were recorded.
  getOwnNoteByCalendarEventId(eventId, { throwOnError = false } = {}) {
    // An unlinked note stores "", which must never match.
    if (!eventId) return null;
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("notes");
      return (
        this.db
          .prepare(
            `SELECT notes.* FROM notes
             JOIN spaces ON spaces.id = notes.space_id
             WHERE notes.calendar_event_id = ? AND notes.deleted_at IS NULL
               AND ${accountScope.sql}
               AND (notes.cloud_id IS NULL OR notes.owner_user_id = ?
                 OR (notes.owner_user_id IS NULL AND spaces.kind = 'private'))
             ORDER BY datetime(notes.created_at) DESC, notes.id DESC
             LIMIT 1`
          )
          .get(eventId, ...accountScope.params, this.activeAccountId) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting note by calendar event id",
        { error: error.message },
        "notes"
      );
      if (throwOnError) throw error;
      return null;
    }
  }

  createMeetingNoteForNotification({ title, folderId, spaceId, eventId, participants }) {
    return this.db.transaction(() => {
      const existing = eventId
        ? this.getOwnNoteByCalendarEventId(eventId, { throwOnError: true })
        : null;
      if (existing) return { created: false, note: existing };
      const { note } = this.saveNote(title, "", "meeting", null, null, folderId, spaceId);
      if (!note) throw new Error("Meeting note not saved");
      if (!eventId) return { created: true, note };
      const result = this.updateNote(note.id, {
        calendar_event_id: eventId,
        ...(participants ? { participants } : {}),
      });
      if (!result.success || !result.note) throw new Error("Meeting metadata not saved");
      return { created: true, note: result.note };
    })();
  }

  // With a source (see contactSource), records that it has seen these
  // contacts.
  upsertContacts(contacts, source = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        const upsert = this.db.prepare(
          "INSERT INTO contacts (email, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"
        );
        const addSource = this.db.prepare(
          "INSERT OR IGNORE INTO contact_sources (email, source) VALUES (?, ?)"
        );
        for (const c of list) {
          if (!c.email) continue;
          const email = c.email.toLowerCase().trim();
          upsert.run(email, c.displayName || null);
          if (source) addSource.run(email, source);
        }
      });
      transaction(contacts);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting contacts", { error: error.message }, "database");
      throw error;
    }
  }

  // A note participant becomes a hand-added contact only when nothing stored
  // it before: picking a synced contact from autocomplete leaves it to the
  // accounts that synced it.
  addManualContact(contact) {
    if (!this.db) throw new Error("Database not initialized");
    const email = contact.email?.toLowerCase().trim();
    const isNew =
      Boolean(email) && !this.db.prepare("SELECT 1 FROM contacts WHERE email = ?").get(email);
    return this.upsertContacts([contact], isNew ? contactSource("manual") : null);
  }

  // Hand-added contacts stay, whatever a sync says about the address.
  removeContacts(emails) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "DELETE FROM contacts WHERE email = ? AND email NOT IN (SELECT email FROM contact_sources WHERE source = ?)"
      );
      const transaction = this.db.transaction((list) => {
        for (const email of list) stmt.run(email.toLowerCase().trim(), contactSource("manual"));
      });
      transaction(emails);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing contacts", { error: error.message }, "database");
      throw error;
    }
  }

  // Drops the matching sources and deletes the contacts no other source still
  // has. Rows older builds stored have no sources and stay.
  _removeContactSources(match, value) {
    this.db
      .prepare(
        `DELETE FROM contacts
          WHERE email IN (SELECT email FROM contact_sources WHERE ${match})
            AND email NOT IN (SELECT email FROM contact_sources WHERE NOT (${match}))`
      )
      .run(value, value);
    this.db.prepare(`DELETE FROM contact_sources WHERE ${match}`).run(value);
  }

  // A calendar sync's attendees. Rooms and the user's own addresses are
  // deleted rather than stored: older builds stored them, and nothing else
  // prunes this table.
  syncCalendarContacts(provider, accountEmail, contacts, notContacts) {
    if (contacts.length > 0) this.upsertContacts(contacts, contactSource(provider, accountEmail));
    if (notContacts.length > 0) this.removeContacts(notContacts);
  }

  searchContacts(query) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query || ""}%`;
      return this.db
        .prepare(
          "SELECT email, display_name, created_at, updated_at FROM contacts WHERE email LIKE ? OR display_name LIKE ? ORDER BY display_name ASC, email ASC LIMIT 20"
        )
        .all(pattern, pattern);
    } catch (error) {
      debugLogger.error("Error searching contacts", { error: error.message }, "database");
      throw error;
    }
  }

  clearGoogleCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'google'").run();
        this.db.prepare("DELETE FROM google_calendars").run();
        this.db.prepare("DELETE FROM google_calendar_tokens").run();
        this._removeContactSources("source LIKE ?", contactSource("google", "%"));
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing calendar data", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateCalendarSyncToken(calendarId, syncToken, expiresAt) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE google_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?"
        )
        .run(syncToken, expiresAt, calendarId);
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

  // A full (non-incremental) REST sync is authoritative for its calendar's
  // window: rows the provider no longer returns were deleted while no valid
  // sync token existed (e.g. the app was offline past the token TTL), so they
  // would otherwise linger and fire reminders for cancelled meetings. Rows
  // referenced by meeting notes are kept so notes retain calendar metadata.
  removeStaleCalendarEvents(provider, calendarId, freshEventIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const placeholders = freshEventIds.map(() => "?").join(", ");
      const freshFilter = freshEventIds.length > 0 ? `AND id NOT IN (${placeholders})` : "";
      this.db
        .prepare(
          `DELETE FROM calendar_events
           WHERE provider = ? AND calendar_id = ? ${freshFilter}
             AND id NOT IN (
               SELECT calendar_event_id
               FROM notes
               WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
             )`
        )
        .run(provider, calendarId, ...freshEventIds);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error removing stale calendar events",
        { error: error.message },
        provider === "microsoft" ? "mcal" : "gcal"
      );
      throw error;
    }
  }

  removeEventsFromDeselectedCalendars(provider) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const calendarsTable = CALENDARS_TABLE_BY_PROVIDER[provider];
      if (!calendarsTable) throw new Error(`Unknown calendar provider: ${provider}`);
      this.db
        .prepare(
          `DELETE FROM calendar_events WHERE provider = ? AND calendar_id NOT IN (SELECT id FROM ${calendarsTable} WHERE is_selected = 1)`
        )
        .run(provider);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error removing events from deselected calendars",
        { error: error.message },
        provider === "microsoft" ? "mcal" : "gcal"
      );
      throw error;
    }
  }

  saveMicrosoftTokens(tokens) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO microsoft_calendar_tokens (microsoft_email, access_token, refresh_token, expires_at, scope, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(microsoft_email) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           tenant_id = COALESCE(excluded.tenant_id, tenant_id),
           updated_at = CURRENT_TIMESTAMP`
      );
      stmt.run(
        tokens.microsoft_email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scope,
        tokens.tenant_id ?? null
      );
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Microsoft tokens", { error: error.message }, "mcal");
      throw error;
    }
  }

  getMicrosoftTokensByEmail(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT * FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
          .get(email) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting Microsoft tokens by email",
        { error: error.message },
        "mcal"
      );
      throw error;
    }
  }

  getMicrosoftAccounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT microsoft_email AS email, tenant_id AS tenantId FROM microsoft_calendar_tokens ORDER BY created_at ASC"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting Microsoft accounts", { error: error.message }, "mcal");
      throw error;
    }
  }

  // The account's other addresses (primary SMTP address, aliases), which
  // attendee lists use instead of the sign-in name.
  saveMicrosoftOwnAddresses(email, addresses) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE microsoft_calendar_tokens SET own_addresses = ? WHERE microsoft_email = ?")
        .run(JSON.stringify(addresses), email);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Microsoft addresses", { error: error.message }, "mcal");
      throw error;
    }
  }

  getMicrosoftOwnAddresses(email) {
    const row = this.getMicrosoftTokensByEmail(email);
    return row?.own_addresses ? JSON.parse(row.own_addresses) : [];
  }

  removeMicrosoftAccount(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const calendarIds = this.db
          .prepare("SELECT id FROM microsoft_calendars WHERE account_email = ?")
          .all(email)
          .map((c) => c.id);
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => "?").join(", ");
          this.db
            .prepare(
              `DELETE FROM calendar_events WHERE provider = 'microsoft' AND calendar_id IN (${placeholders})`
            )
            .run(...calendarIds);
        }
        this.db.prepare("DELETE FROM microsoft_calendars WHERE account_email = ?").run(email);
        this.db
          .prepare("DELETE FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
          .run(email);
        this._removeContactSources("source = ?", contactSource("microsoft", email));
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing Microsoft account", { error: error.message }, "mcal");
      throw error;
    }
  }

  saveMicrosoftCalendars(calendars, accountEmail) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO microsoft_calendars (id, summary, background_color, account_email, is_primary)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           background_color = excluded.background_color,
           account_email = excluded.account_email,
           is_primary = excluded.is_primary`
      );
      for (const cal of calendars) {
        stmt.run(
          cal.id,
          cal.summary,
          cal.background_color || null,
          accountEmail,
          cal.is_primary ? 1 : 0
        );
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Microsoft calendars", { error: error.message }, "mcal");
      throw error;
    }
  }

  applyMicrosoftPrimaryOnlyToSelection(primaryOnly) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE microsoft_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
        )
        .run(primaryOnly ? 1 : 0);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error applying primary-only selection", { error: error.message }, "mcal");
      throw error;
    }
  }

  getSelectedMicrosoftCalendars() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM microsoft_calendars WHERE is_selected = 1").all();
    } catch (error) {
      debugLogger.error(
        "Error getting selected Microsoft calendars",
        { error: error.message },
        "mcal"
      );
      throw error;
    }
  }

  updateMicrosoftCalendarSyncToken(calendarId, syncToken, expiresAt) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE microsoft_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?"
        )
        .run(syncToken, expiresAt, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating sync token", { error: error.message }, "mcal");
      throw error;
    }
  }

  clearMicrosoftCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'microsoft'").run();
        this.db.prepare("DELETE FROM microsoft_calendars").run();
        this.db.prepare("DELETE FROM microsoft_calendar_tokens").run();
        this._removeContactSources("source LIKE ?", contactSource("microsoft", "%"));
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing calendar data", { error: error.message }, "mcal");
      throw error;
    }
  }

  saveAppleCalendars(calendars) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // Snapshots are complete: prune calendars removed from Calendar.app,
        // upsert the rest so created_at survives.
        if (list.length === 0) {
          this.db.prepare("DELETE FROM apple_calendars").run();
          return;
        }
        const placeholders = list.map(() => "?").join(", ");
        this.db
          .prepare(`DELETE FROM apple_calendars WHERE id NOT IN (${placeholders})`)
          .run(...list.map((cal) => cal.id));

        const stmt = this.db.prepare(
          `INSERT INTO apple_calendars (id, title, color, source_name)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             color = excluded.color,
             source_name = excluded.source_name`
        );
        for (const cal of list) {
          stmt.run(cal.id, cal.title, cal.color || null, cal.source_name || null);
        }
      });
      transaction(calendars);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  getAppleCalendars() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM apple_calendars").all();
    } catch (error) {
      debugLogger.error("Error getting Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  // Snapshots cover the full cache window, so missing unreferenced events can
  // be removed while note-linked history is retained.
  replaceAppleCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // The helper snapshot only covers the lookback window and the future.
        // Keep older or rescheduled rows that are still referenced by meeting
        // notes so those notes retain their calendar metadata.
        this.db
          .prepare(
            `DELETE FROM calendar_events
             WHERE provider = 'apple'
               AND id NOT IN (
                 SELECT calendar_event_id
                 FROM notes
                 WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
               )`
          )
          .run();
        if (list.length > 0) this.upsertCalendarEvents(list);
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error replacing Apple calendar events", { error: error.message }, "acal");
      throw error;
    }
  }

  clearAppleCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'apple'").run();
        this.db.prepare("DELETE FROM apple_calendars").run();
        this._removeContactSources("source = ?", contactSource("apple"));
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing Apple calendar data", { error: error.message }, "acal");
      throw error;
    }
  }

  getMeetingsFolder(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const targetId = spaceId ?? this.getPrivateSpaceId();
      const space = this.getSpace(targetId);
      if (!space) return null;
      if (space.kind === "private") {
        this.ensureDefaultFolders(targetId);
        const id = this._privateFolderNamed(targetId, space.account_id, "Meetings");
        return id == null ? null : { id };
      }
      const accountScope = this._accountScopeCondition("folders");
      return (
        this.db
          .prepare(
            `SELECT id FROM folders
             WHERE name = 'Meetings' AND is_default = 1 AND space_id = ?
               AND ${accountScope.sql}`
          )
          .get(targetId, ...accountScope.params) || null
      );
    } catch (error) {
      debugLogger.error("Error getting meetings folder", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateNoteCloudId(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return null;
      this.db.prepare("UPDATE notes SET cloud_id = ? WHERE id = ?").run(cloudId, id);
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    } catch (error) {
      debugLogger.error("Error updating note cloud_id", { error: error.message }, "database");
      throw error;
    }
  }

  // Share bookkeeping, not a content edit — must not bump updated_at (which
  // would reorder note lists and churn sync last-write-wins comparisons).
  updateNoteShareState(id, { is_shared, share_token }) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return null;
      if (share_token !== undefined) {
        this.db
          .prepare("UPDATE notes SET is_shared = ?, share_token = ? WHERE id = ?")
          .run(is_shared, share_token, id);
      } else {
        this.db.prepare("UPDATE notes SET is_shared = ? WHERE id = ?").run(is_shared, id);
      }
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    } catch (error) {
      debugLogger.error("Error updating note share state", { error: error.message }, "database");
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
      const scope = this._ownedRowScope("agent_conversations", "c");
      const archiveFilter = includeArchived
        ? `WHERE c.archived_at IS NOT NULL AND c.deleted_at IS NULL AND c.space_id IS NULL AND c.folder_id IS NULL AND ${scope.sql}`
        : `WHERE c.archived_at IS NULL AND c.deleted_at IS NULL AND c.space_id IS NULL AND c.folder_id IS NULL AND ${scope.sql}`;
      // Only a note the active account can open names a chat's source.
      const noteScope = this._accountScopeCondition("n");
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at, c.archived_at, c.cloud_id,
            c.parent_conversation_id,
            c.note_id, n.title AS note_title, n.deleted_at AS note_deleted_at,
            n.space_id AS note_space_id,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          LEFT JOIN notes n ON n.id = c.note_id AND ${noteScope.sql}
          ${archiveFilter}
          GROUP BY c.id
          ORDER BY datetime(c.updated_at) DESC
          LIMIT ? OFFSET ?`
        )
        .all(...noteScope.params, ...scope.params, limit, offset);
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
      const scope = this._ownedRowScope("agent_conversations", "c");
      const noteScope = this._accountScopeCondition("n");
      return this.db
        .prepare(
          `SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.archived_at, c.cloud_id,
            c.parent_conversation_id,
            c.note_id, n.title AS note_title, n.deleted_at AS note_deleted_at,
            n.space_id AS note_space_id,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          LEFT JOIN agent_messages ms ON ms.conversation_id = c.id
          LEFT JOIN notes n ON n.id = c.note_id AND ${noteScope.sql}
          WHERE c.archived_at IS NULL AND c.deleted_at IS NULL
            AND c.space_id IS NULL AND c.folder_id IS NULL
            AND ${scope.sql}
            AND (c.title LIKE ? OR ms.content LIKE ?)
          GROUP BY c.id
          ORDER BY datetime(c.updated_at) DESC
          LIMIT ?`
        )
        .all(...noteScope.params, ...scope.params, pattern, pattern, limit);
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
      const scope = this._ownedRowScope("agent_conversations");
      const result = this.db
        .prepare(
          `UPDATE agent_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL AND ${scope.sql}`
        )
        .run(id, ...scope.params);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error archiving agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  unarchiveAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("agent_conversations");
      const result = this.db
        .prepare(
          `UPDATE agent_conversations SET archived_at = NULL WHERE id = ? AND deleted_at IS NULL AND ${scope.sql}`
        )
        .run(id, ...scope.params);
      return { success: result.changes > 0 };
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
      const scope = this._ownedRowScope("agent_conversations");
      const result = this.db
        .prepare(
          `UPDATE agent_conversations SET cloud_id = ? WHERE id = ? AND deleted_at IS NULL AND ${scope.sql}`
        )
        .run(cloudId, id, ...scope.params);
      return { success: result.changes > 0 };
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

  _findSpeakerProfile(name, email, profileId) {
    return (
      (profileId &&
        this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId)) ||
      this._findProfileByEmail(email) ||
      this.db.prepare("SELECT * FROM speaker_profiles WHERE display_name = ?").get(name) ||
      null
    );
  }

  // A label with no voice to learn from (the note predates the current
  // embeddings, or was never diarized) can't create a profile, which needs an
  // embedding. It still links the one the person has and gives it the email.
  linkSpeakerProfile(name, email, profileId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const existing = this._findSpeakerProfile(name, email, profileId);
      const normalizedEmail = this._normalizeEmail(email);
      if (
        !existing ||
        !normalizedEmail ||
        normalizedEmail === this._normalizeEmail(existing.email)
      ) {
        return existing;
      }
      return this.attachEmailToProfile(existing.id, normalizedEmail);
    } catch (error) {
      debugLogger.error("Error linking speaker profile", { error: error.message }, "database");
      throw error;
    }
  }

  upsertSpeakerProfile(name, email, embeddingBuffer, profileId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      const existing = this._findSpeakerProfile(name, normalizedEmail, profileId);
      if (existing) {
        const incoming = new Float32Array(
          embeddingBuffer.buffer,
          embeddingBuffer.byteOffset,
          embeddingBuffer.byteLength / 4
        );
        // A stored embedding from an older feature-extraction version lives in an
        // incompatible space, so blending it with a current one is meaningless.
        // Re-enroll by replacing it outright and restarting the running average.
        const staleSpace = existing.embedding_version !== EMBEDDING_VERSION;
        let updatedBuf;
        let sampleCountExpr;
        if (staleSpace) {
          updatedBuf = Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength);
          sampleCountExpr = "1";
        } else {
          const stored = new Float32Array(
            existing.embedding.buffer,
            existing.embedding.byteOffset,
            existing.embedding.byteLength / 4
          );
          const updated = new Float32Array(stored.length);
          for (let i = 0; i < stored.length; i++) {
            updated[i] = 0.3 * incoming[i] + 0.7 * stored[i];
          }
          updatedBuf = Buffer.from(updated.buffer);
          sampleCountExpr = "sample_count + 1";
        }
        const finalEmail = normalizedEmail || existing.email || null;
        this.db
          .prepare(
            `UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, embedding_version = ?, sample_count = ${sampleCountExpr}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          )
          .run(name, finalEmail, updatedBuf, EMBEDDING_VERSION, existing.id);
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
        .prepare(
          "INSERT INTO speaker_profiles (display_name, email, embedding, embedding_version) VALUES (?, ?, ?, ?)"
        )
        .run(name, normalizedEmail, embeddingBuffer, EMBEDDING_VERSION);
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

    const toF32 = (p) =>
      new Float32Array(p.embedding.buffer, p.embedding.byteOffset, p.embedding.byteLength / 4);
    const f32ToBuf = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

    const wSamples = winner.sample_count || 1;
    const lSamples = loser.sample_count || 1;
    const total = wSamples + lSamples;

    const winnerCurrent = winner.embedding_version === EMBEDDING_VERSION;
    const loserCurrent = loser.embedding_version === EMBEDDING_VERSION;

    // Identity (name/email/mappings) always merges; the embedding must never be
    // blended across feature-extraction versions, so only combine same-space
    // vectors and otherwise keep whichever one is current.
    let finalEmbeddingBuf;
    let finalVersion;
    let finalSampleCount;
    if (winnerCurrent && loserCurrent) {
      const winnerEmb = toF32(winner);
      const loserEmb = toF32(loser);
      const blended = new Float32Array(winnerEmb.length);
      for (let i = 0; i < winnerEmb.length; i++) {
        blended[i] = (winnerEmb[i] * wSamples + loserEmb[i] * lSamples) / total;
      }
      finalEmbeddingBuf = Buffer.from(blended.buffer);
      finalVersion = EMBEDDING_VERSION;
      finalSampleCount = total;
    } else if (winnerCurrent || loserCurrent) {
      const keep = winnerCurrent ? winner : loser;
      finalEmbeddingBuf = f32ToBuf(toF32(keep));
      finalVersion = EMBEDDING_VERSION;
      finalSampleCount = keep.sample_count || 1;
    } else {
      // Both stale: keep a valid blob but leave it marked stale for re-enrollment.
      finalEmbeddingBuf = f32ToBuf(toF32(winner));
      finalVersion = winner.embedding_version ?? null;
      finalSampleCount = total;
    }

    const finalEmail = winner.email || loser.email || null;
    const finalName = winner.display_name || loser.display_name;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, embedding_version = ?, sample_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(finalName, finalEmail, finalEmbeddingBuf, finalVersion, finalSampleCount, winner.id);
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
      // Embeddings are only returned for auto-matching, so restrict them to the
      // current feature-extraction version. Legacy-space embeddings would produce
      // meaningless cosine scores; the profile survives (name/email) and is matched
      // again once re-enrolled. The name-only listing keeps every profile.
      const query = includeEmbedding
        ? "SELECT * FROM speaker_profiles WHERE embedding_version = ?"
        : `SELECT id, display_name, email, sample_count, created_at, updated_at
           FROM speaker_profiles`;
      const stmt = this.db.prepare(query);
      return includeEmbedding ? stmt.all(EMBEDDING_VERSION) : stmt.all();
    } catch (error) {
      debugLogger.error("Error getting speaker profiles", { error: error.message }, "database");
      throw error;
    }
  }

  setSpeakerMapping(noteId, speakerId, profileId, displayName) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false, error: "Note not found" };
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
      if (!this.getNote(noteId)) return [];
      return this.db.prepare("SELECT * FROM speaker_mappings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error("Error getting speaker mappings", { error: error.message }, "database");
      throw error;
    }
  }

  saveNoteSpeakerEmbeddings(noteId, embeddings) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false, error: "Note not found" };
      const transaction = this.db.transaction((entries) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO note_speaker_embeddings (note_id, speaker_id, embedding, embedding_version) VALUES (?, ?, ?, ?)"
        );
        for (const [speakerId, buffer] of entries) {
          stmt.run(noteId, speakerId, buffer, EMBEDDING_VERSION);
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
      if (!this.getNote(noteId)) return [];
      // Only expose embeddings from the current feature-extraction version; older
      // ones live in an incompatible space and must not seed profiles or matches.
      return this.db
        .prepare(
          "SELECT * FROM note_speaker_embeddings WHERE note_id = ? AND embedding_version = ?"
        )
        .all(noteId, EMBEDDING_VERSION);
    } catch (error) {
      debugLogger.error(
        "Error getting note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // The queue a sync pass reads. 'team': team rows, plus cloud-backed rows that
  // just LEFT a team (D6), which SyncService now detaches rather than retracts,
  // since they sit in Private. 'syncable': the same, plus the only private
  // notes that still reach the cloud (LEGACY_SHARED_PRIVATE_NOTE_SQL). Sync
  // passes read only these two; 'private' and no argument read the queue whole.
  getPendingNotes(spaceKind = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("n");
      if (spaceKind != null) {
        const syncScope = spaceKind === "team" || spaceKind === "syncable";
        const leftTeam = syncScope ? " OR (n.left_team = 1 AND n.cloud_id IS NOT NULL)" : "";
        const shared = spaceKind === "syncable" ? ` OR ${LEGACY_SHARED_PRIVATE_NOTE_SQL}` : "";
        return this.db
          .prepare(
            `SELECT n.* FROM notes n JOIN spaces s ON s.id = n.space_id
             WHERE n.sync_status IN ('pending', 'error') AND n.deleted_at IS NULL
               AND ${accountScope.sql} AND (s.kind = ?${leftTeam}${shared})`
          )
          .all(...accountScope.params, syncScope ? "team" : spaceKind);
      }
      // 'error' rows retry too: a transient failure (e.g. one offline pass)
      // must not strand a note until its next local edit.
      return this.db
        .prepare(
          `SELECT n.* FROM notes n
           WHERE n.sync_status IN ('pending', 'error') AND n.deleted_at IS NULL
             AND ${accountScope.sql}`
        )
        .all(...accountScope.params);
    } catch (error) {
      debugLogger.error("Error getting pending notes", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingNoteDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("n");
      return this.db
        .prepare(
          `SELECT * FROM notes n
           WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL
             AND sync_status = 'pending'
             AND ${accountScope.sql}
             AND NOT EXISTS (
               SELECT 1 FROM optimistic_folder_delete_rows r
               WHERE r.entity_type = 'note' AND r.entity_id = n.id
             )`
        )
        .all(...accountScope.params);
    } catch (error) {
      debugLogger.error("Error getting pending note deletes", { error: error.message }, "database");
      throw error;
    }
  }

  getNoteByClientId(clientNoteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("n");
      return (
        this.db
          .prepare(
            `SELECT n.*, ${NOTE_FOLDER_DELETE_PENDING_SQL}
             FROM notes n
             WHERE n.client_note_id = ? AND ${accountScope.sql}`
          )
          .get(clientNoteId, ...accountScope.params) || null
      );
    } catch (error) {
      debugLogger.error("Error getting note by client id", { error: error.message }, "database");
      throw error;
    }
  }

  // A copy of a cloud row that had no client id when it was pulled sits under a
  // key of its own, so the cloud id finds what the key misses. A key held for
  // another cloud row is not a match: acting on it would delete the wrong note.
  getNoteForCloudRow(clientNoteId, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const byKey = clientNoteId ? this.getNoteByClientId(clientNoteId) : null;
      if (byKey && (!byKey.cloud_id || byKey.cloud_id === cloudId)) return byKey;
      return this._getNoteByCloudId(cloudId);
    } catch (error) {
      debugLogger.error("Error getting note for cloud row", { error: error.message }, "database");
      throw error;
    }
  }

  _getNoteByCloudId(cloudId) {
    const accountScope = this._accountScopeCondition("n");
    return (
      this.db
        .prepare(
          `SELECT n.*, ${NOTE_FOLDER_DELETE_PENDING_SQL}
           FROM notes n
           WHERE n.cloud_id = ? AND ${accountScope.sql}
           ORDER BY n.deleted_at IS NOT NULL, n.id
           LIMIT 1`
        )
        .get(cloudId, ...accountScope.params) || null
    );
  }

  // Older releases stored a new row each time a pull carried a cloud note with
  // no client id. Every copy still writes to that one cloud note, so deleting
  // any of them deletes it everywhere. Pending metadata keeps its original
  // cloud identity; otherwise the copy nearest the cloud's current state wins.
  // Never mix copies: stale text under a current base could overwrite the cloud.
  // Other distinct pending edits become notes of their own. Copies a folder
  // delete or unresolved create still owns wait for a later launch. Returns
  // the removed note ids.
  mergeDuplicateCloudNotes() {
    if (!this.db) throw new Error("Database not initialized");
    const cloudIds = this.db
      .prepare(
        "SELECT cloud_id FROM notes WHERE cloud_id IS NOT NULL GROUP BY cloud_id HAVING COUNT(*) > 1"
      )
      .pluck()
      .all();
    const removedIds = [];
    if (cloudIds.length === 0) return removedIds;

    const readCopies = this.db.prepare(
      `SELECT n.*, ${NOTE_FOLDER_DELETE_PENDING_SQL} FROM notes n WHERE n.cloud_id = ?`
    );
    const spaceOf = this.db.prepare("SELECT kind, workspace_id FROM spaces WHERE id = ?");
    const moveConversations = this.db.prepare(
      "UPDATE agent_conversations SET note_id = ? WHERE note_id = ?"
    );
    const moveSpeakerMappings = this.db.prepare(
      "UPDATE OR IGNORE speaker_mappings SET note_id = ? WHERE note_id = ?"
    );
    const moveSpeakerEmbeddings = this.db.prepare(
      "UPDATE OR IGNORE note_speaker_embeddings SET note_id = ? WHERE note_id = ?"
    );
    const deleteNote = this.db.prepare("DELETE FROM notes WHERE id = ?");
    const detachNote = this.db.prepare(
      "UPDATE notes SET space_id = ?, folder_id = ?, client_note_id = ?, account_id = COALESCE(account_id, ?), cloud_id = NULL, cloud_updated_at = NULL, cloud_revision = NULL, cloud_create_attempted = 0, owner_user_id = NULL, updated_by_user_id = NULL, sync_status = 'pending', left_team = 0, is_shared = 0, share_token = NULL WHERE id = ?"
    );
    const detachConversations = this.db.prepare(
      "UPDATE agent_conversations SET space_id = NULL, folder_id = NULL WHERE note_id = ?"
    );
    const updateKept = this.db.prepare(
      `UPDATE notes SET account_id = COALESCE(account_id, ?), is_shared = ?, share_token = ?,
         sync_status = ? WHERE id = ?`
    );

    const isDirty = (note) => note.sync_status !== "synced";
    const instant = (value) => Date.parse(String(value).replace(" ", "T").replace(/Z?$/, "Z")) || 0;
    const preference = (a, b) =>
      (b.cloud_revision ?? -1) - (a.cloud_revision ?? -1) ||
      instant(b.cloud_updated_at) - instant(a.cloud_updated_at) ||
      isDirty(b) - isDirty(a) ||
      instant(b.updated_at) - instant(a.updated_at) ||
      a.id - b.id;
    const text = (value) => (value ?? "").trim();
    const TEXT_FIELDS = ["content", "enhanced_content", "transcript"];
    const METADATA_FIELDS = [
      ...SUMMARY_METADATA,
      "note_type",
      "source_file",
      "audio_duration_seconds",
      "folder_id",
      "space_id",
      "left_team",
      "calendar_event_id",
      "participants",
      "diarization_enabled",
      "expected_speaker_count",
    ];
    const sameText = (a, b) =>
      ["title", ...TEXT_FIELDS].every((field) => text(a[field]) === text(b[field]));
    const sameMetadata = (a, b) => METADATA_FIELDS.every((field) => a[field] === b[field]);
    // Text the kept copy doesn't have, blank copies aside. A blank on the kept
    // copy may be a clear the cloud recorded or may not; only its own pending
    // clear is certain.
    const fillsBlank = (note, kept) =>
      TEXT_FIELDS.some(
        (field) => text(note[field]) && !text(kept[field]) && !kept[`${field}_sync_operation`]
      );
    const holdsEdit = (note, kept) =>
      ["title", ...TEXT_FIELDS].some(
        (field) => text(note[field]) && text(note[field]) !== text(kept[field])
      ) || !sameMetadata(note, kept);
    const soleSpaceAccount = this.db
      .prepare("SELECT account_id FROM space_accounts WHERE space_id = ?")
      .pluck();

    const merge = this.db.transaction((copies, account) => {
      const sorted = copies.toSorted(preference);
      const preferred = sorted.find((note) => !note.deleted_at) ?? sorted[0];
      // A pending move or metadata edit still targets the original cloud row.
      // Keep that complete snapshot with its own base so conflict resolution
      // can settle it. Multiple linked copies would make Refresh hit a sibling.
      const metadataDiffers = sorted.some(
        (note) => !note.deleted_at && !sameMetadata(note, preferred)
      );
      const pendingMetadata = sorted.filter(
        (note) =>
          !note.deleted_at &&
          isDirty(note) &&
          ((note.id === preferred.id && metadataDiffers) || !sameMetadata(note, preferred))
      );
      const kept =
        pendingMetadata.find((note) => note.left_team) ?? pendingMetadata[0] ?? preferred;
      // The share lives only on this device, and its token can't be fetched again.
      const shared = sorted.find((note) => note.share_token) ?? kept;
      const ownNotes = [kept];
      const removed = [];
      // Clean copies are past versions of one cloud note, so the newest stands in
      // for the rest; a note per version would flood the list.
      let keptCleanText = false;
      for (const note of sorted) {
        if (note.id === kept.id) continue;
        const preserveCopy =
          !note.deleted_at &&
          !ownNotes.some((other) => sameText(note, other) && sameMetadata(note, other)) &&
          (isDirty(note) ? holdsEdit(note, kept) : !keptCleanText && fillsBlank(note, kept));
        if (preserveCopy) {
          if (!isDirty(note)) keptCleanText = true;
          const space = spaceOf.get(note.space_id);
          const inTeam = space?.kind === "team";
          const spaceAccounts = inTeam ? soleSpaceAccount.all(note.space_id) : [];
          const owner = account ?? (spaceAccounts.length === 1 ? spaceAccounts[0] : null);
          // A team note's other edit becomes its owner's own note, in that
          // owner's Private for the teamspace's workspace.
          detachNote.run(
            inTeam ? this._detachedPrivateSpaceId(space.workspace_id, owner) : note.space_id,
            inTeam ? null : note.folder_id,
            randomUUID(),
            owner,
            note.id
          );
          if (inTeam) detachConversations.run(note.id);
          ownNotes.push(note);
          continue;
        }
        moveConversations.run(kept.id, note.id);
        // A chat following its note across spaces must not keep the old scope:
        // tearing that space down would retire it.
        if (note.space_id !== kept.space_id) detachConversations.run(kept.id);
        moveSpeakerMappings.run(kept.id, note.id);
        moveSpeakerEmbeddings.run(kept.id, note.id);
        this._deleteSpeakerRowsForNotes("SELECT id FROM notes WHERE id = ?", note.id);
        deleteNote.run(note.id);
        removed.push(note.id);
      }
      updateKept.run(
        account,
        kept.is_shared || (shared.share_token ? 1 : 0),
        kept.share_token ?? shared.share_token,
        // Only a pending tombstone is pushed; the delete must still reach the cloud.
        kept.deleted_at ? "pending" : kept.sync_status,
        kept.id
      );
      return removed;
    });

    for (const cloudId of cloudIds) {
      try {
        const copies = readCopies.all(cloudId);
        // A row with no account joins the one account holding the note, as a
        // pull adopts it. With two accounts each keeps its own and it stays out.
        const accounts = [...new Set(copies.map((note) => note.account_id).filter(Boolean))];
        const groups =
          accounts.length > 1
            ? accounts.map((account) => copies.filter((note) => note.account_id === account))
            : [copies];
        for (const group of groups) {
          const held = group.some(
            (note) =>
              note.folder_delete_pending || note.cloud_create_pending || note.cloud_create_rejected
          );
          if (group.length > 1 && !held) {
            const account = group.find((note) => note.account_id)?.account_id ?? null;
            removedIds.push(...merge(group, account));
          }
        }
      } catch (error) {
        debugLogger.error("Merging note copies failed", { error: error.message }, "database");
      }
    }
    return removedIds;
  }

  // newKeyIfTaken (the import of cloud private notes, D28): a cloud row whose
  // client key another account's note, or a note bound to another cloud row,
  // holds here is stored under a key of its own instead of being skipped.
  upsertNoteFromCloud(
    cloudNote,
    localFolderId,
    localSpaceId = null,
    { newKeyIfTaken = false } = {}
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const requestedFolderId = localFolderId;
      // A cloud row with no space is a personal note: the default's Private.
      let spaceId = localSpaceId ?? this.getDefaultPrivateSpaceId();
      const existing =
        (cloudNote.client_note_id &&
          this.db
            .prepare("SELECT * FROM notes WHERE client_note_id = ?")
            .get(cloudNote.client_note_id)) ||
        this._getNoteByCloudId(cloudNote.id);
      if (this._keepsPrivatePlacement(existing?.space_id, spaceId)) {
        spaceId = existing.space_id;
        const folderSpaceId =
          localFolderId == null
            ? null
            : this.db.prepare("SELECT space_id FROM folders WHERE id = ?").get(localFolderId)
                ?.space_id;
        // Only a folder in its own Private section can take it. Otherwise, the
        // cloud's root included, it stays filed where it is.
        if (folderSpaceId !== spaceId) localFolderId = existing.folder_id;
      }
      const accountId = this._accountIdForSpace(spaceId);
      // Rows without an account (created signed out or before attribution) and
      // personal<->team moves are adopted as before; only another account's
      // row or another cloud row is left alone. Never throw: one bad row would
      // abort the whole pull and stall its cursor.
      const otherAccount = existing?.account_id && accountId && existing.account_id !== accountId;
      const otherCloudRow = existing?.cloud_id && existing.cloud_id !== cloudNote.id;
      if ((otherAccount || otherCloudRow) && newKeyIfTaken) {
        // The row holding the key is left as it is. This account's own copy of
        // the cloud row keeps its key; otherwise the note gets a new one.
        const own = this._getNoteByCloudId(cloudNote.id);
        return this.upsertNoteFromCloud(
          { ...cloudNote, client_note_id: own?.client_note_id ?? randomUUID() },
          requestedFolderId,
          localSpaceId
        );
      }
      if (otherAccount || otherCloudRow) {
        debugLogger.warn(
          "Skipping cloud note that belongs to another local row",
          { otherAccount: Boolean(otherAccount), otherCloudRow: Boolean(otherCloudRow) },
          "database"
        );
        // IPC broadcasts every returned note, so a skipped row must stay private.
        return null;
      }
      const versioned = hasNoteRevision(cloudNote.revision);
      // A copy older than the revision this device acknowledged is stale. One
      // without a revision (an API that predates them) applies as before and
      // drops the local revision.
      if (
        versioned &&
        hasNoteRevision(existing?.cloud_revision) &&
        cloudNote.revision < existing.cloud_revision
      )
        return existing;
      const cleared = versioned ? clearedNoteFields(cloudNote) : [];
      const clearsContent = cleared.includes("content");
      const clearsSummary = cleared.includes("enhanced_content");
      cloudNote = { ...cloudNote };
      // Until the cloud row has a client id the local copy keeps its own, and a
      // new copy needs one: a row without a key can't be matched or conflict-gated.
      if (!cloudNote.client_note_id) {
        cloudNote.client_note_id = existing?.client_note_id ?? randomUUID();
      }
      // A note created through the public API without a title has none in the
      // cloud; the local column requires one.
      if (cloudNote.title == null) cloudNote.title = "Untitled Note";
      if (!cloudNote.content?.trim()) cloudNote.content = "";
      if (!cloudNote.enhanced_content?.trim()) cloudNote.enhanced_content = null;
      if (clearsSummary) {
        for (const key of SUMMARY_CLEARED_METADATA) cloudNote[key] = null;
      }
      const hasExplicitCreator = Object.prototype.hasOwnProperty.call(
        cloudNote,
        "created_by_user_id"
      );
      const hasLegacyCreator = Object.prototype.hasOwnProperty.call(cloudNote, "user_id");
      const createdByUserId = hasExplicitCreator ? cloudNote.created_by_user_id : cloudNote.user_id;
      const creatorUpdate =
        hasExplicitCreator || hasLegacyCreator
          ? "excluded.created_by_user_id"
          : "created_by_user_id";
      const hasExplicitUpdater = Object.prototype.hasOwnProperty.call(
        cloudNote,
        "updated_by_user_id"
      );
      const updaterUpdate = hasExplicitUpdater
        ? "excluded.updated_by_user_id"
        : "updated_by_user_id";
      // Sync must never replace non-empty local content/enhanced_content/
      // transcript with an empty cloud value (#1290, the #938 invariant),
      // unless the cloud recorded that empty value as a deliberate clear.
      // The enhancement prompt/hash/template travel with enhanced_content.
      const keepsLocalContent = clearsContent
        ? "0"
        : "COALESCE(excluded.content, '') = '' AND COALESCE(content, '') <> ''";
      const keepsLocalSummary = clearsSummary
        ? "0"
        : "COALESCE(excluded.enhanced_content, '') = '' AND COALESCE(enhanced_content, '') <> ''";
      // An API that predates template ids omits the key; keep the local one.
      const templateIdUpdate = Object.prototype.hasOwnProperty.call(
        cloudNote,
        "enhancement_template_id"
      )
        ? `CASE WHEN ${keepsLocalSummary}
            THEN enhancement_template_id ELSE excluded.enhancement_template_id END`
        : "enhancement_template_id";
      const stmt = this.db.prepare(`
        INSERT INTO notes (client_note_id, cloud_id, title, content, enhanced_content,
          enhancement_prompt, enhancement_template_id, enhanced_at_content_hash, note_type, source_file,
          audio_duration_seconds, transcript, folder_id, space_id, participants, calendar_event_id,
          diarization_enabled, expected_speaker_count, updated_by_user_id, owner_user_id, created_by_user_id, sync_status, created_at, updated_at,
          cloud_updated_at, account_id, cloud_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?, ?)
        ON CONFLICT(client_note_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          title = excluded.title,
          content = CASE WHEN ${keepsLocalContent}
            THEN content ELSE excluded.content END,
          enhanced_content = CASE WHEN ${keepsLocalSummary}
            THEN enhanced_content ELSE excluded.enhanced_content END,
          enhancement_prompt = CASE WHEN ${keepsLocalSummary}
            THEN enhancement_prompt ELSE excluded.enhancement_prompt END,
          enhancement_template_id = ${templateIdUpdate},
          enhanced_at_content_hash = CASE WHEN ${keepsLocalSummary}
            THEN enhanced_at_content_hash ELSE excluded.enhanced_at_content_hash END,
          transcript = CASE
            WHEN COALESCE(excluded.transcript, '') = '' AND COALESCE(transcript, '') <> ''
            THEN transcript ELSE excluded.transcript END,
          folder_id = excluded.folder_id,
          space_id = excluded.space_id,
          account_id = excluded.account_id,
          participants = COALESCE(excluded.participants, participants),
          calendar_event_id = COALESCE(excluded.calendar_event_id, calendar_event_id),
          diarization_enabled = COALESCE(excluded.diarization_enabled, diarization_enabled),
          expected_speaker_count = COALESCE(excluded.expected_speaker_count, expected_speaker_count),
          updated_by_user_id = ${updaterUpdate},
          owner_user_id = COALESCE(excluded.owner_user_id, owner_user_id),
          created_by_user_id = ${creatorUpdate},
          -- A delete made while this pull was in flight must still reach the cloud.
          sync_status = CASE WHEN deleted_at IS NOT NULL THEN sync_status ELSE 'synced' END,
          left_team = 0,
          updated_at = excluded.updated_at,
          cloud_updated_at = excluded.cloud_updated_at,
          cloud_revision = excluded.cloud_revision,
          cloud_create_rejected = 0,
          cloud_create_pending = NULL,
          content_sync_operation = NULL,
          enhanced_content_sync_operation = NULL
      `);
      // The cloud row's client id wins, so the next pull matches by key.
      if (existing && existing.client_note_id !== cloudNote.client_note_id) {
        this.db
          .prepare("UPDATE notes SET client_note_id = ? WHERE id = ?")
          .run(cloudNote.client_note_id, existing.id);
      }
      stmt.run(
        cloudNote.client_note_id,
        cloudNote.id,
        cloudNote.title,
        cloudNote.content,
        cloudNote.enhanced_content || null,
        cloudNote.enhancement_prompt || null,
        cloudNote.enhancement_template_id || null,
        cloudNote.enhanced_at_content_hash || null,
        cloudNote.note_type || "personal",
        cloudNote.source_file || null,
        cloudNote.audio_duration_seconds || null,
        cloudNote.transcript || null,
        localFolderId,
        spaceId,
        cloudNote.participants || null,
        // "" is the cloud's record of a deliberate unlink; NULL means the API
        // omitted the field, which the COALESCE above treats as "keep local".
        cloudNote.calendar_event_id ?? null,
        cloudNote.diarization_enabled ?? null,
        normalizeStoredSpeakerCount(cloudNote.expected_speaker_count),
        cloudNote.updated_by_user_id || null,
        cloudNote.user_id ?? null,
        createdByUserId ?? null,
        cloudNote.created_at,
        cloudNote.updated_at,
        cloudNote.updated_at,
        accountId,
        versioned ? cloudNote.revision : null
      );
      return this.db
        .prepare("SELECT * FROM notes WHERE client_note_id = ?")
        .get(cloudNote.client_note_id);
    } catch (error) {
      debugLogger.error("Error upserting note from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markNoteSynced(id, cloudId, cloudUpdatedAt = null, ownerUserId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return { success: false, changes: 0 };
      // cloud_updated_at and owner_user_id are overwritten even with null: a
      // forked row that re-creates under a new cloud_id must not keep the old
      // note's base or its previous owner (a null base settles last-write-wins
      // once; a null owner fails closed until a pull records the real one).
      this.db
        .prepare(
          "UPDATE notes SET sync_status = 'synced', cloud_id = ?, left_team = 0, cloud_updated_at = ?, owner_user_id = ? WHERE id = ?"
        )
        .run(cloudId, cloudUpdatedAt, ownerUserId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking note synced", { error: error.message }, "database");
      throw error;
    }
  }

  // A row moved from a team space to Personal while its push was in flight
  // still owes the server a scope retraction for the returned team-side copy.
  _leftTeamDuringPush(snapshotSpaceId, currentSpaceId) {
    const kindOf = this.db.prepare("SELECT kind FROM spaces WHERE id = ?");
    return kindOf.get(snapshotSpaceId)?.kind === "team" &&
      kindOf.get(currentSpaceId)?.kind === "private"
      ? 1
      : 0;
  }

  // Runs just before a create request is sent. Returns the client ids that still
  // name a note, so a note deleted or given a new identity since the push read
  // it is left out of the request.
  markNoteCreatesAttempted(clientNoteIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const mark = this.db.prepare(
        "UPDATE notes SET cloud_create_attempted = 1 WHERE client_note_id = ?"
      );
      return this.db.transaction(() =>
        clientNoteIds.filter((clientNoteId) => mark.run(clientNoteId).changes > 0)
      )();
    } catch (error) {
      debugLogger.error(
        "Error marking note creates attempted",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // A create response arrives after an arbitrary network delay. Adopt it only
  // for the exact local identity that issued the request, and settle only when
  // every pushed field still matches that request's snapshot. A newer edit
  // adopts the cloud identity/base but remains pending. Response metadata is
  // assigned even when null because a fork may still carry the old identity's
  // base/owner. A purge forks the client_note_id, so the relocated Personal
  // row is never mutated. Partial migration creates explicitly opt out of
  // settling so a later full PATCH still delivers fields the POST omitted.
  // writeRejected links a create the server refused without writing it, so
  // the row stays parked until a pull resolves it (cloud_create_rejected).
  acknowledgeNoteCreate(
    id,
    snapshot,
    cloudId,
    cloudUpdatedAt = null,
    ownerUserId = null,
    options = {}
  ) {
    let { settleIfUnchanged = true } = options;
    const {
      cloudRevision = null,
      writeRejected = false,
      cloudNote = null,
      requiresReconciliation = false,
      reconcilePending = false,
    } = options;
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) {
        return { success: true, outcome: "identity-changed", changes: 0 };
      }
      const expectedClientNoteId = snapshot?.client_note_id;
      if (!expectedClientNoteId || !cloudId) {
        return { success: false, outcome: "unresolved" };
      }

      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
        if (!current || current.client_note_id !== expectedClientNoteId) {
          // If the same identity exists under an unexpected numeric row, do
          // not mutate it and do not authorize deletion of its cloud result.
          const identityStillExists = this.db
            .prepare("SELECT 1 FROM notes WHERE client_note_id = ?")
            .get(expectedClientNoteId);
          return {
            success: true,
            outcome: identityStillExists ? "unresolved" : "orphaned",
          };
        }

        if (
          current.cloud_id &&
          !(reconcilePending && current.cloud_create_pending && current.cloud_id === cloudId)
        ) {
          // Concurrent creates should be idempotent and return the same id.
          // A different id is ambiguous, though, so never replace the adopted
          // identity or authorize destructive cleanup in that case.
          return {
            success: true,
            outcome: current.cloud_id === cloudId ? "already-linked" : "unresolved",
          };
        }

        if (reconcilePending && current.cloud_create_pending) {
          const pending = JSON.parse(current.cloud_create_pending);
          snapshot = pending.snapshot;
          settleIfUnchanged = pending.settleIfUnchanged;
          if (!cloudNote) return { success: true, outcome: "awaiting-cloud" };
          if (
            hasNoteRevision(pending.revision) &&
            hasNoteRevision(cloudRevision) &&
            cloudRevision < pending.revision
          )
            return { success: true, outcome: "awaiting-cloud" };
          if (
            !hasNoteRevision(pending.revision) &&
            pending.updatedAt &&
            Date.parse(cloudUpdatedAt) < Date.parse(pending.updatedAt)
          )
            return { success: true, outcome: "awaiting-cloud" };
          const sameReceipt = hasNoteRevision(pending.revision)
            ? cloudRevision === pending.revision
            : Boolean(
                pending.updatedAt && Date.parse(pending.updatedAt) === Date.parse(cloudUpdatedAt)
              );
          if (!sameReceipt) {
            // A pull can already contain another device's newer write. Only
            // an unchanged full create can take it without a conflict choice.
            if (
              !settleIfUnchanged ||
              hasPendingNoteClear(snapshot) ||
              !rowMatchesSnapshot(current, snapshot, NOTE_CREATE_ACK_FIELDS) ||
              options.localSpaceId === undefined
            )
              return { success: true, outcome: "conflict" };
            const note = this.upsertNoteFromCloud(
              {
                ...cloudNote,
                id: cloudId,
                client_note_id: expectedClientNoteId,
                updated_at: cloudUpdatedAt,
                revision: cloudRevision,
              },
              options.localFolderId ?? null,
              options.localSpaceId
            );
            return { success: true, outcome: "synced", note };
          }
        }
        const unchanged = rowMatchesSnapshot(current, snapshot, NOTE_CREATE_ACK_FIELDS);
        const leftTeam = this._leftTeamDuringPush(snapshot.space_id, current.space_id);

        // A metadata-only receipt proves identity, not which text survived
        // the upsert. Save its request and keep every push gated until a pull
        // reconciles that exact receipt (including after restart).
        if (requiresReconciliation) {
          this.db
            .prepare(
              `UPDATE notes SET cloud_id = ?, owner_user_id = ?,
              sync_status = CASE WHEN sync_status = 'synced' THEN 'pending' ELSE sync_status END,
              cloud_create_pending = ?,
              left_team = CASE WHEN ? = 1 THEN 1 ELSE left_team END
            WHERE id = ? AND client_note_id = ?`
            )
            .run(
              cloudId,
              ownerUserId,
              JSON.stringify({
                snapshot: {
                  ...snapshot,
                  sync_status: snapshot.sync_status === "synced" ? "pending" : snapshot.sync_status,
                },
                settleIfUnchanged,
                revision: cloudRevision,
                updatedAt: cloudUpdatedAt,
              }),
              leftTeam,
              id,
              expectedClientNoteId
            );
          return { success: true, outcome: "awaiting-cloud" };
        }

        // A create's submitted set may have been ignored by the server. Take
        // the returned copy only for bundles still equal to that submission,
        // and retire those sets even when another field was edited in flight.
        // POST never delivers a deliberate clear; it still owes a PATCH.
        if (cloudNote && !writeRejected) {
          const adopted = acknowledgedCreateTextUpdates(current, snapshot, cloudNote);
          const hasExplicitCreator = Object.prototype.hasOwnProperty.call(
            cloudNote,
            "created_by_user_id"
          );
          if (hasExplicitCreator || Object.prototype.hasOwnProperty.call(cloudNote, "user_id")) {
            adopted.created_by_user_id =
              (hasExplicitCreator ? cloudNote.created_by_user_id : cloudNote.user_id) ?? null;
          }
          noteUndo.preserveUnchangedUndo(this, id, Object.keys(adopted), () => {
            this._setNoteColumns(id, adopted);
          });
        }

        // A clear still follows as a revisioned PATCH. A team-to-Personal
        // move stays pending for its scope retraction, even with backup off.
        if (unchanged && settleIfUnchanged && !hasPendingNoteClear(snapshot) && !writeRejected) {
          this.db
            .prepare(
              `UPDATE notes
               SET sync_status = 'synced', cloud_id = ?, left_team = 0,
                   cloud_updated_at = ?, cloud_revision = ?,
                   owner_user_id = ?,
                   content_sync_operation = NULL, enhanced_content_sync_operation = NULL,
                   cloud_create_pending = NULL
               WHERE id = ? AND client_note_id = ?`
            )
            .run(
              cloudId,
              cloudUpdatedAt,
              hasNoteRevision(cloudRevision) ? cloudRevision : null,
              ownerUserId,
              id,
              expectedClientNoteId
            );
          return { success: true, outcome: "synced", ...(cloudNote && { note: this.getNote(id) }) };
        }

        this.db
          .prepare(
            `UPDATE notes
             SET cloud_id = ?,
                 cloud_updated_at = ?, cloud_revision = ?,
                 owner_user_id = ?,
                 sync_status = 'pending', cloud_create_rejected = ?, cloud_create_pending = NULL,
                 left_team = CASE WHEN ? = 1 THEN 1 ELSE left_team END
             WHERE id = ? AND client_note_id = ?`
          )
          .run(
            cloudId,
            cloudUpdatedAt,
            hasNoteRevision(cloudRevision) ? cloudRevision : null,
            ownerUserId,
            writeRejected ? 1 : 0,
            leftTeam,
            id,
            expectedClientNoteId
          );
        return { success: true, outcome: "pending", ...(cloudNote && { note: this.getNote(id) }) };
      })();
    } catch (error) {
      debugLogger.error("Error acknowledging note create", { error: error.message }, "database");
      throw error;
    }
  }

  // A PATCH response belongs to both the local client identity and the cloud
  // identity that issued it. Purge/revocation forks in place, so numeric id
  // alone is never sufficient. An exact pushed snapshot settles; newer work
  // on the same identity remains pending while advancing its server base.
  // cloudNote is the response row: a text field this device pushed without
  // an edit and has not touched since takes the server's copy (see
  // cloudTextUpdates), so the ack never pins a revision over text the server
  // no longer holds (a clear this device missed, or a blank it left out).
  markNoteSyncedIfUnchanged(
    id,
    snapshot,
    expectedCloudId,
    cloudUpdatedAt = null,
    ownerUserId = null,
    cloudRevision = null,
    cloudNote = null
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) {
        return { success: true, outcome: "identity-changed", changes: 0 };
      }
      if (!snapshot?.client_note_id || !expectedCloudId) {
        return { success: false, outcome: "identity-changed", changes: 0 };
      }

      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
        if (
          !current ||
          current.client_note_id !== snapshot.client_note_id ||
          current.cloud_id !== expectedCloudId
        ) {
          return { success: true, outcome: "identity-changed", changes: 0 };
        }

        if (current.cloud_create_rejected || current.cloud_create_pending)
          return { success: true, outcome: "pending", changes: 0 };
        // An older response arriving out of order must not regress the
        // revision. A response without one (an API that predates revisions)
        // drops it, so pushes fall back to the timestamp base.
        const incomingRevision = hasNoteRevision(cloudRevision) ? cloudRevision : null;
        if (
          incomingRevision !== null &&
          hasNoteRevision(current.cloud_revision) &&
          incomingRevision < current.cloud_revision
        ) {
          return { success: true, outcome: "pending", changes: 0 };
        }
        const unchanged = rowMatchesSnapshot(current, snapshot, NOTE_PATCH_ACK_FIELDS);
        const adopted = cloudNote
          ? cloudTextUpdates(
              current,
              cloudNote,
              NOTE_TEXT_FIELDS.filter(
                (field) =>
                  !current[`${field}_sync_operation`] &&
                  noteTextMatchesSnapshot(current, snapshot, field)
              )
            )
          : {};
        this._setNoteColumns(id, adopted);
        const note = Object.keys(adopted).length > 0 ? this.getNote(id) : undefined;
        const nextCloudUpdatedAt = (() => {
          if (!cloudUpdatedAt) return current.cloud_updated_at;
          if (!current.cloud_updated_at) return cloudUpdatedAt;
          const incomingMs = Date.parse(cloudUpdatedAt);
          const currentMs = Date.parse(current.cloud_updated_at);
          if (Number.isFinite(incomingMs) && Number.isFinite(currentMs)) {
            return incomingMs > currentMs ? cloudUpdatedAt : current.cloud_updated_at;
          }
          return cloudUpdatedAt > current.cloud_updated_at
            ? cloudUpdatedAt
            : current.cloud_updated_at;
        })();

        if (unchanged) {
          const result = this.db
            .prepare(
              `UPDATE notes
               SET sync_status = 'synced', left_team = 0, content_sync_operation = NULL, enhanced_content_sync_operation = NULL,
                   cloud_updated_at = ?, cloud_revision = ?,
                   owner_user_id = COALESCE(?, owner_user_id)
               WHERE id = ? AND client_note_id = ? AND cloud_id = ?`
            )
            .run(
              nextCloudUpdatedAt,
              incomingRevision,
              ownerUserId,
              id,
              snapshot.client_note_id,
              expectedCloudId
            );
          return { success: true, outcome: "synced", changes: result.changes, note };
        }

        // The delivered PATCH still advances this identity's base; otherwise
        // the next push would 409 against this device's own write. An older
        // response arriving out of order must not regress a newer base. Never
        // run this update for an identity/cloud mismatch.
        this.db
          .prepare(
            `UPDATE notes
             SET cloud_updated_at = ?, cloud_revision = ?,
                 owner_user_id = COALESCE(?, owner_user_id)
             WHERE id = ? AND client_note_id = ? AND cloud_id = ?`
          )
          .run(
            nextCloudUpdatedAt,
            incomingRevision,
            ownerUserId,
            id,
            snapshot.client_note_id,
            expectedCloudId
          );
        return { success: true, outcome: "pending", changes: 0, note };
      })();
    } catch (error) {
      debugLogger.error(
        "Error marking note synced if unchanged",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Copies the cloud owner onto a local row without touching updated_at or
  // sync_status: an unchanged note skips the last-write-wins upsert but must
  // still gain its owner (the owner_user_id backfill relies on this).
  setNoteOwnerFromCloud(id, ownerUserId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return { success: false };
      this.db.prepare("UPDATE notes SET owner_user_id = ? WHERE id = ?").run(ownerUserId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error setting note owner from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Live cloud-backed team notes whose owner is still unknown — the UI fails
  // closed on them, so a snapshot backfill runs while any remain.
  countTeamNotesMissingOwner() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("n");
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM notes n
             JOIN spaces s ON s.id = n.space_id
            WHERE s.kind = 'team' AND n.deleted_at IS NULL
              AND n.cloud_id IS NOT NULL AND n.owner_user_id IS NULL
              AND ${accountScope.sql}`
        )
        .get(...accountScope.params);
      return row?.count ?? 0;
    } catch (error) {
      debugLogger.error(
        "Error counting team notes missing owner",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Clean cloud-backed notes synced before the server kept revisions. Their
  // server rows may never re-enter a delta pull, so a snapshot pull applies
  // them while any remain. spaceKind narrows like getPendingNotes: a pull
  // leaves other private notes alone, so only 'syncable' ones count for it.
  countNotesMissingRevision(spaceKind = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("n");
      const kind = spaceKind === "syncable" ? "team" : spaceKind;
      const shared = spaceKind === "syncable" ? ` OR ${LEGACY_SHARED_PRIVATE_NOTE_SQL}` : "";
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM notes n
             JOIN spaces s ON s.id = n.space_id
            WHERE n.sync_status = 'synced' AND n.deleted_at IS NULL
              AND n.cloud_id IS NOT NULL AND n.cloud_revision IS NULL
              AND (? IS NULL OR s.kind = ?${shared})
              AND ${accountScope.sql}`
        )
        .get(kind, kind, ...accountScope.params);
      return row?.count ?? 0;
    } catch (error) {
      debugLogger.error(
        "Error counting notes missing a revision",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Records the server revision the user knowingly overwrites ("Keep editing"
  // on the conflict banner, keepLocal) or that a pull found equal to this
  // device's base. Deliberately leaves updated_at and sync_status alone — a
  // local edit stays pending and pushes with the advanced base. Keep merges
  // per field against the conflicting cloud copy: a field this device edited
  // (it has a sync operation) keeps the local value, and one it never edited
  // takes the cloud's, set or clear, so Keep never pushes a stale copy over
  // another device's edit.
  setNoteCloudBase(id, cloudUpdatedAt, cloudRevision = null, options = {}) {
    const { keepLocal = false, cloudNote = null } = options;
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        const current = this.getNote(id);
        if (!current) return { success: false };
        const revision = hasNoteRevision(cloudRevision) ? cloudRevision : null;
        if (
          hasNoteRevision(current.cloud_revision) &&
          revision !== null &&
          revision < current.cloud_revision
        )
          return { success: false };
        if (keepLocal && cloudNote) {
          // A deferred create may already have delivered (or had the server
          // discard) these sets. Keep preserves edits made after that POST,
          // not the unchanged submitted text a newer cloud copy cleared.
          const acknowledged = current.cloud_create_pending
            ? acknowledgedCreateTextUpdates(
                current,
                JSON.parse(current.cloud_create_pending).snapshot,
                cloudNote
              )
            : {};
          const merged = { ...current, ...acknowledged };
          const adopted = {
            ...acknowledged,
            ...cloudTextUpdates(
              merged,
              cloudNote,
              NOTE_TEXT_FIELDS.filter((field) => !merged[`${field}_sync_operation`])
            ),
          };
          noteUndo.preserveUnchangedUndo(this, id, Object.keys(adopted), () => {
            this._setNoteColumns(id, adopted);
          });
        }
        this.db
          .prepare(
            `UPDATE notes SET cloud_updated_at = ?, cloud_revision = ?,
               cloud_create_rejected = CASE WHEN ? THEN 0 ELSE cloud_create_rejected END,
               cloud_create_pending = CASE WHEN ? THEN NULL ELSE cloud_create_pending END
             WHERE id = ?`
          )
          .run(cloudUpdatedAt, revision, keepLocal ? 1 : 0, keepLocal ? 1 : 0, id);
        return { success: true, note: this.getNote(id) };
      })();
    } catch (error) {
      debugLogger.error("Error setting note cloud base", { error: error.message }, "database");
      throw error;
    }
  }

  // Runs once, when the sync operation columns are added. Unsynced text from
  // a build without them is the user's own edit, so it is marked as a set:
  // Keep then keeps it rather than taking the cloud's copy, and a
  // revision-aware push sends it. A blank stays unmarked, since a released
  // build's blank is no deliberate clear. A database that predates sync
  // status has never synced any of its notes.
  _markUnsyncedNoteTextAsSet() {
    const hasSyncStatus = this.db
      .prepare("PRAGMA table_info(notes)")
      .all()
      .some((column) => column.name === "sync_status");
    const rows = this.db
      .prepare(
        `SELECT id, content, enhanced_content FROM notes
         ${hasSyncStatus ? "WHERE sync_status IS NOT 'synced'" : ""}`
      )
      .all();
    const mark = this.db.prepare(
      `UPDATE notes SET content_sync_operation = ?, enhanced_content_sync_operation = ?
       WHERE id = ?`
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const content = typedTextOperation(row.content);
        const summary = typedTextOperation(row.enhanced_content);
        if (content || summary) mark.run(content, summary, row.id);
      }
    })();
  }

  // Runs once, when the create attempt columns are added. Earlier versions
  // only marked a deleted note or chat as deleted, so one that never synced
  // stayed on the device. This removes those rows with their speaker rows and
  // messages. Rows a pending folder delete holds stay, so a refused folder
  // delete can still restore them, and so do live chats about a removed note.
  _removeNeverSyncedTombstones() {
    const neverSynced = `deleted_at IS NOT NULL AND cloud_id IS NULL AND cloud_create_attempted = 0
      AND id NOT IN (SELECT entity_id FROM optimistic_folder_delete_rows WHERE entity_type = ?)`;
    const notes = `SELECT id FROM notes WHERE ${neverSynced}`;
    this.db.transaction(() => {
      this._deleteSpeakerRowsForNotes(notes, "note");
      this.db.prepare(`DELETE FROM notes WHERE id IN (${notes})`).run("note");
      this._hardDeleteConversationsWhere(neverSynced, ["conversation"]);
    })();
  }

  // Writes sync-owned columns (from cloudTextUpdates) without touching
  // updated_at or sync_status. Keys come from that fixed set, never input.
  _setNoteColumns(id, columns) {
    const keys = Object.keys(columns);
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE notes SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .run(...Object.values(columns), id);
  }

  markNoteSyncError(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return { success: false };
      this.db.prepare("UPDATE notes SET sync_status = 'error' WHERE id = ?").run(id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking note sync error", { error: error.message }, "database");
      throw error;
    }
  }

  // A denied optimistic delete leaves the server row untouched. Revive the
  // local tombstone in place so its numeric id, chats and speaker rows survive;
  // the deliberately old timestamp lets the mandatory snapshot pull replace
  // it with the authoritative cloud row.
  restoreNoteAfterDeniedDelete(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("notes");
      const result = this.db
        .prepare(
          `UPDATE notes
           SET deleted_at = NULL, sync_status = 'synced',
               updated_at = '1970-01-01 00:00:00'
           WHERE id = ? AND deleted_at IS NOT NULL AND ${accountScope.sql}`
        )
        .run(id, ...accountScope.params);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error(
        "Error restoring note after denied delete",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Confirmed cloud deletes and access revocation retire note chats; denied
  // deletes use the restore method above instead.
  hardDeleteNote(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return { success: false, id, error: "Note not found" };
      const result = this.db.transaction(() => {
        this._retireConversationsWhere("note_id = ?", [id], {
          scrubSyncedMessages: true,
        });
        this._deleteSpeakerRowsForNotes("SELECT id FROM notes WHERE id = ?", id);
        return this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      })();
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error hard deleting note", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingFolders(spaceKind = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("f");
      if (spaceKind != null) {
        // The queue a sync pass reads is 'team': private folders never reach
        // the cloud (D2). It also returns cloud-backed rows that just LEFT a
        // team (D6), which SyncService detaches since they sit in Private.
        const leftTeam =
          spaceKind === "team" ? " OR (f.left_team = 1 AND f.cloud_id IS NOT NULL)" : "";
        return this.db
          .prepare(
            `SELECT f.* FROM folders f JOIN spaces s ON s.id = f.space_id
             WHERE f.sync_status = 'pending' AND f.deleted_at IS NULL
               AND ${accountScope.sql} AND (s.kind = ?${leftTeam})
             ORDER BY f.space_id, f.name`
          )
          .all(...accountScope.params, spaceKind);
      }
      return this.db
        .prepare(
          `SELECT f.* FROM folders f
           WHERE f.sync_status = 'pending' AND f.deleted_at IS NULL
             AND ${accountScope.sql}
           ORDER BY f.space_id, f.name`
        )
        .all(...accountScope.params);
    } catch (error) {
      debugLogger.error("Error getting pending folders", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingFolderDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._folderScopeCondition("f", { pendingDelete: true });
      return this.db
        .prepare(
          `SELECT * FROM folders f
           WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL
             AND ${accountScope.sql}
             AND (sync_status = 'pending' OR EXISTS (
               SELECT 1 FROM optimistic_folder_delete_rows r
               WHERE r.folder_id = f.id AND r.entity_type = 'folder'
             ))`
        )
        .all(...accountScope.params);
    } catch (error) {
      debugLogger.error(
        "Error getting pending folder deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // A folder DELETE permission denial means the server changed nothing.
  // Restore only rows hidden by that exact optimistic operation; independent
  // note/conversation tombstones were never journaled and remain deleted.
  restoreFolderAfterDeniedDelete(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this._getFolderInAccountScope(id, { pendingDelete: true })) {
        return { success: false, id, error: "Folder not found" };
      }
      return this.db.transaction(() => {
        const journalRows = this.db
          .prepare(
            `SELECT * FROM optimistic_folder_delete_rows
             WHERE folder_id = ?
             ORDER BY CASE entity_type
               WHEN 'folder' THEN 0 WHEN 'note' THEN 1 ELSE 2 END, entity_id`
          )
          .all(id);
        const folderState = journalRows.find((row) => row.entity_type === "folder");
        if (!folderState) {
          return { success: false, id, error: "Folder delete rollback not found" };
        }

        const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
        if (!folder) {
          return { success: false, id, error: "Folder row is missing" };
        }
        const collision = this.db
          .prepare(
            "SELECT id FROM folders WHERE name = ? AND space_id = ? AND deleted_at IS NULL AND id != ?"
          )
          .get(folder.name, folder.space_id, id);
        if (collision) {
          return {
            success: false,
            id,
            reason: "name-taken",
            error: "Folder name is no longer available",
          };
        }

        const noteStates = journalRows.filter((row) => row.entity_type === "note");
        const conversationStates = journalRows.filter((row) => row.entity_type === "conversation");
        const noteExists = this.db.prepare("SELECT 1 FROM notes WHERE id = ?");
        const conversationExists = this.db.prepare(
          "SELECT 1 FROM agent_conversations WHERE id = ?"
        );
        if (noteStates.some((row) => !noteExists.get(row.entity_id))) {
          return { success: false, id, error: "A folder note row is missing" };
        }
        if (conversationStates.some((row) => !conversationExists.get(row.entity_id))) {
          return { success: false, id, error: "A folder conversation row is missing" };
        }

        this.db
          .prepare(
            `UPDATE folders
             SET deleted_at = ?, sync_status = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            folderState.original_deleted_at,
            folderState.original_sync_status,
            folderState.original_updated_at,
            id
          );
        const restoreNote = this.db.prepare(
          `UPDATE notes
           SET deleted_at = ?, sync_status = ?, updated_at = ?
           WHERE id = ?`
        );
        for (const state of noteStates) {
          restoreNote.run(
            state.original_deleted_at,
            state.original_sync_status,
            state.original_updated_at,
            state.entity_id
          );
        }
        const restoreConversation = this.db.prepare(
          `UPDATE agent_conversations
           SET deleted_at = ?, sync_status = ?, updated_at = ?
           WHERE id = ?`
        );
        for (const state of conversationStates) {
          restoreConversation.run(
            state.original_deleted_at,
            state.original_sync_status,
            state.original_updated_at,
            state.entity_id
          );
        }

        this.db.prepare("DELETE FROM optimistic_folder_delete_rows WHERE folder_id = ?").run(id);
        const getNote = this.db.prepare("SELECT * FROM notes WHERE id = ?");
        return {
          success: true,
          id,
          folder: this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id),
          notes: noteStates.map((state) => getNote.get(state.entity_id)),
          conversationIds: conversationStates.map((state) => state.entity_id),
        };
      })();
    } catch (error) {
      debugLogger.error(
        "Error restoring folder after denied delete",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getFolderInAccountScope(id, { pendingDelete: true });
      if (!folder) return { success: false, id, error: "Folder not found" };
      const childNotes = "SELECT id FROM notes WHERE folder_id = ?";
      const heldNotes =
        "SELECT entity_id FROM optimistic_folder_delete_rows WHERE folder_id = ? AND entity_type = 'note'";
      const heldConversations =
        "SELECT entity_id FROM optimistic_folder_delete_rows WHERE folder_id = ? AND entity_type = 'conversation'";
      const accountScope = this._accountScopeCondition("notes");
      const noteIds = this.db
        .prepare(`${childNotes} AND ${accountScope.sql}`)
        .all(id, ...accountScope.params)
        .map((row) => row.id);
      let relocatedNotes = [];
      const result = this.db.transaction(() => {
        relocatedNotes = this._releaseOutOfScopeChildNotes(id);
        // Note chats normally have note_id only. Retire them while the child
        // rows still identify which chats belong to this folder cleanup, then
        // handle independently folder-scoped conversations.
        this._retireConversationsWhere(`note_id IN (${childNotes})`, [id], {
          scrubSyncedMessages: true,
        });
        // The journal is the authoritative ownership record for the
        // optimistic operation. Use it as well as current parent columns so a
        // late stale write cannot strand a held row by changing its scope.
        this.db
          .prepare(
            `DELETE FROM agent_messages
             WHERE conversation_id IN (${heldConversations})`
          )
          .run(id);
        this.db
          .prepare(
            `DELETE FROM agent_conversations
             WHERE cloud_id IS NULL AND id IN (${heldConversations})`
          )
          .run(id);
        this.db
          .prepare(
            `UPDATE agent_conversations
             SET deleted_at = COALESCE(deleted_at, datetime('now')),
                 sync_status = 'pending', updated_at = datetime('now')
             WHERE cloud_id IS NOT NULL AND id IN (${heldConversations})`
          )
          .run(id);
        this._deleteSpeakerRowsForNotes(childNotes, id);
        this._deleteSpeakerRowsForNotes(heldNotes, id);
        this.db.prepare(`DELETE FROM notes WHERE id IN (${heldNotes})`).run(id);
        this.db.prepare(`DELETE FROM notes WHERE id IN (${childNotes})`).run(id);
        this._retireConversationsWhere("folder_id = ?", [id], {
          scrubSyncedMessages: true,
        });
        // Held cloud chats now become ordinary pending cloud deletes. Rows
        // tombstoned before the folder action were never journaled and keep
        // their existing pending state.
        const deleted = this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM optimistic_folder_delete_rows WHERE folder_id = ?").run(id);
        return deleted;
      })();
      return {
        success: result.changes > 0,
        id,
        noteIds,
        relocatedNotes,
        name: folder?.name ?? null,
      };
    } catch (error) {
      debugLogger.error("Error hard deleting folder", { error: error.message }, "database");
      throw error;
    }
  }

  // The folder's server row moved into a team this user can't access
  // (access_removed stub or a team_access_revoked push rejection). Clean
  // server-owned child notes are no longer ours to keep — the server retains
  // them; dirty or never-synced children are the only surviving content
  // (plan §7.2): they relocate to the private space with forked identities,
  // where they stay on this device as every private row does (D2). The folder
  // row itself survives in the private space only when it carries unpushed
  // changes (preserveFolder), renamed "name (2)" on a collision; otherwise it
  // is deleted. What survives belongs to the private space's account, and only
  // one of the active account's own private spaces takes it.
  relocateRevokedFolder(id, privateSpaceId, preserveFolder = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this._getFolderInAccountScope(id)) {
        return { success: false, error: "Folder not found" };
      }
      if (this.getSpace(privateSpaceId)?.kind !== "private") {
        return { success: false, error: "Space not found" };
      }
      const accountId = this._accountIdForSpace(privateSpaceId);
      // If access revocation overtakes an optimistic delete, first recover the
      // held rows so the normal dirty-note preservation rules can classify
      // them from their real pre-delete state.
      const held = this.db
        .prepare(
          "SELECT 1 FROM optimistic_folder_delete_rows WHERE folder_id = ? AND entity_type = 'folder'"
        )
        .get(id);
      if (held) {
        const rollback = this.restoreFolderAfterDeniedDelete(id);
        if (!rollback.success) return rollback;
      }

      const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      const serverOwnedChildren =
        "SELECT id FROM notes WHERE folder_id = ? AND (deleted_at IS NOT NULL OR (sync_status = 'synced' AND cloud_id IS NOT NULL))";
      const result = this.db.transaction(() => {
        const preservedIds = this.db
          .prepare(
            "SELECT id FROM notes WHERE folder_id = ? AND deleted_at IS NULL AND (sync_status != 'synced' OR cloud_id IS NULL)"
          )
          .all(id)
          .map((row) => row.id);
        const deletedNoteIds = this.db
          .prepare(serverOwnedChildren)
          .all(id)
          .map((row) => row.id);
        // Note chats have no folder_id, so retire them before deleting the
        // server-owned notes that prove they belonged to this revoked folder.
        this._retireConversationsWhere(`note_id IN (${serverOwnedChildren})`, [id], {
          scrubSyncedMessages: true,
        });
        this._deleteSpeakerRowsForNotes(serverOwnedChildren, id);
        this.db.prepare(`DELETE FROM notes WHERE id IN (${serverOwnedChildren})`).run(id);
        const relocateNote = this.db.prepare(
          "UPDATE notes SET space_id = ?, folder_id = ?, account_id = ?, client_note_id = ?, cloud_id = NULL, cloud_updated_at = NULL, cloud_revision = NULL, cloud_create_rejected = 0, cloud_create_pending = NULL, cloud_create_attempted = 0, owner_user_id = NULL, updated_by_user_id = NULL, sync_status = 'pending', left_team = 0, is_shared = 0, share_token = NULL, updated_at = datetime('now') WHERE id = ?"
        );
        const detachNoteConversation = this.db.prepare(
          "UPDATE agent_conversations SET space_id = NULL, folder_id = NULL WHERE note_id = ?"
        );
        for (const noteId of preservedIds) {
          relocateNote.run(
            privateSpaceId,
            preserveFolder ? id : null,
            accountId,
            randomUUID(),
            noteId
          );
          // Note-scoped chats follow a preserved dirty note, not the revoked
          // team container. Folder-only chats are handled separately below.
          detachNoteConversation.run(noteId);
        }
        let preservedFolder = null;
        if (preserveFolder) {
          const name = this._uniqueFolderName(privateSpaceId, accountId, folder.name, id);
          this.db
            .prepare(
              "UPDATE folders SET space_id = ?, name = ?, account_id = ?, client_folder_id = ?, cloud_id = NULL, sync_status = 'pending', left_team = 0, updated_at = datetime('now') WHERE id = ?"
            )
            .run(privateSpaceId, name, accountId, randomUUID(), id);
          preservedFolder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
          // Folder-scoped chats follow the preserved folder into the private
          // space so their space ref doesn't dangle on the revoked space.
          this.db
            .prepare("UPDATE agent_conversations SET space_id = ? WHERE folder_id = ?")
            .run(privateSpaceId, id);
        } else {
          this._retireConversationsWhere("folder_id = ?", [id], {
            scrubSyncedMessages: true,
          });
          this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
        }
        const getNote = this.db.prepare("SELECT * FROM notes WHERE id = ?");
        return {
          folder: preservedFolder,
          relocatedNotes: preservedIds.map((noteId) => getNote.get(noteId)),
          deletedNoteIds,
        };
      })();
      return { success: true, folderName: folder.name, ...result };
    } catch (error) {
      debugLogger.error("Error relocating revoked folder", { error: error.message }, "database");
      throw error;
    }
  }

  getFolderByClientId(clientFolderId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("folders");
      return (
        this.db
          .prepare(`SELECT * FROM folders WHERE client_folder_id = ? AND ${accountScope.sql}`)
          .get(clientFolderId, ...accountScope.params) || null
      );
    } catch (error) {
      debugLogger.error("Error getting folder by client id", { error: error.message }, "database");
      throw error;
    }
  }

  // A folder the import stored under a key of its own (D28) is found by its
  // cloud id, which the key lookup misses.
  getFolderByCloudId(cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("folders");
      return (
        this.db
          .prepare(
            `SELECT * FROM folders WHERE cloud_id = ? AND ${accountScope.sql}
             ORDER BY deleted_at IS NOT NULL, id LIMIT 1`
          )
          .get(cloudId, ...accountScope.params) || null
      );
    } catch (error) {
      debugLogger.error("Error getting folder by cloud id", { error: error.message }, "database");
      throw error;
    }
  }

  // newKeyIfTaken (the import of cloud private notes, D28): a cloud folder
  // whose client key another account's folder holds here is stored under a
  // key of its own, where the upsert would otherwise take that folder over.
  upsertFolderFromCloud(cloudFolder, localSpaceId = null, { newKeyIfTaken = false } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // A cloud row with no space is a personal folder: the default's Private.
      let spaceId = localSpaceId ?? this.getDefaultPrivateSpaceId();
      const current = this.db
        .prepare("SELECT space_id, account_id FROM folders WHERE client_folder_id = ?")
        .get(cloudFolder.client_folder_id);
      if (this._keepsPrivatePlacement(current?.space_id, spaceId)) spaceId = current.space_id;
      const accountId = this._accountIdForSpace(spaceId);
      if (newKeyIfTaken && current?.account_id && accountId && current.account_id !== accountId) {
        // That folder is left as it is. This account's own copy of the cloud
        // folder keeps its key; otherwise the folder gets a new one.
        const accountScope = this._accountScopeCondition("folders");
        const own = this.db
          .prepare(
            `SELECT client_folder_id FROM folders WHERE cloud_id = ? AND ${accountScope.sql}`
          )
          .get(cloudFolder.id, ...accountScope.params);
        return this.upsertFolderFromCloud(
          { ...cloudFolder, client_folder_id: own?.client_folder_id ?? randomUUID() },
          localSpaceId
        );
      }
      const updatedAt = cloudFolder.updated_at || cloudFolder.created_at;
      const stmt = this.db.prepare(`
        INSERT INTO folders (client_folder_id, cloud_id, name, is_default, sort_order, space_id, account_id, sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)
        ON CONFLICT(client_folder_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          name = excluded.name,
          sort_order = excluded.sort_order,
          space_id = excluded.space_id,
          account_id = excluded.account_id,
          sync_status = 'synced',
          left_team = 0,
          updated_at = excluded.updated_at
      `);
      try {
        stmt.run(
          cloudFolder.client_folder_id,
          cloudFolder.id,
          cloudFolder.name,
          cloudFolder.is_default ? 1 : 0,
          cloudFolder.sort_order || 0,
          spaceId,
          accountId,
          cloudFolder.created_at,
          updatedAt
        );
      } catch (err) {
        // A live same-named folder of the same owner already exists in this
        // space (the partial unique name indexes are a different conflict
        // target than the client_folder_id upsert). Converge on the existing
        // folder by adopting the cloud row's identity instead of wedging the
        // pull.
        // Match the error code, not the message text (which SQLite could
        // reformat); the column check keeps client_folder_id collisions on
        // the rethrow path.
        if (err.code !== "SQLITE_CONSTRAINT_UNIQUE" || !err.message.includes("folders.space_id")) {
          throw err;
        }
        const existing = this.db
          .prepare(
            "SELECT id FROM folders WHERE space_id = ? AND name = ? AND account_id IS ? AND deleted_at IS NULL"
          )
          .get(spaceId, cloudFolder.name, accountId);
        if (!existing) throw err;
        this.db.transaction(() => {
          const holder = this.db
            .prepare("SELECT id FROM folders WHERE client_folder_id = ? AND id != ?")
            .get(cloudFolder.client_folder_id, existing.id);
          // A different local row already tracked this cloud folder (rename
          // collision via the DO UPDATE branch) — fork it so the winner can
          // take the cloud identity without violating the client id index.
          if (holder) this.forkFolderIdentity(holder.id);
          this.db
            .prepare(
              "UPDATE folders SET client_folder_id = ?, cloud_id = ?, sort_order = ?, sync_status = 'synced', left_team = 0, updated_at = ? WHERE id = ?"
            )
            .run(
              cloudFolder.client_folder_id,
              cloudFolder.id,
              cloudFolder.sort_order || 0,
              updatedAt,
              existing.id
            );
        })();
      }
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE client_folder_id = ?")
        .get(cloudFolder.client_folder_id);
      // A move made on another device arrives as a new space_id; the folder's
      // chats follow it, as they do in moveFolderToSpace.
      if (folder) {
        this.db
          .prepare(
            "UPDATE agent_conversations SET space_id = ? WHERE folder_id = ? AND space_id IS NOT ?"
          )
          .run(folder.space_id, folder.id, folder.space_id);
      }
      return folder;
    } catch (error) {
      debugLogger.error("Error upserting folder from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markFolderSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this._getFolderInAccountScope(id)) return { success: false };
      this.db
        .prepare(
          "UPDATE folders SET sync_status = 'synced', cloud_id = ?, left_team = 0 WHERE id = ?"
        )
        .run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking folder synced", { error: error.message }, "database");
      throw error;
    }
  }

  // A folder create or pull-side name adoption may return a canonical client
  // identity different from the local one. Adopt it only while both identities
  // captured before the request still occupy this numeric row. A newer rename
  // or move adopts the cloud identity but remains pending for its follow-up
  // PATCH; an in-place revocation fork is never touched.
  acknowledgeFolderCreate(
    id,
    snapshot,
    expectedCloudId,
    responseClientFolderId,
    cloudId,
    cloudUpdatedAt = null
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this._getFolderInAccountScope(id)) {
        return { success: true, outcome: "identity-changed", changes: 0 };
      }
      if (
        !snapshot?.client_folder_id ||
        (expectedCloudId !== null && typeof expectedCloudId !== "string") ||
        !responseClientFolderId ||
        !cloudId
      ) {
        return { success: false, outcome: "unresolved", changes: 0 };
      }

      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
        if (
          !current ||
          current.client_folder_id !== snapshot.client_folder_id ||
          current.cloud_id !== expectedCloudId
        ) {
          return { success: true, outcome: "identity-changed", changes: 0 };
        }
        if (expectedCloudId !== null && expectedCloudId !== cloudId) {
          return { success: true, outcome: "unresolved", changes: 0 };
        }
        const responseIdentityHolder = this.db
          .prepare("SELECT id FROM folders WHERE client_folder_id = ? AND id != ?")
          .get(responseClientFolderId, id);
        if (responseIdentityHolder) {
          return { success: true, outcome: "unresolved", changes: 0 };
        }

        const unchanged = rowMatchesSnapshot(current, snapshot, FOLDER_ACK_FIELDS);
        const leftTeam = this._leftTeamDuringPush(snapshot.space_id, current.space_id);

        if (unchanged) {
          const result = this.db
            .prepare(
              `UPDATE folders
               SET client_folder_id = ?, cloud_id = ?, sync_status = 'synced',
                   left_team = 0, updated_at = COALESCE(?, updated_at)
               WHERE id = ? AND client_folder_id = ? AND cloud_id IS ?`
            )
            .run(
              responseClientFolderId,
              cloudId,
              cloudUpdatedAt,
              id,
              snapshot.client_folder_id,
              expectedCloudId
            );
          return { success: true, outcome: "synced", changes: result.changes };
        }

        const result = this.db
          .prepare(
            `UPDATE folders
             SET client_folder_id = ?, cloud_id = ?, sync_status = 'pending',
                 left_team = CASE WHEN ? = 1 THEN 1 ELSE left_team END
             WHERE id = ? AND client_folder_id = ? AND cloud_id IS ?`
          )
          .run(
            responseClientFolderId,
            cloudId,
            leftTeam,
            id,
            snapshot.client_folder_id,
            expectedCloudId
          );
        return { success: true, outcome: "pending", changes: result.changes };
      })();
    } catch (error) {
      debugLogger.error("Error acknowledging folder create", { error: error.message }, "database");
      throw error;
    }
  }

  // Folder PATCH twin of the guarded note acknowledgement. Bind the response
  // to both client and cloud identity and compare every pushed field so a
  // same-second rename or an in-place revocation fork cannot be settled.
  markFolderSyncedIfUnchanged(id, snapshot, expectedCloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this._getFolderInAccountScope(id)) {
        return { success: true, outcome: "identity-changed", changes: 0 };
      }
      if (!snapshot?.client_folder_id || !expectedCloudId) {
        return { success: false, outcome: "identity-changed", changes: 0 };
      }
      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
        if (
          !current ||
          current.client_folder_id !== snapshot.client_folder_id ||
          current.cloud_id !== expectedCloudId
        ) {
          return { success: true, outcome: "identity-changed", changes: 0 };
        }
        const unchanged = rowMatchesSnapshot(current, snapshot, FOLDER_ACK_FIELDS);
        if (!unchanged) {
          return { success: true, outcome: "pending", changes: 0 };
        }
        const result = this.db
          .prepare(
            `UPDATE folders
             SET sync_status = 'synced', left_team = 0
             WHERE id = ? AND client_folder_id = ? AND cloud_id = ?`
          )
          .run(id, snapshot.client_folder_id, expectedCloudId);
        return { success: true, outcome: "synced", changes: result.changes };
      })();
    } catch (error) {
      debugLogger.error(
        "Error marking folder synced if unchanged",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // A folder cut loose from a cloud row it may no longer write (a private
  // folder that left a team) gets a fresh identity and no cloud link, so
  // nothing ever PATCHes that row again. It stays pending and local: private
  // folders never upload (D2).
  forkFolderIdentity(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this._getFolderInAccountScope(id)) return { success: false };
      const result = this.db
        .prepare(
          "UPDATE folders SET client_folder_id = ?, cloud_id = NULL, sync_status = 'pending', left_team = 0 WHERE id = ?"
        )
        .run(randomUUID(), id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error forking folder identity", { error: error.message }, "database");
      throw error;
    }
  }

  getFolderIdMap() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("folders");
      return this.db
        .prepare(`SELECT * FROM folders WHERE deleted_at IS NULL AND ${accountScope.sql}`)
        .all(...accountScope.params);
    } catch (error) {
      debugLogger.error("Error getting folder id map", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingConversations() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // The cloud conversation contract has no space/folder scope yet.
      // Keep container chats local so another device cannot pull them as
      // global chats. Cloud-backed tombstones still use the delete queue.
      // Another account's pending chats wait for that account: pushing them
      // now would upload them with this account's token.
      // A note's chat goes only where its note does: a chat on a private note
      // stays on the device (D11), even when that note is a legacy shared one,
      // since guests never see the owner's chats. Root chats still sync. The
      // note's teamspace must be one the account is in, as getSpaces lists
      // them (SyncService's isTeamRow); any other note's chat stays too.
      const scope = this._syncRowScope("agent_conversations");
      return this.db
        .prepare(
          `SELECT * FROM agent_conversations
           WHERE sync_status = 'pending' AND deleted_at IS NULL
             AND space_id IS NULL AND folder_id IS NULL
             AND (note_id IS NULL OR EXISTS (
               SELECT 1 FROM notes chat_note
               JOIN spaces chat_note_space ON chat_note_space.id = chat_note.space_id
               JOIN space_accounts chat_note_member
                 ON chat_note_member.space_id = chat_note_space.id
               WHERE chat_note.id = agent_conversations.note_id
                 AND chat_note_space.kind = 'team'
                 AND chat_note_space.deleted_at IS NULL
                 AND chat_note_member.account_id = ?
             ))
             AND ${scope.sql}`
        )
        .all(this.activeAccountId, ...scope.params);
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
      const scope = this._syncRowScope("agent_conversations", "c");
      return this.db
        .prepare(
          `SELECT * FROM agent_conversations c
           WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL
             AND sync_status = 'pending'
             AND ${scope.sql}
             AND NOT EXISTS (
               SELECT 1 FROM optimistic_folder_delete_rows r
               WHERE r.entity_type = 'conversation' AND r.entity_id = c.id
             )`
        )
        .all(...scope.params);
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
      const scope = this._syncRowScope("agent_conversations", "c");
      return (
        this.db
          .prepare(
            `SELECT c.*,
               EXISTS (
                 SELECT 1 FROM optimistic_folder_delete_rows r
                 WHERE r.entity_type = 'conversation' AND r.entity_id = c.id
               ) AS folder_delete_pending,
               (SELECT COUNT(*) FROM agent_messages m WHERE m.conversation_id = c.id) AS message_count
             FROM agent_conversations c
             WHERE c.client_conversation_id = ? AND ${scope.sql}`
          )
          .get(clientId, ...scope.params) || null
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

  // The local row a cloud chat lands on, whoever owns it. Matched by cloud id as
  // a fallback for legacy rows without a client_conversation_id.
  _conversationForCloudRow(cloudConv) {
    let existing = null;
    if (cloudConv.client_conversation_id != null) {
      existing = this.db
        .prepare("SELECT * FROM agent_conversations WHERE client_conversation_id = ?")
        .get(cloudConv.client_conversation_id);
    }
    if (!existing && cloudConv.id != null) {
      existing = this.db
        .prepare("SELECT * FROM agent_conversations WHERE cloud_id = ?")
        .get(cloudConv.id);
    }
    return existing ?? null;
  }

  // The account's own cloud returning a chat proves whose it is.
  _claimConversationFromCloud(existing) {
    if (!existing || existing.account_id || !this.activeAccountId) return existing;
    const claim = this._claimUnattributedSql("agent_conversations", { proven: true });
    this.db
      .prepare(`UPDATE agent_conversations SET ${claim.sql} WHERE id = ?`)
      .run(...claim.params, existing.id);
    return this.db.prepare("SELECT * FROM agent_conversations WHERE id = ?").get(existing.id);
  }

  // Claims an unattributed chat the pull matched and leaves everything else as
  // it is: its messages may be newer than the cloud's, or its delete unsent.
  claimConversationFromCloud(cloudConv) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        const existing = this._conversationForCloudRow(cloudConv);
        // IPC returns the row to the renderer, so a skipped one stays private.
        if (this._ownedByOtherAccount(existing)) return null;
        return this._claimConversationFromCloud(existing);
      })();
    } catch (error) {
      debugLogger.error(
        "Error claiming conversation from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertConversationFromCloud(cloudConv, messages, snapshot) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        let existing = this._conversationForCloudRow(cloudConv);
        // IPC returns the row to the renderer, so a skipped one stays private.
        if (this._ownedByOtherAccount(existing)) {
          debugLogger.warn(
            "Skipping cloud conversation that belongs to another local account",
            {},
            "database"
          );
          return null;
        }
        existing = this._claimConversationFromCloud(existing);
        // A local tombstone represents an unacknowledged delete. A newer live
        // cloud revision must not cancel that intent or restore message bodies
        // while the delete retries.
        if (existing?.deleted_at) return existing;

        // The renderer's lookup can go stale while this IPC waits behind a local
        // save. Check the same snapshot inside the transaction that replaces messages.
        const current = existing ? this._conversationWithMessageCount(existing.id) : null;
        if (
          snapshot === null
            ? current !== null
            : !current ||
              !rowMatchesSnapshot(current, snapshot, [
                "id",
                "client_conversation_id",
                "cloud_id",
                "sync_status",
              ]) ||
              !this._conversationMatchesSnapshot(current, snapshot)
        ) {
          return existing;
        }

        // A fork's origin never changes, so a cloud copy without it (from an
        // API or app that predates it) keeps the one this device has. The copied
        // count follows the messages written here, when the copy carries one.
        const convStmt = this.db.prepare(`
          INSERT INTO agent_conversations (client_conversation_id, cloud_id, title, note_id, sync_status, created_at, updated_at,
            account_id, parent_client_conversation_id, fork_message_count, fork_context)
          VALUES (?, ?, ?, ?, 'synced', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(client_conversation_id) DO UPDATE SET
            account_id = COALESCE(excluded.account_id, account_id),
            cloud_id = excluded.cloud_id,
            title = excluded.title,
            -- The cloud has no note column, so its copy never says which note a chat came from.
            note_id = COALESCE(excluded.note_id, agent_conversations.note_id),
            sync_status = 'synced',
            updated_at = excluded.updated_at,
            parent_client_conversation_id = COALESCE(parent_client_conversation_id, excluded.parent_client_conversation_id),
            fork_message_count = COALESCE(excluded.fork_message_count, fork_message_count),
            fork_context = COALESCE(fork_context, excluded.fork_context)
        `);
        // The origin as the cloud has it, made sane: a chat isn't its own
        // parent, and a fork copied at least one of its messages and no more
        // than it has (a larger count would hide every message it shows).
        const parentClientId =
          cloudConv.parent_client_conversation_id &&
          cloudConv.parent_client_conversation_id !== cloudConv.client_conversation_id
            ? cloudConv.parent_client_conversation_id
            : null;
        // A database driver may send an integer column as a string.
        const copied = Number(cloudConv.fork_message_count);
        const forkMessageCount =
          parentClientId && Number.isInteger(copied) && copied > 0
            ? Math.min(copied, messages?.length || copied)
            : null;
        convStmt.run(
          cloudConv.client_conversation_id ?? null,
          cloudConv.id ?? null,
          cloudConv.title ?? "Untitled",
          cloudConv.note_id ?? null,
          cloudConv.created_at ?? new Date().toISOString(),
          cloudConv.updated_at ?? new Date().toISOString(),
          this.activeAccountId,
          parentClientId,
          forkMessageCount,
          parentClientId ? (cloudConv.fork_context ?? null) : null
        );
        const conv = this.db
          .prepare("SELECT * FROM agent_conversations WHERE client_conversation_id = ?")
          .get(cloudConv.client_conversation_id);
        // Link this fork to its parent, or the forks waiting on this chat to it,
        // whichever arrived first. A parent deleted or never synced here leaves
        // the fork a plain chat, and so does a parent that is itself its fork.
        // Only among chats this account can see: a client id another account's
        // row holds is not this fork's parent.
        const parentScope = this._syncRowScope("agent_conversations", "parent");
        const forkScope = this._syncRowScope("agent_conversations");
        this.db
          .prepare(
            `UPDATE agent_conversations
             SET parent_conversation_id = (
               SELECT parent.id FROM agent_conversations parent
               WHERE parent.client_conversation_id = agent_conversations.parent_client_conversation_id
                 AND parent.deleted_at IS NULL
                 AND parent.parent_conversation_id IS NOT agent_conversations.id
                 AND ${parentScope.sql})
             WHERE parent_conversation_id IS NULL
               AND (id = ? OR parent_client_conversation_id = ?)
               AND ${forkScope.sql}`
          )
          .run(...parentScope.params, conv.id, conv.client_conversation_id, ...forkScope.params);
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

  _conversationWithMessageCount(id) {
    return this.db
      .prepare(
        `SELECT c.*, COUNT(m.id) AS message_count
         FROM agent_conversations c
         LEFT JOIN agent_messages m ON m.conversation_id = c.id
         WHERE c.id = ?
         GROUP BY c.id`
      )
      .get(id);
  }

  _conversationMatchesSnapshot(current, snapshot) {
    return (
      current.title === snapshot.title &&
      current.updated_at === snapshot.updated_at &&
      Number(current.message_count) === snapshot.message_count
    );
  }

  // With a snapshot, only a chat still matching what was sent to the cloud
  // settles; a later edit leaves it pending for the next pass.
  // Takes the copy's own time, so the pull doesn't take the copy this pass wrote
  // for a newer one: its text can be older than this device's (a regenerated reply).
  // A chat push is acknowledged for the account that sent it (`accountId`),
  // even when another account became active while the request was in flight:
  // the cloud copy is that account's, so the row is linked and claimed for it.
  markConversationSynced(
    id,
    cloudId,
    snapshot = null,
    cloudUpdatedAt = null,
    accountId = this.activeAccountId
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        if (snapshot) {
          const current = this._conversationWithMessageCount(id);
          if (
            !current ||
            current.cloud_id !== cloudId ||
            !this._conversationMatchesSnapshot(current, snapshot)
          ) {
            return { success: false };
          }
        }
        const claim = this._claimUnattributedSql("agent_conversations", { accountId });
        const result = this.db
          .prepare(
            `UPDATE agent_conversations
             SET cloud_id = COALESCE(cloud_id, ?),
                 updated_at = COALESCE(?, updated_at),
                 ${claim.sql},
                 sync_status = CASE WHEN deleted_at IS NULL THEN 'synced' ELSE 'pending' END
             WHERE id = ? AND (account_id IS NULL OR account_id = ?)`
          )
          .run(cloudId, cloudUpdatedAt, ...claim.params, id, accountId);
        return { success: result.changes > 0 };
      })();
    } catch (error) {
      debugLogger.error("Error marking conversation synced", { error: error.message }, "database");
      throw error;
    }
  }

  // Runs just before a create request is sent; a chat deleted since the push
  // read it reports no success and is not sent.
  markConversationCreateAttempted(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._syncRowScope("agent_conversations");
      const result = this.db
        .prepare(
          `UPDATE agent_conversations SET cloud_create_attempted = 1 WHERE id = ? AND ${scope.sql}`
        )
        .run(id, ...scope.params);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error(
        "Error marking conversation create attempted",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Main refused the create before it left, so no cloud copy can exist. The row
  // may be another account's by now, which is why this isn't scoped.
  clearConversationCreateAttempted(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE agent_conversations SET cloud_create_attempted = 0 WHERE id = ? AND cloud_id IS NULL"
        )
        .run(id);
    } catch (error) {
      debugLogger.error(
        "Error clearing conversation create attempted",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // The cloud's only copy under this identity is a tombstone that takes no more
  // writes, so a live chat gets a new identity and goes up as a new copy. The
  // tombstone is in the cloud of the account that sent the create (`accountId`),
  // so a chat another account owns by now keeps its identity.
  replaceConversationClientId(id, expectedClientId, accountId = this.activeAccountId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          `UPDATE agent_conversations
           SET client_conversation_id = ?, cloud_create_attempted = 0, sync_status = 'pending'
           WHERE id = ? AND client_conversation_id = ? AND cloud_id IS NULL AND deleted_at IS NULL
             AND (account_id IS NULL OR account_id = ?)`
        )
        .run(randomUUID(), id, expectedClientId, accountId);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error(
        "Error replacing conversation client id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // As markConversationSynced: acknowledged for the account that sent the create.
  acknowledgeConversationCreate(id, snapshot, cloudId, accountId = this.activeAccountId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!snapshot || !cloudId) {
        return { success: false, outcome: "unresolved", cloud_id: null };
      }

      return this.db.transaction(() => {
        const current = this._conversationWithMessageCount(id);
        const expectedClientId = snapshot.client_conversation_id ?? null;

        // Another account owns the row now, so the copy just created in the
        // sender's cloud must go.
        if (this._ownedByOtherAccount(current, accountId)) {
          return { success: true, outcome: "orphaned", cloud_id: null };
        }

        if (!current || (current.client_conversation_id ?? null) !== expectedClientId) {
          const identityStillExists = expectedClientId
            ? this.db
                .prepare("SELECT 1 FROM agent_conversations WHERE client_conversation_id = ?")
                .get(expectedClientId)
            : null;
          return {
            success: true,
            outcome: identityStillExists ? "unresolved" : "orphaned",
            cloud_id: null,
          };
        }

        if (current.cloud_id) {
          return { success: true, outcome: "already-linked", cloud_id: current.cloud_id };
        }

        const claim = this._claimUnattributedSql("agent_conversations", { accountId });
        // Linked at once, so a failure from here on can't lead to a second create,
        // which would insert this request's messages again. Still pending until
        // the cloud has the rest, or the delete goes through.
        if (current.deleted_at || !this._conversationMatchesSnapshot(current, snapshot)) {
          this.db
            .prepare(
              `UPDATE agent_conversations
               SET cloud_id = ?, sync_status = 'pending', ${claim.sql}
               WHERE id = ? AND cloud_id IS NULL`
            )
            .run(cloudId, ...claim.params, id);
          return {
            success: true,
            outcome: current.deleted_at ? "delete-pending" : "changed",
            cloud_id: cloudId,
          };
        }

        this.db
          .prepare(
            `UPDATE agent_conversations
             SET cloud_id = ?, sync_status = 'synced', ${claim.sql}
             WHERE id = ? AND cloud_id IS NULL`
          )
          .run(cloudId, ...claim.params, id);
        return { success: true, outcome: "synced", cloud_id: cloudId };
      })();
    } catch (error) {
      debugLogger.error(
        "Error acknowledging conversation create",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._ownedRowScope("agent_conversations");
      const owned = this.db
        .prepare(`SELECT 1 FROM agent_conversations WHERE id = ? AND ${scope.sql}`)
        .get(id, ...scope.params);
      if (!owned) return { success: false };
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
      const scope = this._syncRowScope("transcriptions");
      return this.db
        .prepare(
          `SELECT * FROM transcriptions WHERE sync_status = 'pending' AND deleted_at IS NULL AND ${scope.sql}`
        )
        .all(...scope.params);
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
      const scope = this._syncRowScope("transcriptions");
      return this.db
        .prepare(
          `SELECT * FROM transcriptions WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending' AND ${scope.sql}`
        )
        .all(...scope.params);
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
      const scope = this._ownedRowScope("transcriptions");
      const result = this.db
        .prepare(`DELETE FROM transcriptions WHERE id = ? AND ${scope.sql}`)
        .run(id, ...scope.params);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error hard deleting transcription", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptionByClientId(clientId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scope = this._syncRowScope("transcriptions");
      return (
        this.db
          .prepare(
            `SELECT * FROM transcriptions WHERE client_transcription_id = ? AND ${scope.sql}`
          )
          .get(clientId, ...scope.params) || null
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
      const text = cloudTranscription.text ?? "";
      const rawText = cloudTranscription.raw_text || null;
      const status = cloudTranscription.status || "completed";
      // timestamp is what the history list sorts and groups on, so it takes the
      // cloud row's own instant rather than defaulting to the moment of the
      // pull -- which would land a whole archive at "now", above everything
      // spoken since. Deliberately not in the conflict update: a row this
      // device recorded already carries the recording's start time, which is
      // more precise than the cloud's creation time for the same dictation.
      //
      // The separator is normalized because that sort is a TEXT comparison and
      // the API sends ISO 8601: "T" (0x54) outranks the space (0x20) every
      // locally written row uses, so a raw cloud value would sort above every
      // local dictation from the same UTC day whatever the hour.
      const cloudOccurredAt = toDbTimestamp(cloudTranscription.created_at);
      const stmt = this.db.prepare(`
        INSERT INTO transcriptions (client_transcription_id, cloud_id, text, raw_text, status, sync_status, created_at, timestamp, account_id)
        VALUES (?, ?, ?, ?, ?, 'synced', ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
        ON CONFLICT(client_transcription_id) DO UPDATE SET
          account_id = COALESCE(excluded.account_id, account_id),
          cloud_id = excluded.cloud_id,
          text = excluded.text,
          raw_text = excluded.raw_text,
          status = excluded.status,
          sync_status = 'synced'
      `);
      return this.db.transaction(() => {
        const existing = this.db
          .prepare(
            `SELECT id, text, raw_text, status, account_id FROM transcriptions
             WHERE client_transcription_id = ?`
          )
          .get(cloudTranscription.client_transcription_id);
        if (this._ownedByOtherAccount(existing)) {
          debugLogger.warn(
            "Skipping cloud transcription that belongs to another local account",
            {},
            "database"
          );
          return null;
        }
        if (existing && !existing.account_id && this.activeAccountId) {
          // Matching cloud identity proves ownership, without replaying old
          // cloud text over local edits or reviving a local deletion.
          const claim = this._claimUnattributedSql("transcriptions", { proven: true });
          this.db
            .prepare(`UPDATE transcriptions SET ${claim.sql} WHERE id = ?`)
            .run(...claim.params, existing.id);
          return this.getTranscriptionByClientId(cloudTranscription.client_transcription_id);
        }
        if (
          existing &&
          (existing.text !== text || existing.raw_text !== rawText || existing.status !== status)
        ) {
          this._invalidateAnalyticsHistoryFromTranscription(existing.id);
        }
        stmt.run(
          cloudTranscription.client_transcription_id,
          cloudTranscription.id,
          text,
          rawText,
          status,
          cloudTranscription.created_at,
          cloudOccurredAt,
          this.activeAccountId
        );
        return this.db
          .prepare("SELECT * FROM transcriptions WHERE client_transcription_id = ?")
          .get(cloudTranscription.client_transcription_id);
      })();
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
      const claim = this._claimUnattributedSql("transcriptions");
      const result = this.db
        .prepare(
          `UPDATE transcriptions SET sync_status = 'synced', cloud_id = ?, ${claim.sql}
           WHERE id = ? AND (account_id IS NULL OR account_id = ?)`
        )
        .run(cloudId, ...claim.params, id, this.activeAccountId);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error marking transcription synced", { error: error.message }, "database");
      throw error;
    }
  }

  getNotesWithUnmappedSpeakers() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const accountScope = this._accountScopeCondition("notes");
      return this.db
        .prepare(
          `SELECT DISTINCT nse.note_id
          FROM note_speaker_embeddings nse
          JOIN notes ON notes.id = nse.note_id
          LEFT JOIN speaker_mappings sm ON nse.note_id = sm.note_id AND nse.speaker_id = sm.speaker_id
          WHERE sm.note_id IS NULL AND ${accountScope.sql}`
        )
        .all(...accountScope.params)
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
      if (!this.getNote(noteId)) return { success: false };
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
