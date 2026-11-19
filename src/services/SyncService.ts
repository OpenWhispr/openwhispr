import {
  hasUnrevisionedNoteClear,
  hasNoteRevision,
  isStaleNoteConflict,
  noteAwaitsCloudResolution,
} from "../helpers/noteFieldSync.js";
import type {
  DictionaryEntryItem,
  NoteItem,
  FolderItem,
  FolderPushSnapshot,
  SpaceItem,
  TranscriptionItem,
  ConversationPreview,
  ConversationCreateSnapshot,
  StaleSyncWrite,
  PrivatePlacementBackupCandidates,
  PrivatePlacementBackupRow,
} from "../types/electron";
import { NotesService, type CloudNote } from "./NotesService.js";
import { ConversationsService, type CloudConversation } from "./ConversationsService.js";
import { FoldersService } from "./FoldersService.js";
import { SpacesService, type MySpace } from "./SpacesService.js";
import { TranscriptionsService } from "./TranscriptionsService.js";
import { syncPendingAnalytics } from "./AnalyticsService.js";
import { DictionaryService, type CloudDictionaryEntry } from "./DictionaryService.js";
import { SharedDictionaryService } from "./SharedDictionaryService";
import { SnippetService, type CloudSnippetEntry } from "./SnippetService.js";
import { SkillsService } from "./SkillsService.js";
import type { CloudSkillEntry, SkillSyncUnavailable } from "../types/skills";
import { CloudApiError, isAuthContextError, wasRefusedBeforeSending } from "./cloudApi.js";
import { LeaderboardService } from "./LeaderboardService";
import { checkStandInOwnership } from "./standInOwnershipCheck";
import {
  assertAuthGenerationCurrent,
  getAuthRequestContextSnapshot,
  getValidatedAuthGeneration,
  hasValidatedAuthContext,
} from "../lib/authRequestContext";
import { partitionLocalTeamSpaces } from "./accountSpaceValidation";
import {
  clearTeamSpacesCapability,
  readTeamSpacesCapability,
  writeTeamSpacesCapability,
} from "../lib/teamSpacesCapability";
import { readIsSubscribed, subscribeIsSubscribed } from "../lib/subscriptionFlag";
import { readNoteConflictIds, readNoteConflicts } from "../lib/noteConflictRegistry";
import { serverClockOffsetMs, serverTimeIso } from "../lib/serverClock";
import { pendingLeaderboardLeaveDeservesPriority } from "../lib/pendingLeaderboardLeave";
import { hasSharedDictionaryPlan } from "../lib/workspaceBilling";
import {
  cloudBackupResumed,
  effectiveLocalHistoryEnabled,
  isCloudBackupAllowed,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { findDefaultFolder } from "../components/notes/shared";
import { useSettingsStore } from "../stores/settingsStore";
import {
  hasWelcomedSharedDictionary,
  recordSharedDictionaryArrival,
  SHARED_DICTIONARY_CAPABILITY_KEY,
  useSharedDictionaryStore,
} from "../stores/sharedDictionaryStore";
import {
  ACTIVE_WORKSPACE_SOURCE_KEY,
  readActiveWorkspaceId,
  useWorkspaceStore,
  WORKSPACE_LIST_CACHE_KEY,
} from "../stores/workspaceStore";
import { EMPTY_SHARED_HINTS, selectSharedHintWords } from "../utils/sharedDictionaryHints";
import type {
  CloudSharedEntry,
  CloudSharedHide,
  SharedContributor,
  SharedDictionaryHideRecord,
  SharedDictionaryMeta,
  SharedDictionaryPage,
  SharedDictionarySnapshot,
  SharedScope,
} from "../types/sharedDictionary";
import {
  buildNoteCreatePayload,
  buildNoteUpdatePayload,
  isCloudEntryNewer,
  isCloudNoteNewer,
  normalizeTimestamp,
} from "../helpers/cloudSyncGuards.js";
import {
  recordNoteCreateAttempts,
  resolveRendererCloudNoteCreate,
  type CloudNoteCreateResult,
} from "./noteCreateAck";
import {
  clearUpdate404,
  isLegacySharedPrivateNote,
  isPermissionDenialCode,
  isSpaceAccessErrorCode,
  keepPurgedSpaceEntry,
  nextAmbientEmptyStreak,
  normalizePurgedSpaceEntries,
  prunePurgedSpaceEntries,
  recordUpdate404,
  resolvePulledNoteFolderId,
  resolvePullCursorAdvance,
  resolveSyncConsent,
  shouldRunAmbientTeamOnlyPass,
  revokedNoteForkUpdate,
  shouldSetOwnerFromCloud,
  UPDATE_404_FORK_THRESHOLD,
  type PurgedSpaceEntry,
  type PurgedSpaceReason,
  type SyncConsent,
} from "./syncPassPolicy";

// Batches within the API's caps on count and size; a skill over the size cap on its own can't
// reach here (the library holds it back as too large to back up).
function skillBatches<T>(entries: T[]): T[][] {
  const encoder = new TextEncoder();
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 2;
  for (const entry of entries) {
    const size = encoder.encode(JSON.stringify(entry)).length + 1;
    if (
      batch.length === SKILL_BATCH_SIZE ||
      (batch.length > 0 && bytes + size > SKILL_BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// How a skills pull went: the names it couldn't write, "failed" when it stopped early, or
// "unsupported" on an API without skills routes.
type SkillPullResult = { unwritten: Set<string> } | "failed" | "unsupported";

// A lookup of this computer's copy of a skill that main couldn't finish.
const isSkillLookupFailed = (row: unknown): row is SkillSyncUnavailable =>
  (row as SkillSyncUnavailable | null | undefined)?.error === "unavailable";

function isHttpStatus(err: unknown, status: number): boolean {
  return err instanceof CloudApiError && err.status === status;
}

// Typed errors from space write-access checks (legacy team_* and canonical
// space_* names — see isSpaceAccessErrorCode): the caller lost the whole
// space, so the row settles terminally instead of retrying forever.
function isSpaceAccessError(err: unknown): boolean {
  return err instanceof CloudApiError && isSpaceAccessErrorCode(err.code);
}

// Typed per-row permission denial (note_access_denied,
// note_scope_change_denied, folder_access_denied): the caller keeps the
// space but may not perform this operation. Terminal — never retried — and
// recovered by preserving dirty work in Personal and snapshot-pulling the
// untouched server row back.
function isPermissionDenialError(err: unknown): boolean {
  return err instanceof CloudApiError && isPermissionDenialCode(err.code);
}

// Typed 409 from a folder rename/move colliding with a same-named folder in
// the target scope; the row stays pending until the conflict is resolved.
function isFolderNameTakenError(err: unknown): boolean {
  return err instanceof CloudApiError && err.code === "folder_name_taken";
}

// Typed 400 for a parent the server can't nest under (moved to another space,
// nested itself, or the folder gained subfolders on another device). Pending
// rows never take pulled parents, so the folder is un-nested locally and the
// next pass pushes it top-level.
function isInvalidParentFolderError(err: unknown): boolean {
  return err instanceof CloudApiError && err.code === "invalid_parent_folder";
}

// Typed 409 from a note PATCH whose base_updated_at is older than the stored
// row — another device wrote first. The body carries the current cloud note.
function isNoteVersionConflictError(err: unknown): boolean {
  return err instanceof CloudApiError && err.code === "note_version_conflict";
}

// A row queued only to send its folder link holds no edit a cloud copy could
// conflict with; any local edit turns it plain 'pending'.
function hasUnpushedNoteEdits(note: NoteItem): boolean {
  return note.sync_status !== "synced" && note.sync_status !== "folder_link_pending";
}

function conflictCloudNote(err: unknown): CloudNote | null {
  const details = (err as CloudApiError).details as { note?: CloudNote } | undefined;
  return details?.note ?? null;
}

// Sent with every note push without being part of what the note holds.
const NOTE_PUSH_BASE_FIELDS = new Set([
  "client_note_id",
  "updated_at",
  "base_updated_at",
  "base_revision",
  "field_updates",
]);

// The cloud copy behind a 409 matches everything the push sends: only its timestamp and revision
// moved, as when a folder given a new placement moves (and bumps) its notes on the server.
// Compared as text, since the server returns numeric columns as strings.
function onlyMovedSince(payload: object, cloudNote: CloudNote): boolean {
  const cloud = cloudNote as unknown as Record<string, unknown>;
  return Object.entries(payload).every(
    ([field, value]) =>
      value === undefined ||
      NOTE_PUSH_BASE_FIELDS.has(field) ||
      String(value ?? "") === String(cloud[field] ?? "")
  );
}

type PlacementBackfillWrite = {
  kind: "folder" | "note";
  id: number;
  cloudId: string;
  clientId: string;
  workspaceId: string;
};

const PLACEMENT_BACKFILL_RETRY_MS = 10 * 60 * 1000;

// Extra fields pushed with note/folder payloads so the server files rows into
// the right space scope; `null` scope means the row must not push at all.
type PushScopeFields = {
  workspace_id?: string | null;
  space_id?: string | null;
  private_workspace_id?: string | null;
};

// Per-pull-pass mapping of cloud spaces to local spaces.
interface SpaceSyncContext {
  byId: Map<number, SpaceItem>;
  byCloudSpaceId: Map<string, SpaceItem>;
  // The default Private receives personal rows first seen on this device.
  defaultPrivateSpace?: SpaceItem | null;
  // Guard: at most one mid-pass spaces re-pull per pass.
  refreshedSpaces: boolean;
}

// Team membership and personal Backup consent remain separate sync scopes.
function isTeamRow(row: { space_id: number }, ctx: SpaceSyncContext): boolean {
  return ctx.byId.get(row.space_id)?.kind === "team";
}

// The snapshot a folder push settles against. A parent withheld from the push
// (a folder leaving a team retracts top-level) no longer matches the row, so
// the row stays pending until its nesting can be sent.
function withSentParent(folder: FolderItem, parentFolderId: string | null): FolderItem {
  return { ...folder, parent_folder_id: parentFolderId === null ? null : folder.parent_folder_id };
}

// A Private subfolder takes its parent's placement, so its push leaves the
// placement out and the server inherits it. Named, it could differ from the
// parent's: the server reads an explicit null as the default workspace, a
// parent backed up before placement is unassigned there, and a placement other
// than the parent's is refused (invalid_parent_folder). A team row keeps its
// explicit null, which says it has no Private placement at all.
function folderPushScope(scope: PushScopeFields, parentFolderId: string | null): PushScopeFields {
  if (!parentFolderId || scope.space_id || !("private_workspace_id" in scope)) return scope;
  const { private_workspace_id: _placement, ...inherited } = scope;
  return inherited;
}

// What a folder's server row holds after a push of it landed, but its parent.
// Identity is left out: a create adopts the cloud id (and may adopt a client id).
function folderPushFingerprint(folder: FolderItem): string {
  return JSON.stringify([folder.name, !!folder.is_default, folder.sort_order, folder.space_id]);
}

// What a refused folder push sent, parent included: the refusal stands until one of them changes.
function folderRefusalFingerprint(folder: FolderItem): string {
  return JSON.stringify([folderPushFingerprint(folder), folder.parent_folder_id ?? null]);
}

// A subfolder whose last push went up top-level beside a parent refused for good
// that still has no cloud row: sending it again would send what already landed.
// The parent's cloud id, a refusal that ends or an edit of the subfolder (it no
// longer matches its record) sends it again.
function nestingStillOwed(
  folder: FolderItem,
  {
    localToCloud,
    refusedFolderIds,
    nestingOwedFolderIds,
  }: Pick<LocalToCloudFolderMap, "localToCloud" | "refusedFolderIds" | "nestingOwedFolderIds">
): boolean {
  return (
    folder.parent_folder_id != null &&
    !folder.left_team &&
    nestingOwedFolderIds.has(folder.id) &&
    refusedFolderIds.has(folder.parent_folder_id) &&
    !localToCloud.has(folder.parent_folder_id)
  );
}

// A note keeps its cloud folder association in both personal and team scope.
// It never carries a blocked folder: a note that passes one (a note leaving a
// team, or one past its folder's wait) goes unfiled, and its acknowledgement
// leaves the link owed (folder_link_pending) for once the folder lands.
function pushedFolderId(
  note: NoteItem,
  {
    localToCloud,
    blockedFolderIds,
  }: Pick<LocalToCloudFolderMap, "localToCloud" | "blockedFolderIds">
): string | null {
  if (!note.folder_id || blockedFolderIds.has(note.folder_id)) return null;
  return localToCloud.get(note.folder_id) ?? null;
}

// A clean local row in another Private than the one its cloud copy names: another device moved
// it without this one seeing a newer copy (a Keep after a conflict takes the server's timestamp).
function misplacedPrivateRow(
  cloud: { space_id?: string | null; private_workspace_id?: string | null },
  local: { space_id: number; sync_status?: string | null },
  space: SpaceItem
): boolean {
  return (
    !cloud.space_id &&
    !!cloud.private_workspace_id &&
    local.sync_status === "synced" &&
    space.id !== local.space_id
  );
}

// A note in a folder of the default Private takes that folder's placement rather than naming
// it: a folder backed up before placement is unassigned on the server, which reads that as the
// default but refuses it beside an explicit default.
function folderPlacedNoteScope(
  note: NoteItem,
  scope: PushScopeFields,
  cloudFolderId: string | null,
  ctx: SpaceSyncContext
): PushScopeFields {
  const space = ctx.byId.get(note.space_id);
  if (
    !cloudFolderId ||
    space?.kind !== "private" ||
    (space.workspace_id && !space.is_default_private)
  )
    return scope;
  const { private_workspace_id: _placement, ...folderPlaced } = scope;
  return folderPlaced;
}

// A pulled folder's server parent, applied once the page is stored
// (applyCloudFolderParents), guarded by the row as it was stored.
interface FolderParentLink {
  cloudId: string;
  parentCloudId: string | null;
  snapshot: FolderPushSnapshot;
  adoptIfPending: boolean;
}

interface LocalToCloudFolderMap {
  localToCloud: Map<number, string>;
  // Cloud-backed folders with unpushed changes: their migration PATCH failed
  // or hasn't run yet (folders push before notes in a pass), so pushing a
  // child note's folder_id + scope now could be rejected as out of scope, and
  // a subfolder must not go up beside its parent's move or placement PATCH.
  // With Backup on, a Private folder with no cloud copy yet too: a full pass
  // uploads it, and a note pushed before then would land unfiled. A new team
  // subfolder waiting for its parent holds its notes back as well. Those notes
  // defer and stay pending.
  blockedFolderIds: Set<number>;
  // The blocked folders with no cloud id, whose wait has a limit.
  waitingFolders: FolderItem[];
  // Folders whose last push the server refused for good (a name taken), as the
  // row still stands. Their subfolders stop waiting for them (cloudParentFolderId).
  refusedFolderIds: Set<number>;
  // Pending folders whose last push landed everything but their parent, as the
  // row still stands (FOLDER_NESTING_OWED_KEY). They don't hold their notes back.
  nestingOwedFolderIds: Set<number>;
}

const PUSH_DEBOUNCE_MS = 2000;
const BATCH_SIZE = 50;
const TRANSCRIPTION_BATCH_SIZE = 100;
const DICTIONARY_BATCH_SIZE = 200;
const SNIPPET_BATCH_SIZE = 200;
// The API's caps on one skills batch-create, which it measures as the JSON of the entries.
const SKILL_BATCH_SIZE = 10;
const SKILL_BATCH_BYTES = 3 * 1024 * 1024;
const SKILL_PAGE_SIZE = 50;
// Minimum gap between auto syncs, measured from the last completed pass in
// any window (the stamp lives in shared localStorage).
const AUTO_SYNC_THROTTLE_MS = 20000;
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
// While a note is open, pull on this much shorter cadence so a teammate's edits
// surface in seconds rather than at the ambient interval above.
const OPEN_NOTE_SYNC_INTERVAL_MS = 30_000;
const TEAM_SPACES_RETRY_MS = 10_000;
const TEAM_SPACES_MAX_RETRY_MS = AUTO_SYNC_INTERVAL_MS;
// Web Lock name serializing syncAll() across windows (each renderer has its
// own SyncService instance, but localStorage and the local DB are shared).
const SYNC_ALL_LOCK = "openwhispr-sync-all";
// Web Lock prefix, per local note id, held from reading a note to recording
// the server's answer. The debounced push runs outside SYNC_ALL_LOCK, so while
// a meeting records into a note it and a sync pass would otherwise PATCH it at
// once from the same base revision, and the server refuses whichever lands
// second (409).
const NOTE_PUSH_LOCK_PREFIX = "openwhispr-note-push:";
// How long a sync pass waits for a note's push lock. It holds SYNC_ALL_LOCK
// meanwhile, so a debounced push whose answer never comes must not stop every
// sync; the note waits for the next pass instead.
const NOTE_PUSH_LOCK_PASS_WAIT_MS = 10_000;
// Pull cursors this device stamped on the server's clock (see serverClock).
// Without this marker they came from the device's own clock.
const SERVER_CLOCK_CURSORS_KEY = "syncCursors.serverClock";
// How far a stored cursor may run ahead of the server, or the device's clock
// ahead of it, before the cursors are taken to have come from a fast clock.
const FAST_CLOCK_TOLERANCE_MS = 2 * 60 * 1000;
// Delta-pull cursors, each stamped with the time its pull started on the
// server's clock as that pull's answers read it; the server compares it against
// its own updated_at.
const PULL_CURSOR_KEYS = [
  "lastSyncedAt.notes",
  "lastSyncedAt.notes.team",
  "lastSyncedAt.folders",
  "lastSyncedAt.folders.team",
  "lastSyncedAt.conversations",
  "lastSyncedAt.transcriptions",
];
// Every pull's delta cursor, and the account whose passes stamped them.
const SYNC_CURSOR_KEYS = [
  "lastSyncedAt.folders",
  "lastSyncedAt.folders.team",
  "lastSyncedAt.notes",
  "lastSyncedAt.notes.team",
  "lastSyncedAt.conversations",
  "lastSyncedAt.transcriptions",
  "lastSyncedAt.dictionary",
  "lastSyncedAt.dictionary.id",
  "lastSyncedAt.snippets",
  "lastSyncedAt.snippets.id",
  "lastSyncedAt.skills",
  "lastSyncedAt.skills.id",
];
// Per account: cloud copies of a chat that another account took over while its
// create was in flight, deleted when the sender is back to do it.
const ORPHANED_CHAT_CREATES_PREFIX = "orphanedChatCreates.";
const SYNC_CURSOR_ACCOUNT_KEY = "lastSyncedAt.accountId";
// Prefix of each signed-out account's saved cursors, restored when it returns.
const SYNC_CURSOR_SAVED_PREFIX = "lastSyncedAt.byAccount.";
// The account that claimed cursors stamped before owners were recorded, until
// backfillUnownedCursors() has checked them.
const UNOWNED_CURSORS_ACCOUNT_KEY = "syncCursors.unownedClaimedBy";
// How far that check has got: the snapshots already complete, so a retry walks
// only the tables still outstanding, and when the next attempt is due once
// passes have kept failing.
const UNOWNED_CLAIM_PROGRESS_KEY = "syncCursors.unownedClaimProgress";
const UNOWNED_CLAIM_RETRY_MS = 5 * 60 * 1000;
const UNOWNED_CLAIM_MAX_RETRY_MS = 60 * 60 * 1000;
// Per account: "done" once repair has checked every linked chat for messages its cloud
// copy is missing (repairUnsentChatMessages), else when a failed check may next
// run, so one that keeps failing doesn't walk every chat on every pass.
const CHAT_MESSAGE_REPAIR_PREFIX = "syncCursors.chatMessages:";
const CHAT_MESSAGE_REPAIR_RETRY_MS = 5 * 60 * 1000;
// localStorage keys gating what a pass may sync; a change in another window
// means sync may have just become possible (sign-in, subscription, backup
// enabled, Insights opt-in).
const CAN_SYNC_KEYS = [
  "isSignedIn",
  "cloudBackupEnabled",
  "isSubscribed",
  "insightsSyncEnabled",
  "dataRetentionEnabled",
];

// Cross-window guard against a space purge racing an in-flight pull: every
// purge initiator records the cloud space id here, and pull/upsert paths park
// rows for recently purged spaces instead of resurrecting them as orphaned
// local rows nothing can ever clean up. Entries are pruned once a spaces pass
// confirms the space is gone from /api/me/spaces, when a "revoked" entry's
// space reappears there (member re-added — the guard must not lock them out,
// D14), or after a TTL so a failed delete cannot hide a still-live space
// forever. Never marked on TEAM delete: a space still accessible via other
// teams survives the team's archival.
const PURGED_SPACE_GUARD_KEY = "purgedSpaceIds";
const PURGED_SPACE_GUARD_TTL_MS = 15 * 60 * 1000;
// Serializes the guard's read-modify-write across windows: a prune inside a
// sync pass racing a delete in another window must not drop the just-written
// entry.
const PURGED_SPACE_GUARD_LOCK = "openwhispr-purged-spaces";
// Per-row count of consecutive passes whose update PATCH 404'd without the pull
// disambiguating it (see recordUpdate404), keyed by client id. Read-modify-
// written only inside the SYNC_ALL_LOCK pass, so it needs no lock of its own.
const NOTE_UPDATE_404_KEY = "noteUpdate404Counts";
// Attempts at replaying each note feed from its start (see replayNoteFeed).
const NOTE_FEED_REPLAY_KEY = "noteFeedReplay.v1";
const NOTE_FEED_REPLAY_TEAM_KEY = "noteFeedReplay.v1.team";
const NOTE_FEED_REPLAY_ATTEMPTS = 3;
const FEED_START = "1970-01-01T00:00:00.000Z";
// Every delta from a stored cursor re-reads this much before it. A server write
// stamps its rows with its transaction's start but shows them only at commit, so
// a pull that ran in between stored a cursor past rows it never saw (and other
// writers can commit out of updated_at order). Re-applied rows are no-ops.
const DELTA_READ_OVERLAP_MS = 10_000;
// An account's cursors travel with their clock-recovery marker and replay
// counters, so another account's pass cannot spend either recovery attempt.
const ACCOUNT_SYNC_STATE_KEYS = [
  ...SYNC_CURSOR_KEYS,
  SERVER_CLOCK_CURSORS_KEY,
  NOTE_FEED_REPLAY_KEY,
  NOTE_FEED_REPLAY_TEAM_KEY,
];
const FOLDER_UPDATE_404_KEY = "folderUpdate404Counts";
// Per-folder time (ms) a folder with no cloud id was first seen holding its notes
// back, keyed by client id, so that wait has a limit. A parent that can't reach
// the cloud (it keeps being refused) would otherwise withhold them for good.
const FOLDER_WAIT_STARTED_KEY = "folderWaitStartedAt";
const FOLDER_WAIT_RELEASE_MS = 30 * 60 * 1000;
// Folders whose push the server refused for good (folder_name_taken), keyed by
// local id with what that push sent (folderRefusalFingerprint). A refusal holds
// only while the row still matches: an edit ends it, and the row waits as usual.
const FOLDER_PUSH_REFUSED_KEY = "folderPushRefused";
// Folders whose last push landed everything but their parent (sent top-level
// while their parent couldn't be named), keyed by local id with what that push
// held (folderPushFingerprint). Such a row is pending for its nesting alone, so
// its server row is where its notes belong, and they don't wait for it.
const FOLDER_NESTING_OWED_KEY = "folderNestingOwed";
// Set per account once folders pulled before parent_folder_id existed have been
// replayed: one for the personal rows a full pass covers, one for team rows.
const FOLDER_PARENTS_BACKFILLED_KEY = "folderParentsBackfilled";
// Unattributed words and snippets whose PATCH 404'd for an account, keyed by
// client id with the updated_at that failed. Such a row may be another
// account's, so it is never re-created; it waits for its owner's pass or a new
// local edit instead of repeating the dead PATCH every pass.
const PARKED_UPDATE_404_PREFIX = "parkedUpdate404";
// Unattributed tombstones whose delete an account's cloud did not confirm, keyed
// by cloud id. On a device another account has used, the copy may be in that
// account's cloud: dropping the tombstone would let its next pull bring the row
// back. It waits for its owner's pass, and this account stops re-sending it.
const PARKED_DELETE_PREFIX = "parkedDelete";
const PARKED_DELETE_KINDS = ["conversations", "transcriptions", "dictionary", "snippets"] as const;
type ParkedDeleteKind = (typeof PARKED_DELETE_KINDS)[number];

const SHARED_DICTIONARY_PAGE_LIMIT = 200;
// Shared list deltas re-read DELTA_READ_OVERLAP_MS before the stored cursor too.
// The cursor a pass stores is the FIRST page's server_time: a row deleted (or
// unhidden) behind a later page of the same pass is then still re-read next time.
// Covers both cursor families: lastSyncedAt.sharedDictionary.<ws> and
// lastSyncedAt.sharedDictionaryHides.<ws>.
const SHARED_DICTIONARY_CURSOR_PREFIX = "lastSyncedAt.sharedDictionary";
// Personal rows pulled before shared_at existed never got it; one re-read of
// the personal dictionary from the epoch picks it up.
const DICTIONARY_SHARED_AT_BACKFILL_KEY = "dictionarySharedAtBackfill";
// A personal pull with no cursor reads the delta from here: unlike the list's
// snapshot it includes tombstones and pages on (updated_at, id).
const DICTIONARY_PULL_EPOCH = "1970-01-01T00:00:00.000Z";

const sharedEntriesCursorKey = (workspaceId: string): string =>
  `${SHARED_DICTIONARY_CURSOR_PREFIX}.${workspaceId}`;
const sharedHidesCursorKey = (workspaceId: string): string =>
  `${SHARED_DICTIONARY_CURSOR_PREFIX}Hides.${workspaceId}`;

function readSharedCursor(key: string): string | null {
  const at = localStorage.getItem(key);
  return at && !Number.isNaN(Date.parse(at)) ? at : null;
}

// The stored cursor never moves backwards, whatever the server clock says.
function writeSharedCursor(key: string, previous: string | null, at: string | undefined): void {
  const next =
    at && !Number.isNaN(Date.parse(at)) && (!previous || Date.parse(at) >= Date.parse(previous))
      ? at
      : previous;
  if (next) localStorage.setItem(key, next);
}

function clearSharedCursors(workspaceId: string): void {
  localStorage.removeItem(sharedEntriesCursorKey(workspaceId));
  localStorage.removeItem(sharedHidesCursorKey(workspaceId));
}

function clearSharedCursorsExcept(keepWorkspaceIds: string[]): void {
  const keep = new Set(
    keepWorkspaceIds.flatMap((id) => [sharedEntriesCursorKey(id), sharedHidesCursorKey(id)])
  );
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(SHARED_DICTIONARY_CURSOR_PREFIX) && !keep.has(key)) {
      keys.push(key);
    }
  }
  for (const key of keys) localStorage.removeItem(key);
}

function removeLocalStorageKeysWithPrefix(prefix: string): void {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}

// The delta start for a stored cursor, DELTA_READ_OVERLAP_MS before it. The feed's
// start stays where it is, and a cursor that doesn't parse is sent as it was.
function overlappedSince(cursor: string): string {
  const at = Date.parse(cursor);
  if (!Number.isFinite(at)) return cursor;
  return new Date(Math.max(0, at - DELTA_READ_OVERLAP_MS)).toISOString();
}

// Whether a delta row is past the stored cursor, rather than one re-read from the
// overlap. With no stored cursor every row is new.
function pastCursor(updatedAt: string | null | undefined, cursor: string | undefined): boolean {
  if (cursor === undefined) return true;
  const at = Date.parse(updatedAt ?? "");
  const bound = Date.parse(cursor);
  return !Number.isFinite(at) || !Number.isFinite(bound) || at > bound;
}

// A live note re-read from the overlap at the version this device's copy holds as
// its base: its own write, or one an earlier pull applied. It was never missed, so
// it is left alone, as it was before the overlap. Comparing it again could raise a
// conflict over a newer local edit when the device clock runs behind.
function heldOverlapNote(
  local: NoteItem,
  cloudNote: CloudNote,
  cursor: string | undefined
): boolean {
  return (
    !pastCursor(cloudNote.updated_at, cursor) &&
    !cloudNote.deleted_at &&
    !cloudNote.access_removed &&
    local.cloud_id === cloudNote.id &&
    !local.cloud_create_pending &&
    !local.cloud_create_rejected &&
    !!local.cloud_updated_at &&
    normalizeTimestamp(local.cloud_updated_at) === normalizeTimestamp(cloudNote.updated_at) &&
    (!hasNoteRevision(cloudNote.revision) ||
      !hasNoteRevision(local.cloud_revision) ||
      cloudNote.revision === local.cloud_revision)
  );
}

const scopeKey = (scope: SharedScope): string => scope.space_id ?? "workspace";

// A list the stored meta didn't have (a member added to a space, a restored
// space, the member re-added): rows pruned earlier are unchanged on the
// server, so only a snapshot brings them back.
function hasReturningScope(stored: SharedScope[], incoming: SharedScope[]): boolean {
  const known = new Set(stored.map(scopeKey));
  return incoming.some((scope) => !known.has(scopeKey(scope)));
}

// Later lists win, so a page's is_member and name replace older ones.
function mergeContributors(lists: SharedContributor[][]): SharedContributor[] {
  const byUser = new Map<string, SharedContributor>();
  for (const list of lists) {
    for (const contributor of list) byUser.set(contributor.user_id, contributor);
  }
  return [...byUser.values()];
}

// The first page of a pass names every adder across the member's lists, so it
// replaces what a delta stored; a teammate whose words are all gone drops out.
// An API from before that names only its own page's adders, so a stored
// contributor who may still have words in the mirror (`adderIds`) is kept,
// overridden by any page that names them.
function deltaPassContributors(
  stored: SharedContributor[],
  adderIds: ReadonlySet<string>,
  pages: SharedContributor[][]
): SharedContributor[] {
  const stillAdding = stored.filter((contributor) => adderIds.has(contributor.user_id));
  return mergeContributors([stillAdding, ...pages]);
}

function countApplyingSharedWords(snapshot: SharedDictionarySnapshot | null | undefined): number {
  if (!snapshot) return 0;
  const hints = selectSharedHintWords(snapshot);
  return hints.space.length + hints.workspace.length;
}

function isSharedDictionaryCursorExpired(err: unknown): boolean {
  return (
    err instanceof CloudApiError &&
    err.status === 410 &&
    err.code === "SHARED_DICTIONARY_CURSOR_EXPIRED"
  );
}

// The member can't read this workspace's lists any more: why, or null.
function sharedDictionaryAccessLost(err: unknown): "noAccess" | "ssoRequired" | null {
  if (!(err instanceof CloudApiError)) return null;
  if (err.status === 404 && err.code === "SHARED_DICTIONARY_NOT_MEMBER") return "noAccess";
  if (err.status === 403 && err.code === "SSO_REQUIRED") return "ssoRequired";
  return null;
}

export type DictionarySyncResult = "synced" | "skipped" | "failed";

type SharedEntriesPull = "snapshot" | "delta" | "scopesReturned";

// Cached billing can lag behind an upgrade, including after a failed refresh.
function isKnownWithoutSharedDictionaryPlan(workspaceId: string): boolean {
  const { loaded, workspaces } = useWorkspaceStore.getState();
  if (!loaded) return false;
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  return workspace !== undefined && !hasSharedDictionaryPlan(workspace);
}

// batch-create takes shared_at as an ISO timestamp with an offset.
function toCloudSharedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const ms = Date.parse(hasZone ? value : normalizeTimestamp(value));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Same version on both sides, but the local row predates shared_at (pulled by
// a build that didn't store it): take the cloud's. A pending local edit wins.
function sharedAtOnlyDiffers(
  cloudEntry: CloudDictionaryEntry,
  local: DictionaryEntryItem,
  cloudTs: string,
  localTs: string
): boolean {
  if (cloudTs !== localTs || local.sync_status === "pending") return false;
  if (cloudEntry.shared_at === undefined) return false;
  return Boolean(cloudEntry.shared_at) !== Boolean(local.shared_at);
}

interface ConversationCreateSource {
  client_conversation_id?: string | null;
  title: string;
  updated_at: string;
  messages: readonly unknown[];
}

type LocalConversation = NonNullable<
  Awaited<ReturnType<NonNullable<Window["electronAPI"]["getAgentConversation"]>>>
>;

function conversationCreateSnapshot(
  conversation: ConversationCreateSource
): ConversationCreateSnapshot {
  return {
    client_conversation_id: conversation.client_conversation_id ?? null,
    title: conversation.title,
    updated_at: conversation.updated_at,
    message_count: conversation.messages.length,
  };
}

interface ChatPushSender {
  authGeneration: number;
  accountId: string;
}

// A chat is pushed under one sign-in and acknowledged for the account it was
// sent as, so an account switch mid-request neither sends it with the next
// account's token nor hands it to that account.
function chatPushSender(): ChatPushSender | null {
  const authGeneration = getValidatedAuthGeneration();
  const accountId = getAuthRequestContextSnapshot().sessionUserId;
  return authGeneration == null || !accountId ? null : { authGeneration, accountId };
}

function pullStaleError(): Error {
  return Object.assign(new Error("Authentication context changed during pull"), {
    code: "AUTH_CONTEXT_CHANGED",
  });
}

// A pull writes rows under the sign-in that fetched them. Once main refuses a
// write as stale, the rest of the page belongs to the departed account, so the
// pull stops before its cursor moves.
function stopIfPullStale<T>(result: T): asserts result is Exclude<T, StaleSyncWrite> {
  if ((result as StaleSyncWrite | null | undefined)?.stale) throw pullStaleError();
}

// A pull pinned to a sign-in looks at no further row once it is
// replaced. Main's refusal (stopIfPullStale) covers a switch mid-row.
function stopIfSignInReplaced(authGeneration: number | undefined): void {
  if (authGeneration !== undefined && getValidatedAuthGeneration() !== authGeneration) {
    throw pullStaleError();
  }
}

function parked404Key(kind: "dictionary" | "snippets", accountId: string | null): string {
  return `${PARKED_UPDATE_404_PREFIX}.${kind}.${accountId ?? ""}`;
}

function parkedDeleteKey(kind: ParkedDeleteKind, accountId: string | null): string {
  return `${PARKED_DELETE_PREFIX}.${kind}.${accountId ?? ""}`;
}

interface QueuedDelete {
  cloud_id?: string | null;
  account_id?: string | null;
}

interface UnownedClaimProgress {
  done: string[];
  failures: number;
  retryAt: number;
}

// A chat isn't sent while a reply is still running or waiting on the user:
// another device would get a half turn and could answer its question again, and
// messages carry no shared id, so the finished reply would go as another
// message. A turn that old was cut off (the app quit) and goes as is. A fork
// waits for its first turn like a new chat does, since until then it holds only
// copies of its parent's messages.
const TURN_IN_PROGRESS_MAX_AGE_MS = 60 * 60 * 1000;

function hasTurnInProgress(conversation: {
  has_active_turn?: boolean;
  fork_message_count?: number | null;
  messages: ReadonlyArray<{ metadata?: unknown }>;
}) {
  if (
    conversation.has_active_turn ||
    conversation.messages.length <= (conversation.fork_message_count ?? 0)
  )
    return true;
  return conversation.messages.some((message) => {
    let metadata = message.metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        return false;
      }
    }
    const turn = (metadata as { turn?: { status?: string; startedAt?: number } } | null)?.turn;
    return (
      (turn?.status === "waiting" || turn?.status === "running") &&
      Date.now() - (turn.startedAt ?? 0) < TURN_IN_PROGRESS_MAX_AGE_MS
    );
  });
}

function conversationMessageMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { turn, ...rest } = parsed as Record<string, unknown>;
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return parsed;
  const { reasoning: _reasoning, ...savedTurn } = turn as Record<string, unknown>;
  return { ...rest, turn: savedTurn };
}

// Messages carry no shared id. The cloud copy holds this device's messages in
// the order they were stored, one at a time: those its create carried, empty
// ones too, then those sent after it, never an empty one, which the messages
// route refuses. So a local message counts as sent while the copy holds one of
// its role in its place, whatever the text: a reply regenerated since keeps its
// place, and the cloud can't change a message.
function missingConversationMessages<Message extends { role: string; content: string }>(
  local: readonly Message[],
  cloud: ReadonlyArray<{ role: string; content: string }>
): Message[] {
  let held = 0;
  return local.filter((message) => {
    if (cloud[held]?.role === message.role) {
      held += 1;
      return false;
    }
    return message.content.length > 0;
  });
}

// Whether a linked chat's cloud copy lacks messages this device holds. The
// matcher alone can't settle it: an empty reply kept here can take the place
// of a later reply the copy already holds, and a reply completed here can sit
// in the place of one the copy holds empty. A copy that is missing messages
// also holds fewer messages with text than this device does.
function cloudCopyIsMissingMessages(
  local: ReadonlyArray<{ role: string; content: string }>,
  cloud: ReadonlyArray<{ role: string; content: string }>
): boolean {
  const withText = (messages: ReadonlyArray<{ content: string }>) =>
    messages.filter((message) => message.content.length > 0).length;
  return withText(local) > withText(cloud) && missingConversationMessages(local, cloud).length > 0;
}

function readPurgedSpaceIds(): Record<string, PurgedSpaceEntry> {
  try {
    const raw = localStorage.getItem(PURGED_SPACE_GUARD_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number | PurgedSpaceEntry>) : {};
    return prunePurgedSpaceEntries(
      normalizePurgedSpaceEntries(parsed),
      Date.now(),
      PURGED_SPACE_GUARD_TTL_MS
    );
  } catch {
    return {};
  }
}

// Call BEFORE purgeSpace from revocation and UI delete-space flows.
export async function markSpacePurged(
  cloudSpaceId: string,
  reason: PurgedSpaceReason
): Promise<void> {
  await navigator.locks.request(PURGED_SPACE_GUARD_LOCK, () => {
    localStorage.setItem(
      PURGED_SPACE_GUARD_KEY,
      JSON.stringify({ ...readPurgedSpaceIds(), [cloudSpaceId]: { at: Date.now(), reason } })
    );
  });
}

// For a space the caller has just been told they belong to (a join): leaving it guarded the id,
// and the guard would keep the mirror from taking it back until the TTL or a full spaces pass.
export async function releasePurgedSpace(cloudSpaceId: string): Promise<void> {
  await navigator.locks.request(PURGED_SPACE_GUARD_LOCK, () => {
    const kept = Object.fromEntries(
      Object.entries(readPurgedSpaceIds()).filter(([id]) => id !== cloudSpaceId)
    );
    localStorage.setItem(PURGED_SPACE_GUARD_KEY, JSON.stringify(kept));
  });
}

async function prunePurgedSpaceIds(liveCloudSpaceIds: Set<string>): Promise<void> {
  await navigator.locks.request(PURGED_SPACE_GUARD_LOCK, () => {
    const kept = Object.fromEntries(
      Object.entries(readPurgedSpaceIds()).filter(([id, entry]) =>
        keepPurgedSpaceEntry(entry, liveCloudSpaceIds.has(id))
      )
    );
    localStorage.setItem(PURGED_SPACE_GUARD_KEY, JSON.stringify(kept));
  });
}

// Upserts cloud spaces into local rows, skipping recently purged ones — a
// purge racing this pass (delete just clicked, or the server hasn't processed
// it yet) must not resurrect the space. Returns local ids of spaces that
// still need a content backfill: brand new, or left 'pending' by a backfill
// that never finished. Shared with spaceActions' post-mutation mirror
// refresh so the purge-race guard lives in exactly one place.
export async function upsertCloudSpaces(cloudSpaces: MySpace[]): Promise<number[]> {
  const purged = readPurgedSpaceIds();
  const backfillIds: number[] = [];
  for (const cloudSpace of cloudSpaces) {
    if (purged[cloudSpace.id]) continue;
    const space = await window.electronAPI.upsertSpaceFromCloud?.(
      cloudSpace as unknown as Record<string, unknown>
    );
    // New spaces insert as 'pending' and stay that way until their content
    // backfill completes, so an interruption anywhere re-runs it.
    if (space?.sync_status === "pending") {
      backfillIds.push(space.id);
    }
  }
  return backfillIds;
}

export class SyncService {
  private syncing = false;
  private boundFoldersClaimedFor: string | null = null;
  private syncAllPending = false;
  // Filled by the placement backfill's pre-pull: each personal cloud row's placement and folder.
  private pulledPlacements: Map<
    string,
    { private_workspace_id: string | null; folder_id: string | null }
  > | null = null;
  private placementBackfillRetry: {
    accountId: string;
    at: number;
    writes: PlacementBackfillWrite[];
  } | null = null;
  private autoSyncStarted = false;
  private dictionaryDirty = false;
  private snippetsDirty = false;
  private skillsDirty = false;
  // The sign-in the running pass claimed the cursors under. A pass that went on
  // past an account switch would finish as the next account and stamp that
  // account's values into the departed account's cursor slots.
  private passGeneration: number | null = null;
  private privatePlacementGeneration: number | null = null;
  private privatePlacementProbeGeneration: number | null = null;
  // One owner_user_id backfill probe per session (see backfillNoteOwners).
  private ownerBackfillChecked = false;
  // Whether the API keeps note revisions; null until a pulled row or the
  // probe (noteRevisionsSupported) shows it.
  private noteRevisionsKnown: boolean | null = null;
  // One successful snapshot per session each for clears without a revision
  // (pushPendingNotes) and rows synced before revisions (backfillNoteRevisions).
  // Incomplete pulls retry on a later ordinary pass.
  private unrevisionedClearPullDone = false;
  private revisionBackfillChecked = false;
  private noteFeedReplayTried = new Set<string>();
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private teamSpacesRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private teamSpacesRetryAttempt = 0;
  private openNoteSyncTimer: ReturnType<typeof setInterval> | null = null;
  // Set by any pass that actually moves team or shared content; drives the
  // ambient team-only backoff (see shouldRunAmbientTeamOnlyPass).
  private teamPassMovedWork = false;
  private lastFolderPullParkedRows = false;
  // Set when the current shared dictionary pass changed the mirror or hides.
  private sharedDictionaryPassChanged = false;
  // The auth generation a plain 404 answered the shared dictionary routes
  // under: an older API, asked again only once the account or session changes.
  private sharedDictionaryRoutesMissingFor: number | null = null;
  // The same, for Insights counters. Kept separate so neither kind of work is
  // ever inferred from the other (see nextAmbientEmptyStreak).
  private analyticsPassMovedWork = false;

  private consent(): SyncConsent {
    const policyState = usePolicyStore.getState();
    return resolveSyncConsent({
      authValidated: hasValidatedAuthContext(),
      signedIn: localStorage.getItem("isSignedIn") === "true",
      backupEnabled: localStorage.getItem("cloudBackupEnabled") === "true",
      subscribed: readIsSubscribed(),
      backupAllowedByPolicy: isCloudBackupAllowed(policyState),
      dataRetentionEnabled: effectiveLocalHistoryEnabled(
        policyState,
        localStorage.getItem("dataRetentionEnabled") !== "false"
      ),
      insightsSyncEnabled: localStorage.getItem("insightsSyncEnabled") === "true",
    });
  }

  canSync(): boolean {
    return this.consent().backup;
  }

  // False once the sign-in a pass started under is no longer the validated
  // one. Outside a pass there is nothing to outlive.
  private passIsCurrent(): boolean {
    return this.passGeneration === null || getValidatedAuthGeneration() === this.passGeneration;
  }

  private canSyncSharedNotes(): boolean {
    return this.consent().shared;
  }

  // Team-space membership is per-space consent on the same terms as sharing.
  private canSyncTeamSpaces(): boolean {
    return this.consent().shared;
  }

  // Whether the API supports team scope (GET /api/me/teams deployed); probed
  // by syncSpaces and cached for the UI gate (useTeamSpacesCapability).
  private hasTeamSpacesCapability(): boolean {
    return readTeamSpacesCapability();
  }

  private ambientTeamPassDue(): boolean {
    return shouldRunAmbientTeamOnlyPass({
      emptyStreak: Number(localStorage.getItem("teamOnlyPass.emptyStreak") ?? 0),
      lastPassAt: Number(localStorage.getItem("teamOnlyPass.lastAt")) || null,
      now: Date.now(),
    });
  }

  // Recorded only for team-only passes: a full pass runs on the backup
  // schedule regardless, and letting it clear the streak would restart the
  // 5-minute cadence the moment backup was switched off.
  private recordTeamOnlyPass(): void {
    const streak = Number(localStorage.getItem("teamOnlyPass.emptyStreak") ?? 0);
    localStorage.setItem(
      "teamOnlyPass.emptyStreak",
      String(
        nextAmbientEmptyStreak(streak, {
          team: this.teamPassMovedWork,
          analytics: this.analyticsPassMovedWork,
        })
      )
    );
    localStorage.setItem("teamOnlyPass.lastAt", String(Date.now()));
  }

  private cacheTeamSpacesCapability(available: boolean): void {
    writeTeamSpacesCapability(available);
    localStorage.setItem("teamSpacesCapability.probedAt", new Date().toISOString());
  }

  // Sign-out clears account-scoped renderer/session state without deleting
  // workspace-owned rows. The main-process account scope hides those rows as
  // soon as the bearer token is cleared.
  async purgeTeamSpacesForSignOut(): Promise<void> {
    // Wait for the sync lock so an in-flight pass cannot repopulate renderer
    // state after this account boundary has been cleared.
    try {
      await navigator.locks.request(SYNC_ALL_LOCK, () => this.clearTeamSpaceSessionState());
    } catch (err) {
      console.error("Sign-out cleanup could not take the sync lock:", err);
      // Never block sign-out: clear session state even if the lock failed.
      await this.clearTeamSpaceSessionState();
    }
  }

  /**
   * Marker-less upgrades cannot trust legacy auth flags. Under the same lock
   * as normal sync, prove local team rows against the candidate account and
   * destructively remove only rows that account cannot access.
   */
  async verifyTeamSpacesForAccount(authGeneration: number): Promise<number> {
    let purgedCount = 0;
    await navigator.locks.request(SYNC_ALL_LOCK, async () => {
      await assertAuthGenerationCurrent(authGeneration);
      const remoteSpaces = await SpacesService.mySpacesForAuthValidation(authGeneration);
      await assertAuthGenerationCurrent(authGeneration);
      await prunePurgedSpaceIds(new Set(remoteSpaces.map((space) => space.id)));
      await upsertCloudSpaces(remoteSpaces);
      await assertAuthGenerationCurrent(authGeneration);
      let localSpaces = (await window.electronAPI.getSpaces?.()) ?? [];
      const localTeamSpaces = localSpaces.filter((space) => space.kind === "team");
      const initial = partitionLocalTeamSpaces(localTeamSpaces, remoteSpaces);
      for (const space of initial.unproven) {
        await assertAuthGenerationCurrent(authGeneration);
        const result = await window.electronAPI.purgeSpace?.(space.id, {
          mode: "destructive",
          expectedAuthGeneration: authGeneration,
        });
        if (!result?.success) {
          if (result?.code === "AUTH_CONTEXT_CHANGED") {
            throw new CloudApiError(
              result.error ?? "Authentication context changed during account cleanup",
              0,
              result.code
            );
          }
          throw new Error(`Could not remove unverified team space ${space.id}`);
        }
        purgedCount += 1;
        await assertAuthGenerationCurrent(authGeneration);
      }

      // Re-read instead of trusting best-effort delete results. No membership
      // marker is committed while an inaccessible row remains.
      localSpaces = (await window.electronAPI.getSpaces?.()) ?? [];
      const remaining = partitionLocalTeamSpaces(localSpaces, remoteSpaces);
      if (remaining.unproven.length > 0) {
        throw new Error("Unverified team content remained after account validation");
      }
      await assertAuthGenerationCurrent(authGeneration);
    });
    return purgedCount;
  }

  private async clearTeamSpaceSessionState(): Promise<void> {
    clearTeamSpacesCapability();
    localStorage.removeItem("teamSpacesCapability.probedAt");
    localStorage.removeItem("lastSyncedAt.notes.team");
    localStorage.removeItem("lastSyncedAt.folders.team");
    // The next account must establish its own remote membership view.
    localStorage.removeItem(PURGED_SPACE_GUARD_KEY);
    // Pre-spaces guard key; stale entries are meaningless now.
    localStorage.removeItem("purgedTeamIds");
    // Both hold account-scoped/local numeric ids that collide across accounts.
    localStorage.removeItem("activeWorkspaceId");
    localStorage.removeItem(ACTIVE_WORKSPACE_SOURCE_KEY);
    localStorage.removeItem("notesTree.expanded");
    // Sign-out can happen offline, before the auth reconcile that resets the workspace store.
    localStorage.removeItem(WORKSPACE_LIST_CACHE_KEY);
    // Shared lists and hides belong to the departing account. The arrival
    // toast's flags are keyed by account and stay, so it never repeats.
    removeLocalStorageKeysWithPrefix(SHARED_DICTIONARY_CURSOR_PREFIX);
    localStorage.removeItem(SHARED_DICTIONARY_CAPABILITY_KEY);
    useSharedDictionaryStore.getState().resetForAccountChange();
    try {
      await window.electronAPI?.clearSharedDictionary?.();
    } catch (err) {
      // Never block sign-out; the cleared cursors make the next account
      // snapshot (and replace) whatever is left.
      console.error("Shared dictionary cleanup failed:", err);
    }
  }

  // A deleted account's sync bookkeeping; it holds ids and timestamps only.
  forgetAccount(accountId: string): void {
    localStorage.removeItem(`${SYNC_CURSOR_SAVED_PREFIX}${accountId}`);
    for (const prefix of [
      "syncCursors.privateBackup:",
      "syncCursors.privatePlacement:",
      "syncCursors.privatePlacementCandidates:",
      CHAT_MESSAGE_REPAIR_PREFIX,
    ])
      localStorage.removeItem(`${prefix}${accountId}`);
    // While it is the cursor owner its cursors are the live ones, and the next
    // account's claim would file them back under its id.
    if (localStorage.getItem(SYNC_CURSOR_ACCOUNT_KEY) === accountId) {
      for (const key of ACCOUNT_SYNC_STATE_KEYS) localStorage.removeItem(key);
      localStorage.removeItem(SYNC_CURSOR_ACCOUNT_KEY);
      this.noteFeedReplayTried.clear();
    }
    if (localStorage.getItem(UNOWNED_CURSORS_ACCOUNT_KEY) === accountId) {
      localStorage.removeItem(UNOWNED_CURSORS_ACCOUNT_KEY);
      localStorage.removeItem(UNOWNED_CLAIM_PROGRESS_KEY);
    }
    localStorage.removeItem(`${ORPHANED_CHAT_CREATES_PREFIX}${accountId}`);
    for (const kind of ["dictionary", "snippets"] as const) {
      localStorage.removeItem(parked404Key(kind, accountId));
    }
    for (const kind of PARKED_DELETE_KINDS) {
      localStorage.removeItem(parkedDeleteKey(kind, accountId));
    }
    for (const rows of ["personal", "team"]) {
      localStorage.removeItem(`${FOLDER_PARENTS_BACKFILLED_KEY}.${rows}.${accountId}`);
    }
  }

  // Pulls send their cursor as `since`, so another account's cursors would
  // skip every row this account changed before them. Each account gets its
  // own cursors back when it returns: a cursor-less pull lists live rows only
  // and would miss deletes made meanwhile. Cursors stamped before the
  // account was recorded stay with whoever syncs first, which then checks
  // them once in backfillUnownedCursors(). Callers hold SYNC_ALL_LOCK, and a
  // request that waited out an account switch claims nothing: it would stash
  // the new account's cursors under the old one.
  private claimSyncCursors(accountId: string, authGeneration: number): boolean {
    if (
      getValidatedAuthGeneration() !== authGeneration ||
      getAuthRequestContextSnapshot().sessionUserId !== accountId
    ) {
      return false;
    }
    const owner = localStorage.getItem(SYNC_CURSOR_ACCOUNT_KEY);
    if (owner === accountId) return true;
    if (owner !== null) {
      const ownerCursors: Record<string, string> = {};
      for (const key of ACCOUNT_SYNC_STATE_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) ownerCursors[key] = value;
      }
      localStorage.setItem(`${SYNC_CURSOR_SAVED_PREFIX}${owner}`, JSON.stringify(ownerCursors));
    }
    const savedKey = `${SYNC_CURSOR_SAVED_PREFIX}${accountId}`;
    const savedState = localStorage.getItem(savedKey);
    // Deleting the cursor owner leaves other accounts' saved state intact.
    if (owner !== null || savedState !== null) {
      let saved: Record<string, unknown> = {};
      try {
        saved = JSON.parse(savedState ?? "{}") ?? {};
      } catch {
        // A corrupt entry only costs this account a cursor-less pull.
      }
      for (const key of ACCOUNT_SYNC_STATE_KEYS) {
        const value = saved[key];
        if (typeof value === "string") localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      }
      localStorage.removeItem(savedKey);
      // The once-a-session replay guard was the previous account's.
      this.noteFeedReplayTried.clear();
    } else if (SYNC_CURSOR_KEYS.some((key) => localStorage.getItem(key) !== null)) {
      localStorage.setItem(UNOWNED_CURSORS_ACCOUNT_KEY, accountId);
      // An unowned personal cursor may have advanced under another account.
      // Replay tombstones too; a live-row snapshot cannot remove stale copies.
      localStorage.removeItem("lastSyncedAt.notes");
      if (localStorage.getItem("lastSyncedAt.folders") !== null) {
        localStorage.setItem("lastSyncedAt.folders", FEED_START);
      }
    }
    localStorage.setItem(SYNC_CURSOR_ACCOUNT_KEY, accountId);
    return true;
  }

  private readUnownedClaimProgress(): UnownedClaimProgress {
    const stored = this.readLocalRecord<unknown>(UNOWNED_CLAIM_PROGRESS_KEY);
    return {
      done: Array.isArray(stored.done)
        ? stored.done.filter((table): table is string => typeof table === "string")
        : [],
      failures: Number(stored.failures) || 0,
      retryAt: Number(stored.retryAt) || 0,
    };
  }

  // Unowned cursors may be another account's, and they're already past every
  // row an older build left unattributed, so a delta would never reach those
  // rows to claim them. One snapshot pull of the account's rows does both;
  // snapshots leave the cursors alone, so deletes keep arriving through them.
  // Each table's snapshot counts once it completes. The marker stays until all
  // have, and every pass that leaves one outstanding makes the next attempt
  // wait longer: a table that fails every time must not walk the cloud again
  // on every pass.
  private async backfillUnownedCursors(accountId: string): Promise<void> {
    if (localStorage.getItem(UNOWNED_CURSORS_ACCOUNT_KEY) !== accountId) return;
    const progress = this.readUnownedClaimProgress();
    if (Date.now() < progress.retryAt) return;
    const otherAccount = await window.electronAPI.hasOtherAccountRows?.();
    const claimsRows = otherAccount || (await window.electronAPI.hasUnclaimedLegacyRows?.());
    const snapshots: Array<[table: string, pull: () => Promise<boolean>]> = [];
    if (otherAccount) {
      snapshots.push(["folders", () => this.pullFolders(false, true)]);
      snapshots.push(["notes", () => this.pullNotes(false, true)]);
    }
    if (claimsRows) {
      snapshots.push(["conversations", () => this.pullConversations(true)]);
      snapshots.push(["transcriptions", () => this.pullTranscriptions(true)]);
      snapshots.push(["dictionary", () => this.pullDictionary(true)]);
      snapshots.push(["snippets", () => this.pullSnippets(true)]);
    }

    const done = new Set(progress.done);
    let outstanding = false;
    for (const [table, pull] of snapshots) {
      if (done.has(table)) continue;
      // A note files into a folder its snapshot must have brought first.
      const ready = table !== "notes" || done.has("folders");
      if (ready && (await pull())) {
        done.add(table);
        this.writeLocalRecord(UNOWNED_CLAIM_PROGRESS_KEY, { ...progress, done: [...done] });
      } else {
        outstanding = true;
      }
      // A pull the sign-in ended under says nothing about the table.
      if (!this.passIsCurrent()) return;
    }
    if (!outstanding) {
      localStorage.removeItem(UNOWNED_CURSORS_ACCOUNT_KEY);
      localStorage.removeItem(UNOWNED_CLAIM_PROGRESS_KEY);
      return;
    }
    // The first failed pass retries on the next one, as a dropped connection
    // deserves; after that the wait doubles.
    const failures = progress.failures + 1;
    const wait =
      failures > 1
        ? Math.min(UNOWNED_CLAIM_RETRY_MS * 2 ** (failures - 2), UNOWNED_CLAIM_MAX_RETRY_MS)
        : 0;
    this.writeLocalRecord(UNOWNED_CLAIM_PROGRESS_KEY, {
      done: [...done],
      failures,
      retryAt: wait ? Date.now() + wait : 0,
    });
  }

  // One pass over an account's queued deletes of one kind. A delete the cloud
  // did not confirm ends only when the copy can't be in another account's
  // cloud: the row is the account's own, or unattributed on a device nobody
  // else has used. Any other is parked (see PARKED_DELETE_PREFIX).
  private openDeleteQueue(kind: ParkedDeleteKind, accountId: string | null) {
    const key = parkedDeleteKey(kind, accountId);
    const parked = this.readLocalRecord<true>(key);
    const stillParked: Record<string, true> = {};
    let sharedDevice: boolean | undefined;
    return {
      isParked: (row: QueuedDelete): boolean => {
        if (!row.cloud_id || !parked[row.cloud_id]) return false;
        stillParked[row.cloud_id] = true;
        return true;
      },
      endsUnconfirmed: async (row: QueuedDelete): Promise<boolean> => {
        if (row.account_id) return row.account_id === accountId;
        sharedDevice ??= Boolean(await window.electronAPI.hasOtherAccountRows?.());
        if (sharedDevice && row.cloud_id) stillParked[row.cloud_id] = true;
        return !sharedDevice;
      },
      save: (): void => {
        if (Object.keys(parked).length > 0 || Object.keys(stillParked).length > 0) {
          this.writeLocalRecord(key, stillParked);
        }
      },
    };
  }

  // lastSyncedAt is written only when a syncAll() pass completes, and
  // localStorage is shared across windows, so it doubles as the global
  // "last completed sync" stamp for throttling.
  private lastCompletedSyncAt(): number {
    const iso = localStorage.getItem("lastSyncedAt");
    return iso ? Date.parse(iso) : 0;
  }

  // Runs in every window for the whole session; the throttle and Web Lock
  // dedupe across windows.
  startAutoSync(): void {
    if (this.autoSyncStarted) return;
    this.autoSyncStarted = true;

    this.requestSyncAll("start");
    window.addEventListener("focus", () => this.requestSyncAll("focus"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.requestSyncAll("focus");
      }
    });
    window.addEventListener("online", () => this.requestSyncAll("online"));
    // storage events fire only in the windows that didn't write the change,
    // which is exactly where a first sync is still needed.
    window.addEventListener("storage", (e) => {
      if (e.key && CAN_SYNC_KEYS.includes(e.key)) {
        this.requestSyncAll("start");
      }
    });
    // Storage events only fire in other windows; the window that flips the
    // subscription flag itself (post-checkout refetch, invite acceptance)
    // kicks a pass through the reactive flag instead.
    subscribeIsSubscribed(() => this.requestSyncAll("start"));
    usePolicyStore.subscribe((policyState, previousPolicyState) => {
      if (cloudBackupResumed(previousPolicyState, policyState)) this.requestSyncAll("start");
    });
    // A workspace this device has no mirror of would otherwise show no shared
    // words until the next interval. The store's own subscription was added at
    // import, so it has already moved to the new generation when this runs.
    useWorkspaceStore.subscribe((state, previous) => {
      if (state.activeWorkspaceId && state.activeWorkspaceId !== previous.activeWorkspaceId) {
        void this.syncSharedDictionaryNow();
      }
    });
    setInterval(() => this.requestSyncAll("interval"), AUTO_SYNC_INTERVAL_MS);
  }

  // Called by noteStore when a note opens or closes: while one is open, keep an
  // extra fast pull running so remote edits land in seconds. Reuses
  // requestSyncAll, so the shared throttle and cross-window lock still bound the
  // real passes — this only adds a recurring trigger.
  setNoteOpen(open: boolean): void {
    if (!open) {
      if (this.openNoteSyncTimer) {
        clearInterval(this.openNoteSyncTimer);
        this.openNoteSyncTimer = null;
      }
      return;
    }
    this.requestSyncAll("interval");
    if (this.openNoteSyncTimer) return;
    this.openNoteSyncTimer = setInterval(
      () => this.requestSyncAll("interval"),
      OPEN_NOTE_SYNC_INTERVAL_MS
    );
  }

  private scheduleTeamSpacesRetry(): void {
    if (this.teamSpacesRetryTimer) return;
    const delay = Math.min(
      TEAM_SPACES_RETRY_MS * 2 ** this.teamSpacesRetryAttempt,
      TEAM_SPACES_MAX_RETRY_MS
    );
    this.teamSpacesRetryAttempt++;
    this.teamSpacesRetryTimer = setTimeout(() => {
      this.teamSpacesRetryTimer = null;
      this.requestSyncAll("retry");
    }, delay);
  }

  async syncAll(waitForLock = false): Promise<void> {
    let full = this.canSync();
    if (!full && !this.canSyncTeamSpaces()) return;
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null) return;
    // A pass already running may have synced past the data this request covers,
    // so flag a re-run instead of dropping it.
    if (this.syncing) {
      this.syncAllPending = true;
      return;
    }
    this.syncing = true;
    this.teamPassMovedWork = false;
    this.analyticsPassMovedWork = false;
    let teamSpacesReady = false;
    try {
      // Ambient passes skip when another window holds the lock — that pass
      // reads the same local DB and cloud state, so it covers this request.
      // Manual passes wait so a user action is never silently dropped.
      await navigator.locks.request(SYNC_ALL_LOCK, { ifAvailable: !waitForLock }, async (lock) => {
        if (!lock || !this.claimSyncCursors(accountId, authGeneration)) return;
        this.passGeneration = authGeneration;
        teamSpacesReady = await this.syncSpaces(authGeneration);
        if (!this.passIsCurrent()) return;
        if (this.consent().shared) {
          await checkStandInOwnership({
            accountId,
            authGeneration,
            isCurrent: () =>
              this.passIsCurrent() && getAuthRequestContextSnapshot().sessionUserId === accountId,
          }).catch((err) => console.error("Ownership check failed:", err));
          if (!this.passIsCurrent()) return;
        }
        // Both branches below: shared lists follow membership, not cloud backup.
        const dictionaryGeneration = useSharedDictionaryStore.getState().generation;
        const sharedResult = await this.syncSharedDictionary(authGeneration);
        let personalSucceeded = true;
        if (!this.passIsCurrent()) return;
        this.dropFastClockCursors();
        full = this.canSync();
        if (full) {
          const personalCursorVersion = `syncCursors.privateBackup:${accountId}`;
          if (localStorage.getItem(personalCursorVersion) !== "1") {
            localStorage.removeItem("lastSyncedAt.notes");
            localStorage.setItem("lastSyncedAt.folders", FEED_START);
            localStorage.setItem(personalCursorVersion, "1");
          }
          if (this.canSync()) await this.backfillUnownedCursors(accountId);
          if (!this.passIsCurrent()) return;
          await this.backfillPrivatePlacement(accountId, authGeneration);
          if (!this.passIsCurrent()) return;
          await this.syncFolders(!this.canSync());
          if (!this.passIsCurrent()) return;
          await this.syncNotes(!this.canSync());
          if (!this.passIsCurrent()) return;
          await this.relocatePulledPrivateWorkspaces(accountId, authGeneration);
          if (!this.passIsCurrent()) return;
          if (this.canSync()) await this.syncConversations(accountId);
          if (!this.passIsCurrent()) return;
          if (this.canSync()) await this.syncTranscriptions();
          if (!this.passIsCurrent()) return;
          this.dictionaryDirty = true;
          this.snippetsDirty = true;
          this.skillsDirty = true;
          if (!(await this.syncDirtyLibraries())) personalSucceeded = false;
        } else {
          // Backup is off: team-space content still syncs (membership is
          // consent, D7) and note deletes still propagate so revoked/deleted
          // shared notes stop being served (edits flow via debouncedPush).
          await this.syncFolders(true);
          if (!this.passIsCurrent()) return;
          await this.syncNotes(true);
        }
        if (!this.passIsCurrent()) return;
        // Outside the branch above: Insights uploads ride their own opt-in,
        // while queued erasures run for every authenticated account.
        await this.syncAnalytics();
        if (!(await this.syncDirtyLibraries())) personalSucceeded = false;
        if (!this.passIsCurrent()) return;
        if (personalSucceeded && sharedResult !== "failed" && (full || sharedResult === "synced")) {
          useSharedDictionaryStore.getState().markSynced(dictionaryGeneration);
        }
        // Stamped after the push, so a pass that moved counters is recorded as
        // work rather than as another empty one. A pass that loses auth before
        // reaching here now leaves the streak unstamped where it used to stamp
        // it, which only makes the next pass due immediately -- the right answer
        // after an interruption.
        if (!full) this.recordTeamOnlyPass();
        if (!this.passIsCurrent()) return;
        if (teamSpacesReady) {
          if (this.teamSpacesRetryTimer) {
            clearTimeout(this.teamSpacesRetryTimer);
            this.teamSpacesRetryTimer = null;
          }
          this.teamSpacesRetryAttempt = 0;
        } else {
          // A failed team probe must not wait for the five-minute interval;
          // the backoff retry bypasses the throttle the stamp below feeds.
          this.scheduleTeamSpacesRetry();
        }
        // Stamped even when the team probe failed: ambient triggers stay
        // throttled while the dedicated retry handles probe recovery.
        localStorage.setItem("lastSyncedAt", new Date().toISOString());
      });
    } catch (err) {
      if (isAuthContextError(err)) return;
      console.error("Sync failed:", err);
      // A throw mid-pass skips the retry scheduling above; recover discovery
      // only when this pass never confirmed the team probe.
      if (!teamSpacesReady && this.canSyncTeamSpaces()) this.scheduleTeamSpacesRetry();
    } finally {
      this.syncing = false;
      this.passGeneration = null;
    }
    // Work this pass deferred is owed, so it waits for a lock another window took meanwhile.
    if (this.syncAllPending) {
      this.syncAllPending = false;
      await this.syncAll(true);
    }
  }

  requestSyncAll(
    reason: "start" | "focus" | "interval" | "online" | "manual" | "team-push" | "retry"
  ): void {
    if (!this.canSync() && !this.canSyncSharedNotes()) return;
    const waitForLock = reason === "manual" || reason === "retry";
    // An older client may have just stamped the global sync time without ever
    // probing team spaces. The upgrade's first probe must bypass that throttle;
    // it stays ambient so another window holding the lock can cover it.
    const firstTeamSpacesProbe =
      reason === "start" &&
      this.canSyncTeamSpaces() &&
      localStorage.getItem("teamSpacesCapability.probedAt") == null;
    // A leaderboard opt-out is a user-requested account mutation, not ambient
    // sync work. Retry it on the next trigger even when an otherwise idle
    // collaboration-only pass has backed off. That priority is spent after a
    // few undelivered attempts: an opt-out that can never land keeps being
    // retried, but stops disabling the throttle, the in-flight guard and the
    // ambient backoff for the life of the install.
    const sessionUserId = getAuthRequestContextSnapshot().sessionUserId;
    const pendingLeaderboardLeave =
      sessionUserId != null && pendingLeaderboardLeaveDeservesPriority(sessionUserId);
    const bypassThrottle = waitForLock || firstTeamSpacesProbe || pendingLeaderboardLeave;
    if (
      !bypassThrottle &&
      (this.syncing || Date.now() - this.lastCompletedSyncAt() < AUTO_SYNC_THROTTLE_MS)
    ) {
      return;
    }
    // A team-only pass with nothing to move backs off; a local push
    // ("team-push") and anything the user asked for are never held back.
    if (
      !bypassThrottle &&
      reason !== "team-push" &&
      !this.canSync() &&
      !this.ambientTeamPassDue()
    ) {
      return;
    }
    void this.syncAll(waitForLock);
  }

  async syncDictionaryNow(): Promise<DictionarySyncResult> {
    return this.syncLibraryNow("dictionary");
  }

  // A pass requested while an edit waited for the lock was deferred to it.
  private async runDeferredSyncAll(): Promise<void> {
    if (!this.syncAllPending) return;
    this.syncAllPending = false;
    await this.syncAll(true);
  }

  // The Dictionary page's Sync button. Waits for the sync lock rather than
  // flagging a re-run: a running syncAll() may already be past its shared pass.
  async syncSharedDictionaryNow(): Promise<DictionarySyncResult> {
    if (!this.canSyncTeamSpaces()) return "skipped";
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null) return "skipped";
    try {
      return await navigator.locks.request(SYNC_ALL_LOCK, () =>
        // Its one-time backfill drops the personal dictionary cursor.
        this.claimSyncCursors(accountId, authGeneration)
          ? this.syncSharedDictionary(authGeneration)
          : "skipped"
      );
    } catch (err) {
      if (isAuthContextError(err)) return "skipped";
      console.error("Shared dictionary sync failed:", err);
      return "failed";
    }
  }

  async syncSnippetsNow(): Promise<void> {
    await this.syncLibraryNow("snippets");
  }

  async syncSkillsNow(): Promise<void> {
    await this.syncLibraryNow("skills");
  }

  private async syncLibraryNow(
    kind: "dictionary" | "snippets" | "skills"
  ): Promise<DictionarySyncResult> {
    if (!this.canSync()) return "skipped";
    this[`${kind}Dirty`] = true;
    if (this.syncing) return "skipped";
    // Edits sync right away, possibly before this account's first syncAll()
    // claimed the shared cursors, so they claim them under the same lock.
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null) return "skipped";
    this.syncing = true;
    let result: DictionarySyncResult;
    try {
      // Immediate writes share the full pass's lock across renderer windows. Read pending
      // rows only after acquiring it, so an older upload cannot follow a newer one.
      result = await navigator.locks.request(SYNC_ALL_LOCK, async () => {
        if (!this.claimSyncCursors(accountId, authGeneration)) return "skipped";
        this.passGeneration = authGeneration;
        if (!this.canSync()) return "skipped";
        return (await this.syncDirtyLibraries()) ? "synced" : "failed";
      });
    } catch (err) {
      result = isAuthContextError(err) ? "skipped" : "failed";
      if (!isAuthContextError(err)) console.error("Library sync failed:", err);
    } finally {
      this.syncing = false;
      this.passGeneration = null;
    }
    await this.runDeferredSyncAll();
    return result;
  }

  private async syncDirtyLibraries(): Promise<boolean> {
    let dictionarySucceeded = true;
    // A write may arrive during a different library's pass, including one already visited.
    while (
      this.passIsCurrent() &&
      this.canSync() &&
      (this.dictionaryDirty || this.snippetsDirty || this.skillsDirty)
    ) {
      for (const kind of ["dictionary", "snippets", "skills"] as const) {
        if (!this.passIsCurrent() || !this.canSync()) return dictionarySucceeded;
        if (!this[`${kind}Dirty`]) continue;
        this[`${kind}Dirty`] = false;
        if (kind === "dictionary") {
          if (!(await this.syncDictionary())) dictionarySucceeded = false;
        } else if (kind === "snippets") await this.syncSnippets();
        else await this.syncSkills();
      }
    }
    return dictionarySucceeded;
  }

  debouncedPush(entityType: string, entityId: number): void {
    const canPushWithoutBackup =
      entityType === "note"
        ? this.canSyncSharedNotes()
        : entityType === "folder" && this.canSyncTeamSpaces();
    if (!this.canSync() && !canPushWithoutBackup) return;
    const key = `${entityType}:${entityId}`;
    const existing = this.pushTimers.get(key);
    if (existing) clearTimeout(existing);
    this.pushTimers.set(
      key,
      setTimeout(() => {
        this.pushTimers.delete(key);
        this.pushEntity(entityType, entityId).catch(console.error);
      }, PUSH_DEBOUNCE_MS)
    );
  }

  private async pushEntity(entityType: string, entityId: number): Promise<void> {
    if (!this.canSync()) {
      // Shared notes and team-space notes/folders push without the backup
      // toggle. Personal folders still require backup consent.
      if (entityType === "folder") {
        if (!this.canSyncTeamSpaces()) return;
        const folders = (await window.electronAPI.getFolders?.()) ?? [];
        const folder = folders.find((candidate) => candidate.id === entityId);
        if (!folder) return;
        const ctx = await this.buildSpaceContext();
        // A folder that just left a team still owes its scope retraction (D6):
        // the server row stays visible to teammates until the PATCH lands.
        const leftTeam = !!folder.left_team && !!folder.cloud_id;
        if (ctx.byId.get(folder.space_id)?.kind !== "team" && !leftTeam) return;
        return this.pushFolder(entityId);
      }
      if (entityType === "note") {
        if (!this.canSyncSharedNotes()) return;
        const note = await window.electronAPI.getNote?.(entityId);
        if (!note) return;
        if (!note.is_shared) {
          const ctx = await this.buildSpaceContext();
          // A note that just left a team still owes its scope retraction (D6):
          // the server row stays visible to teammates until the PATCH lands.
          const leftTeam = !!note.left_team && !!note.cloud_id;
          if (ctx.byId.get(note.space_id)?.kind !== "team" && !leftTeam) return;
        }
        return this.pushNote(entityId);
      }
      return;
    }
    switch (entityType) {
      case "folder":
        return this.pushFolder(entityId);
      case "note":
        return this.pushNote(entityId);
      case "conversation":
        return this.pushConversation(entityId);
      case "transcription":
        return this.pushTranscription(entityId);
    }
  }

  private async pushFolder(id: number): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    await this.ensurePrivatePlacementCapability();
    const folders = (await window.electronAPI.getFolders?.()) ?? [];
    const folder = folders.find((f) => f.id === id);
    if (!folder) return;
    if (
      this.couldFlattenBeforeBackfill(folder) &&
      this.owedFolderParentBackfills(!this.canSync()).length > 0
    ) {
      // It stays pending for the full pass, which backfills first.
      this.requestSyncAll("interval");
      return;
    }

    const ctx = await this.buildSpaceContext();
    const scope = this.resolvePushScope("folder", folder, ctx);
    if (!scope) return;
    const folderMap = await this.buildLocalToCloudFolderMap(ctx);
    const parentFolderId = this.cloudParentFolderId(folder, folderMap);
    // The parent hasn't reached the cloud yet; a full pass pushes it first.
    if (parentFolderId === undefined) return;

    if (folder.cloud_id) {
      if (nestingStillOwed(folder, folderMap)) return;
      try {
        await FoldersService.update(
          folder.cloud_id,
          {
            name: folder.name,
            sort_order: folder.sort_order,
            parent_folder_id: parentFolderId,
            ...folderPushScope(scope, parentFolderId),
          },
          authGeneration
        );
        // Settle like the batch path: a delivered row left pending would both
        // block its notes' pushes (blockedFolderIds) and re-PATCH stale state
        // over a teammate's newer rename on the next pass. Guarded settle: a
        // rename landing mid-flight stays pending so it still pushes (a blind
        // settle would let the next pull's LWW revert it). A withheld parent
        // keeps the row pending until it can be sent.
        await window.electronAPI.markFolderSyncedIfUnchanged?.(
          folder.id,
          withSentParent(folder, parentFolderId),
          folder.cloud_id,
          authGeneration
        );
        this.recordFolderPushLanded(folder, parentFolderId);
      } catch (err) {
        if (isFolderNameTakenError(err)) {
          this.recordFolderRefused(folder);
        } else if (isInvalidParentFolderError(err)) {
          await this.unnestRefusedFolder(folder, authGeneration);
        } else if (isPermissionDenialError(err)) {
          await this.handleDeniedFolderUpdate(folder, ctx);
          await this.restoreDeniedRows("folder");
        } else if (isSpaceAccessError(err)) {
          // Recover like the batch path — otherwise a revoked folder edited
          // via the debounce just logs errors until the next full pass.
          await this.handleRevokedFolderPush(folder, ctx);
        } else if (isHttpStatus(err, 404)) {
          // Defer to a full pass, whose pull disambiguates and applies the
          // stub-less fallback fork (see handleFolderUpdate404). This debounced
          // push runs outside SYNC_ALL_LOCK, so it must not touch the 404
          // counts; leaving the row unsettled keeps it 'pending' for that pass.
          return;
        } else {
          throw err;
        }
      }
    } else {
      await this.pushFreshFolder(folder, scope, parentFolderId, ctx, authGeneration);
    }
  }

  // A parent travels as its cloud id: null for a top-level folder, undefined
  // while the parent has no cloud id yet or has unpushed changes (the
  // subfolder's push waits for it, since the server refuses a subfolder whose
  // parent's space move hasn't landed, and a Private parent's placement PATCH
  // must land before its subfolder goes up beside it). A folder leaving a team
  // never waits and retracts top-level, since the server refuses a parent
  // alongside the move while the folder still has team subfolders there; the
  // row stays pending, so its nesting goes up on a later pass.
  // A parent the server refused for good (a name taken) waits for the user, so
  // its subfolders stop waiting for it: they name its cloud row, still valid for
  // nesting, or go up top-level while it has none, their nesting owed.
  private cloudParentFolderId(
    folder: FolderItem,
    {
      localToCloud,
      blockedFolderIds,
      refusedFolderIds,
    }: Pick<LocalToCloudFolderMap, "localToCloud" | "blockedFolderIds" | "refusedFolderIds">
  ): string | null | undefined {
    if (folder.parent_folder_id == null || folder.left_team) return null;
    if (refusedFolderIds.has(folder.parent_folder_id)) {
      return localToCloud.get(folder.parent_folder_id) ?? null;
    }
    if (blockedFolderIds.has(folder.parent_folder_id)) return undefined;
    return localToCloud.get(folder.parent_folder_id);
  }

  // A folder push the server took: any refusal is over, and a folder sent
  // top-level while nested here owes its nesting alone.
  private recordFolderPushLanded(folder: FolderItem, parentFolderId: string | null): void {
    const refused = this.readLocalRecord<string>(FOLDER_PUSH_REFUSED_KEY);
    if (String(folder.id) in refused) {
      delete refused[folder.id];
      this.writeLocalRecord(FOLDER_PUSH_REFUSED_KEY, refused);
    }
    const owed = this.readLocalRecord<string>(FOLDER_NESTING_OWED_KEY);
    if (parentFolderId === null && folder.parent_folder_id != null) {
      owed[folder.id] = folderPushFingerprint(folder);
    } else if (!(String(folder.id) in owed)) {
      return;
    } else {
      delete owed[folder.id];
    }
    this.writeLocalRecord(FOLDER_NESTING_OWED_KEY, owed);
  }

  // folder_name_taken: the row stays pending and is sent again each pass, in
  // case the clash clears on the server, but tells the user once per refusal.
  private recordFolderRefused(folder: FolderItem): void {
    const refused = this.readLocalRecord<string>(FOLDER_PUSH_REFUSED_KEY);
    const fingerprint = folderRefusalFingerprint(folder);
    if (refused[folder.id] === fingerprint) return;
    refused[folder.id] = fingerprint;
    this.writeLocalRecord(FOLDER_PUSH_REFUSED_KEY, refused);
    this.dispatchFolderNameTaken(folder.name);
  }

  // invalid_parent_folder: un-nest the folder here, which queues it again, so
  // the next push sends it top-level. The write is fenced to the sign-in that
  // pushed it, like the pass's other writes.
  private async unnestRefusedFolder(folder: FolderItem, authGeneration: number): Promise<void> {
    const guard = await window.electronAPI.getNoteWriteGuard?.();
    if (!guard || guard.authGeneration !== authGeneration) return;
    const result = await window.electronAPI.setFolderParent(folder.id, null, guard);
    if (!result?.success) {
      console.warn(`Could not un-nest refused folder ${folder.id}:`, result?.error);
    }
  }

  // Single-folder create shared by the debounced push and the batch-create
  // isolation fallback. On a same-name collision the API returns the WINNER's
  // existing row; adopt its identity (as the batch path does) so later pulls
  // of that row match this folder instead of inserting a colliding duplicate.
  private async createCloudFolder(
    folder: FolderItem,
    scope: PushScopeFields,
    parentFolderId: string | null,
    authGeneration: number
  ): Promise<void> {
    const cloud = await FoldersService.create(
      {
        name: folder.name,
        client_folder_id: folder.client_folder_id,
        is_default: !!folder.is_default,
        sort_order: folder.sort_order,
        parent_folder_id: parentFolderId,
        ...folderPushScope(scope, parentFolderId),
      },
      authGeneration
    );
    await this.acknowledgeCreatedFolder(
      withSentParent(folder, parentFolderId),
      cloud,
      authGeneration
    );
    this.recordFolderPushLanded(folder, parentFolderId);
  }

  // Links a pushed folder to the cloud row its create returned. A Private
  // create the account already has a folder of that name for returns that
  // folder, under its client key. When a row this account can't see holds the
  // key here (the signed-out stand-in's copy, another account's folder), the
  // folder keeps its own key and is found by cloud id, as the pull adopts one;
  // otherwise it would stay unlinked and hold back every note in it. A row the
  // account can see holding the key stays unresolved, so no two of its folders
  // stand for one cloud folder.
  private async acknowledgeCreatedFolder(
    folder: FolderItem,
    cloud: { id: string; client_folder_id: string | null; updated_at: string },
    authGeneration: number
  ): Promise<void> {
    const acknowledge = (clientFolderId: string) =>
      window.electronAPI.acknowledgeFolderCreate?.(
        folder.id,
        folder,
        folder.cloud_id,
        clientFolderId,
        cloud.id,
        cloud.updated_at,
        authGeneration
      );
    const responseKey = cloud.client_folder_id ?? folder.client_folder_id;
    const result = await acknowledge(responseKey);
    if (
      !result ||
      !("outcome" in result) ||
      result.outcome !== "unresolved" ||
      responseKey === folder.client_folder_id
    ) {
      return;
    }
    const [keyHolder, linked] = await Promise.all([
      window.electronAPI.getFolderByClientId?.(responseKey),
      window.electronAPI.getFolderByCloudId?.(cloud.id),
    ]);
    if (keyHolder || (linked && linked.id !== folder.id)) return;
    await acknowledge(folder.client_folder_id);
  }

  // Full note payload for pushes, built on the tested #1290 guard (a
  // content-less PATCH would still bump the cloud row's updated_at and hand
  // the next pull a stale copy to elect). Scope fields ride along so local
  // moves between spaces propagate; the server no-ops them when unchanged.
  private notePushPayload(
    note: NoteItem,
    cloudFolderId: string | null,
    scope: PushScopeFields
  ): ReturnType<typeof buildNoteUpdatePayload> & PushScopeFields {
    return { ...buildNoteUpdatePayload(note, cloudFolderId), ...scope };
  }

  private async pushNote(
    id: number,
    sharing?: { note: NoteItem; authGeneration: number }
  ): Promise<void> {
    const authGeneration = sharing?.authGeneration ?? getValidatedAuthGeneration();
    if (authGeneration == null || getValidatedAuthGeneration() !== authGeneration) return;
    await this.ensurePrivatePlacementCapability();
    if (getValidatedAuthGeneration() !== authGeneration) return;
    const denied = await this.withNotePushLock(id, () =>
      this.pushNoteLocked(id, authGeneration, sharing?.note)
    );
    // Its restoring pull waits on note locks, so it runs once this one is free.
    if (denied) await this.restoreDeniedRows("note");
  }

  // Returns true when the server refused the edit and denied rows need restoring.
  private async pushNoteLocked(
    id: number,
    authGeneration: number,
    sharedNote?: NoteItem
  ): Promise<boolean> {
    const note = await window.electronAPI.getNote?.(id);
    if (getValidatedAuthGeneration() !== authGeneration) return false;
    if (
      sharedNote &&
      (!note ||
        note.client_note_id !== sharedNote.client_note_id ||
        note.space_id !== sharedNote.space_id ||
        (sharedNote.cloud_id && note.cloud_id !== sharedNote.cloud_id))
    )
      return false;
    // Synced: a pass sent it while this push waited for the lock.
    if (!note || note.sync_status === "synced") return false;
    const ctx = await this.buildSpaceContext();
    if (!(await this.settleOwnNoteConflict(note))) {
      // An unresolved conflict: the editor's debounced push would auto-resolve
      // it as local-wins (or 409-spam) before the user chose Keep or Refresh.
      return false;
    }
    // Until a pass shows the server has no revisions, a clear on a row without
    // a revision waits for the full pass that resolves it.
    if (noteAwaitsCloudResolution(note, this.noteRevisionsKnown !== false)) {
      // Only a full pass resolves it; stay throttled so typing in the note
      // doesn't start one per debounced push.
      this.requestSyncAll("interval");
      return false;
    }

    const folderMap = await this.buildLocalToCloudFolderMap(ctx);
    const releasedFolderIds = this.releaseWaitingFolders(folderMap.waitingFolders);
    const sharingPrivate = !!sharedNote && !isTeamRow(note, ctx);
    if (this.noteWaitsForFolder(note, folderMap, releasedFolderIds) && !sharingPrivate) {
      // The folder's own changes haven't landed (e.g. a cross-space move that
      // 409'd on a name conflict, or a Private folder not uploaded yet): the
      // note retries in the full pass that settles the folder.
      this.requestSyncAll("interval");
      return false;
    }
    const resolvedScope = this.resolvePushScope("note", note, ctx, sharingPrivate);
    if (!resolvedScope) return false;
    // One-note sharing does not consent to uploading or relocating its local folder.
    const cloudFolderId = pushedFolderId(note, folderMap);
    const scope = folderPlacedNoteScope(note, resolvedScope, cloudFolderId, ctx);

    const payload = this.notePushPayload(note, cloudFolderId, scope);
    try {
      if (note.cloud_id) {
        const cloud = await NotesService.update(note.cloud_id, payload, authGeneration);
        // Settle only if the row wasn't edited while the PATCH was in flight;
        // a blind settle would leave the delivered snapshot pending and let a
        // later pass re-PATCH it over a teammate's newer edit.
        await window.electronAPI.markNoteSyncedIfUnchanged?.(
          note.id,
          note,
          note.cloud_id,
          cloud.updated_at,
          cloud.user_id ?? null,
          cloud.revision ?? null,
          cloud,
          authGeneration
        );
      } else {
        await this.createCloudNote(note, cloudFolderId, scope, authGeneration, sharingPrivate);
      }
    } catch (err) {
      if (isNoteVersionConflictError(err)) {
        // Another device wrote first. The row stays pending and the banner
        // asks the user to Refresh or Keep; no requestSyncAll echo.
        const cloudNote = conflictCloudNote(err);
        if (
          cloudNote &&
          !(note.cloud_id && (await this.pushAgainIfOnlyMoved(note, payload, cloudNote)))
        )
          await this.surfaceNoteConflict(note.client_note_id, cloudNote);
        return false;
      }
      if (isPermissionDenialError(err)) {
        await this.handleDeniedNoteUpdate(note, ctx);
        return true;
      }
      if (isSpaceAccessError(err)) {
        await this.handleRevokedNotePush(note, ctx);
        return false;
      }
      if (isHttpStatus(err, 404) && note.cloud_id) {
        // Defer to a full pass, whose pull disambiguates and applies the
        // stub-less fallback fork (see handleNoteUpdate404). This debounced
        // single push runs outside SYNC_ALL_LOCK, so it must not touch the
        // 404 counts; marking 'error' re-queues the row for that pass.
        await window.electronAPI.markNoteSyncError?.(note.id);
        return false;
      }
      throw err;
    }
    // A push into a team must reach teammates fast; a pull may also carry
    // their concurrent edits back (throttled like other ambient triggers).
    if (scope.space_id) this.requestSyncAll("team-push");
    return false;
  }

  // Single-note create shared by the debounced push and the batch-create
  // isolation fallback. The returned row carries the server-assigned owner
  // (user_id), persisted so the UI can tell "my note" from a teammate's.
  private async renewTeamPublicationFromPersonalTombstone(
    note: NoteItem,
    cloud: CloudNoteCreateResult,
    generation: number
  ): Promise<boolean> {
    await assertAuthGenerationCurrent(generation);
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    if (
      !accountId ||
      generation == null ||
      !cloud.deleted_at ||
      cloud.access_removed ||
      cloud.space_id !== null ||
      cloud.workspace_id !== null ||
      cloud.user_id !== accountId ||
      cloud.client_note_id !== note.client_note_id ||
      (note.cloud_id && note.cloud_id !== cloud.id) ||
      note.sync_status === "synced" ||
      note.deleted_at ||
      note.folder_delete_pending
    )
      return false;
    const result = await window.electronAPI.renewNoteCloudIdentity?.(
      note.id,
      note.client_note_id,
      note.cloud_id,
      note.space_id,
      generation
    );
    await assertAuthGenerationCurrent(generation);
    if (!result?.success) return false;
    this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
    await this.settleNoteConflict(note.client_note_id);
    if (this.syncing) this.syncAllPending = true;
    else this.requestSyncAll("retry");
    return true;
  }

  private async acknowledgeCloudNoteCreate(
    note: NoteItem,
    cloud: CloudNoteCreateResult,
    authGeneration: number
  ): Promise<void> {
    if (await this.renewTeamPublicationFromPersonalTombstone(note, cloud, authGeneration)) return;
    const outcome = await resolveRendererCloudNoteCreate(
      note,
      cloud,
      (cloudId) => NotesService.delete(cloudId, authGeneration),
      { expectedAuthGeneration: authGeneration }
    );
    if (outcome === "write-rejected" || outcome === "awaiting-cloud") this.requestSyncAll("retry");
  }

  private async createCloudNote(
    note: NoteItem,
    cloudFolderId: string | null,
    scope: PushScopeFields,
    authGeneration: number,
    sharingPrivateNote = false
  ): Promise<void> {
    const recorded = await recordNoteCreateAttempts([note.client_note_id], authGeneration);
    if (!recorded.has(note.client_note_id)) return;
    if (
      !scope.space_id &&
      !this.canSync() &&
      !sharingPrivateNote &&
      !note.is_shared &&
      !(note.left_team && note.cloud_id)
    )
      return;
    const cloud = await NotesService.create(
      {
        client_note_id: note.client_note_id,
        ...buildNoteCreatePayload(note, cloudFolderId),
        ...scope,
        created_at: note.created_at,
      },
      authGeneration
    );
    await this.acknowledgeCloudNoteCreate(note, cloud, authGeneration);
  }

  // Batch-create fallback row push: recognized terminal rejections settle the
  // row by forking it into Private, with a fresh identity; anything
  // else re-queues as 'error'.
  private async pushFreshNote(
    note: NoteItem,
    scope: PushScopeFields,
    cloudFolderId: string | null,
    ctx: SpaceSyncContext,
    authGeneration: number
  ): Promise<void> {
    try {
      await this.createCloudNote(note, cloudFolderId, scope, authGeneration);
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
        await this.handleRevokedNotePush(note, ctx);
        this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
      } else {
        await window.electronAPI.markNoteSyncError?.(note.id);
      }
    }
  }

  // Sharing requires a cloud copy. Deliberate single-note push that does not
  // depend on the global backup toggle; returns the note's cloud id.
  async ensureNoteSynced(localId: number): Promise<string | null> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return null;
    const note = await window.electronAPI.getNote?.(localId);
    if (!note || getValidatedAuthGeneration() !== authGeneration) return null;
    if (note.cloud_id && note.sync_status === "synced") return note.cloud_id;
    if (!this.canSyncSharedNotes()) return null;
    await this.pushNote(localId, { note, authGeneration });
    if (getValidatedAuthGeneration() !== authGeneration) return null;
    const synced = await window.electronAPI.getNote?.(localId);
    return getValidatedAuthGeneration() === authGeneration &&
      synced?.client_note_id === note.client_note_id &&
      synced?.space_id === note.space_id &&
      (!note.cloud_id || synced?.cloud_id === note.cloud_id) &&
      synced?.sync_status === "synced"
      ? (synced.cloud_id ?? null)
      : null;
  }

  private async acknowledgeConversationCreate(
    localId: number,
    snapshot: ConversationCreateSnapshot,
    cloudId: string,
    sender: ChatPushSender
  ): Promise<void> {
    const result = await window.electronAPI.acknowledgeConversationCreate?.(
      localId,
      snapshot,
      cloudId,
      sender.accountId,
      sender.authGeneration
    );
    if (!result?.success) {
      // The chat stays unlinked, and its next pass finds this copy again.
      console.warn(`Chat ${localId} create ack was refused; the cloud copy is ${cloudId}`);
      return;
    }

    if (result.outcome === "changed") {
      await this.sendMissingConversationContent(localId, cloudId, sender);
      return;
    }

    const shouldDeleteCreate =
      result.outcome === "orphaned" ||
      (result.outcome === "already-linked" && result.cloud_id !== cloudId);
    if (!shouldDeleteCreate) return;
    try {
      await ConversationsService.delete(cloudId, sender.authGeneration);
    } catch (err) {
      // No local row is left to retry an orphan's delete, and only the sender's
      // token can make it, so the copy is queued for a pass under that sign-in.
      if (result.outcome !== "orphaned") throw err;
      const key = `${ORPHANED_CHAT_CREATES_PREFIX}${sender.accountId}`;
      const queued = this.readLocalRecord<true>(key);
      queued[cloudId] = true;
      this.writeLocalRecord(key, queued);
    }
  }

  private async deleteOrphanedChatCreates(sender: ChatPushSender): Promise<void> {
    const key = `${ORPHANED_CHAT_CREATES_PREFIX}${sender.accountId}`;
    const gone: string[] = [];
    for (const cloudId of Object.keys(this.readLocalRecord<true>(key))) {
      try {
        await ConversationsService.delete(cloudId, sender.authGeneration);
      } catch (err) {
        if (!isHttpStatus(err, 404)) {
          if (!isAuthContextError(err)) console.error("Orphaned chat cleanup failed:", err);
          continue;
        }
      }
      gone.push(cloudId);
    }
    if (gone.length === 0) return;
    // A create ack may have queued another copy while these deletes were out (a
    // chat push runs outside the pass lock, and windows share localStorage), so
    // only the copies settled here leave the queue as it is now.
    const queued = this.readLocalRecord<true>(key);
    for (const cloudId of gone) delete queued[cloudId];
    this.writeLocalRecord(key, queued);
  }

  private async canUploadConversation(conversation: LocalConversation): Promise<boolean> {
    const current = await window.electronAPI.getAgentConversation?.(conversation.id);
    if (!current || current.device_only || current.space_id != null || current.folder_id != null)
      return false;
    if (current.note_id == null) return true;
    const context = await this.buildSpaceContext();
    const note = await window.electronAPI.getNote?.(current.note_id);
    if (!note || !isTeamRow(note, context)) return false;
    const latest = await window.electronAPI.getAgentConversation?.(conversation.id);
    return !!latest && !latest.device_only;
  }

  // A create can't carry what's missing, since it inserts its messages again on a
  // chat already in the cloud. Each attempt reads the copy first, so a retry after a
  // failure part way through sends nothing twice. The chat stays pending until
  // the cloud holds what this pass read, so a later edit gets its own attempt.
  // Every request is pinned to the sender's sign-in, as the create was: after an
  // account switch the messages are refused, not sent with the next account's token.
  private async sendMissingConversationContent(
    localId: number,
    cloudId: string,
    sender: ChatPushSender
  ): Promise<void> {
    const local = await window.electronAPI.getAgentConversation?.(localId);
    if (!local || hasTurnInProgress(local) || !(await this.canUploadConversation(local))) return;
    const snapshot = conversationCreateSnapshot(local);
    const { messages: cloudMessages } = await ConversationsService.listMessages(
      cloudId,
      sender.authGeneration
    );
    for (const message of missingConversationMessages(local.messages, cloudMessages)) {
      if (!(await this.canUploadConversation(local))) return;
      await ConversationsService.addMessage(
        cloudId,
        message.role,
        message.content,
        conversationMessageMetadata(message.metadata),
        sender.authGeneration
      );
    }
    if (!(await this.canUploadConversation(local))) return;
    const cloud = await ConversationsService.update(
      cloudId,
      { title: local.title },
      sender.authGeneration
    );
    await window.electronAPI.markConversationSynced?.(
      localId,
      cloudId,
      snapshot,
      cloud.updated_at,
      sender.accountId,
      sender.authGeneration
    );
  }

  // Recorded before the request is sent, so a chat deleted while it is in
  // flight stays a tombstone its late receipt can link. A chat deleted since it
  // was read is not sent.
  private async createCloudConversation(
    full: LocalConversation,
    sender: ChatPushSender
  ): Promise<void> {
    if (!(await this.canUploadConversation(full))) return;
    const recorded = await window.electronAPI.markConversationCreateAttempted?.(
      full.id,
      sender.authGeneration
    );
    if (!recorded?.success) return;
    if (!(await this.canUploadConversation(full))) {
      if (!full.cloud_create_attempted)
        await window.electronAPI.clearConversationCreateAttempted?.(full.id);
      return;
    }
    // An earlier request may have reached the cloud, and a second one would insert
    // its messages again. This one only finds the copy; the messages follow it.
    const messages = full.cloud_create_attempted ? [] : full.messages;
    const snapshot = conversationCreateSnapshot({ ...full, messages });
    let cloud: CloudConversation;
    try {
      cloud = await ConversationsService.create(
        {
          client_conversation_id: full.client_conversation_id ?? String(full.id),
          title: full.title,
          created_at: full.created_at,
          updated_at: full.updated_at,
          parent_client_conversation_id: full.parent_client_conversation_id,
          // A retry's messages follow it without the empty ones, which the messages
          // route refuses, so the copied count names only those the cloud will hold.
          fork_message_count:
            full.cloud_create_attempted && full.fork_message_count
              ? full.messages.slice(0, full.fork_message_count).filter((m) => m.content).length ||
                null
              : full.fork_message_count,
          fork_context: full.fork_context,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            metadata: conversationMessageMetadata(m.metadata),
          })),
        },
        sender.authGeneration
      );
    } catch (err) {
      // This request never left and none went before it, so no cloud copy can
      // exist: the next create carries the messages, and a later delete needn't
      // wait for a receipt.
      if (!full.cloud_create_attempted && wasRefusedBeforeSending(err)) {
        await window.electronAPI.clearConversationCreateAttempted?.(full.id);
      }
      throw err;
    }
    // Create keeps an existing row's tombstone, and that row takes no further
    // writes. Linking it would let the next pull delete this chat, so the chat
    // gets a new identity and the next pass creates a live copy.
    if (cloud.deleted_at) {
      await window.electronAPI.replaceConversationClientId?.(
        full.id,
        snapshot.client_conversation_id,
        sender.accountId,
        sender.authGeneration
      );
      return;
    }
    await this.acknowledgeConversationCreate(full.id, snapshot, cloud.id, sender);
  }

  private async pushConversation(id: number): Promise<void> {
    const sender = chatPushSender();
    if (!sender) return;
    const full = await window.electronAPI.getAgentConversation?.(id);
    if (!full) return;
    if (!(await this.canUploadConversation(full))) return;

    if (full.cloud_id) {
      await ConversationsService.update(
        full.cloud_id,
        { title: full.title },
        sender.authGeneration
      );
    } else if (!hasTurnInProgress(full)) {
      await this.createCloudConversation(full, sender);
    }
  }

  private async pushTranscription(id: number): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const t = await window.electronAPI.getTranscriptionById?.(id);
    // A failed entry stays on this device until a retry completes it.
    if (!t || t.cloud_id || t.status === "failed") return;

    const cloud = await TranscriptionsService.create(
      {
        client_transcription_id: t.client_transcription_id,
        text: t.text,
        raw_text: t.raw_text,
        provider: t.provider,
        model: t.model,
        audio_duration_ms: t.audio_duration_ms,
        status: t.status,
        created_at: t.created_at,
      },
      authGeneration
    );
    await this.acknowledgeTranscriptionCreate(t.id, cloud.id, authGeneration);
  }

  // Personal rows are read under one sign-in, so their pushes are pinned to it
  // (`authGeneration`): after an account switch the request is refused rather
  // than sent with the next account's token, and the ack is dropped.
  private async acknowledgeTranscriptionCreate(
    localId: number,
    cloudId: string,
    authGeneration: number
  ): Promise<void> {
    await window.electronAPI.markTranscriptionSynced?.(localId, cloudId, authGeneration);
  }

  // Runs first in every pass: probes spaces availability, mirrors the caller's
  // cloud spaces into local rows, purges spaces that vanished (deleted,
  // archived, or every assigned team's membership revoked) and backfills new
  // ones.
  private async syncSpaces(authGeneration: number): Promise<boolean> {
    if (!this.canSyncTeamSpaces()) return true;
    let cloudSpaces: MySpace[];
    try {
      cloudSpaces = await this.readSpacesWithCapabilities(authGeneration);
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      // 404 = endpoint not deployed yet (rollout probe): remember and skip
      // silently so pulls and pushes stay personal-only until a probe succeeds.
      if (isHttpStatus(err, 404)) {
        this.cacheTeamSpacesCapability(false);
        this.privatePlacementGeneration = null;
        return true;
      }
      console.error("Spaces fetch failed:", err);
      return false;
    }
    this.cacheTeamSpacesCapability(true);
    if (cloudSpaces.length > 0) this.teamPassMovedWork = true;

    const cloudIds = new Set(cloudSpaces.map((s) => s.id));
    // Spaces confirmed gone can no longer resurrect through pulls — their
    // purge-race guard entries are done.
    await prunePurgedSpaceIds(cloudIds);

    const prior = (await window.electronAPI.getSpaces?.()) ?? [];
    const backfillIds = await upsertCloudSpaces(cloudSpaces);

    for (const space of prior) {
      if (space.kind !== "team" || !space.cloud_space_id || cloudIds.has(space.cloud_space_id)) {
        continue;
      }
      await markSpacePurged(space.cloud_space_id, "revoked");
      const purged = await window.electronAPI.purgeSpace?.(space.id, {
        expectedAuthGeneration: authGeneration,
      });
      if (!purged?.success) {
        if (purged?.code === "AUTH_CONTEXT_CHANGED") {
          throw new CloudApiError(
            purged.error ?? "Authentication context changed before space cleanup",
            0,
            purged.code
          );
        }
        // Isolate one space's failure instead of aborting the whole pass; it
        // stays marked revoked, so the next pass retries.
        console.error(`Could not purge revoked team space ${space.id}`);
        continue;
      }
      this.dispatchSpaceRevoked(space.name, space.id);
      // Never-synced notes survive the purge in Personal (plan §10.6) —
      // surface them, never silently.
      for (const title of purged?.relocatedTitles ?? []) {
        this.dispatchNoteRelocated(title, space.name);
      }
    }

    if (backfillIds.length > 0) {
      // scope=all returns pre-existing space rows only when `since` is unset,
      // so a full snapshot pull is the simplest correct backfill for a space
      // that just appeared (v1). Spaces stay 'pending' until it completes so
      // the tree shows skeletons — and so an interrupted backfill re-runs.
      const teamOnly = !this.canSync();
      const pulled =
        (await this.pullFolders(teamOnly, true)) && (await this.pullNotes(teamOnly, true));
      if (pulled) {
        for (const id of backfillIds) {
          await window.electronAPI.setSpaceSyncStatus?.(id, "synced");
        }
      } else {
        return false;
      }
    }
    return true;
  }

  private async readSpacesWithCapabilities(authGeneration: number): Promise<MySpace[]> {
    try {
      const snapshot = await SpacesService.mySpacesSnapshot();
      await assertAuthGenerationCurrent(authGeneration);
      this.privatePlacementProbeGeneration = authGeneration;
      this.privatePlacementGeneration =
        snapshot.private_workspace_placement === true ? authGeneration : null;
      return snapshot.data;
    } catch (error) {
      if (isHttpStatus(error, 404)) {
        await assertAuthGenerationCurrent(authGeneration);
        this.privatePlacementProbeGeneration = authGeneration;
        this.privatePlacementGeneration = null;
      }
      throw error;
    }
  }

  private async ensurePrivatePlacementCapability(): Promise<void> {
    const generation = getValidatedAuthGeneration();
    if (generation == null || generation === this.privatePlacementProbeGeneration) return;
    try {
      await this.readSpacesWithCapabilities(generation);
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }

  private hasPrivatePlacementCapability(): boolean {
    return (
      this.privatePlacementGeneration !== null &&
      this.privatePlacementGeneration === getValidatedAuthGeneration()
    );
  }

  private placementBackfillComplete(): boolean {
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    return !!accountId && localStorage.getItem(`syncCursors.privatePlacement:${accountId}`) === "1";
  }

  private async privatePlacementCandidates(
    authGeneration: number
  ): Promise<PrivatePlacementBackupCandidates | null> {
    await assertAuthGenerationCurrent(authGeneration);
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    if (!accountId || !this.canSync()) return null;
    const key = `syncCursors.privatePlacementCandidates:${accountId}`;
    const parse = (stored: string): PrivatePlacementBackupCandidates => {
      const candidates = JSON.parse(stored) as PrivatePlacementBackupCandidates;
      if (
        !Array.isArray(candidates.notes) ||
        !candidates.notes.every((id) => typeof id === "string") ||
        !Array.isArray(candidates.folders) ||
        !candidates.folders.every((id) => typeof id === "string")
      ) {
        throw new Error("Invalid Private placement backfill candidates");
      }
      return candidates;
    };
    const stored = localStorage.getItem(key);
    if (stored !== null) return parse(stored);
    const candidates =
      await window.electronAPI.getPrivatePlacementBackupCandidates?.(authGeneration);
    await assertAuthGenerationCurrent(authGeneration);
    if (!candidates || "stale" in candidates || !this.canSync()) return null;
    // Another window may have captured before it restored rows during the IPC await.
    const first = localStorage.getItem(key);
    if (first !== null) return parse(first);
    // Keep the original local rows through failed pulls and delayed default binding.
    // Rows restored afterwards have no evidence of a user-chosen local placement.
    if (!this.placementBackfillComplete()) localStorage.setItem(key, JSON.stringify(candidates));
    return candidates;
  }

  private async backfillPrivatePlacement(accountId: string, authGeneration: number): Promise<void> {
    if (
      !this.hasPrivatePlacementCapability() ||
      this.placementBackfillComplete() ||
      !this.canSync()
    )
      return;
    const retry =
      this.placementBackfillRetry?.accountId === accountId ? this.placementBackfillRetry : null;
    if (retry && Date.now() < retry.at) return;
    const writes = retry?.writes ?? (await this.placementBackfillWrites(authGeneration));
    if (!writes) return;
    const failed: PlacementBackfillWrite[] = [];
    const parentLinks: FolderParentLink[] = [];
    for (const write of writes) {
      if (!(await this.writeBackfillPlacement(write, authGeneration, parentLinks))) {
        failed.push(write);
      }
    }
    // A subfolder followed before its parent couldn't nest yet; once both are
    // in their Private, it nests again.
    if (parentLinks.length > 0) {
      stopIfPullStale(
        await window.electronAPI.applyCloudFolderParents?.(parentLinks, authGeneration)
      );
    }
    if (!this.canSync()) return;
    if (failed.length === 0) {
      this.placementBackfillRetry = null;
      localStorage.setItem(`syncCursors.privatePlacement:${accountId}`, "1");
      localStorage.removeItem(`syncCursors.privatePlacementCandidates:${accountId}`);
      return;
    }
    // Only the writes that may still succeed, after a while, and without another pre-pull.
    this.placementBackfillRetry = {
      accountId,
      at: Date.now() + PLACEMENT_BACKFILL_RETRY_MS,
      writes: failed,
    };
    const candidatesOf = (kind: PlacementBackfillWrite["kind"]): string[] =>
      failed.filter((write) => write.kind === kind).map((write) => write.clientId);
    localStorage.setItem(
      `syncCursors.privatePlacementCandidates:${accountId}`,
      JSON.stringify({ notes: candidatesOf("note"), folders: candidatesOf("folder") })
    );
  }

  // The placements to write: rows this device filed in a Private other than the default's (the
  // server reads no placement as the default), whose cloud copy, just pulled, has none. Notes
  // only at the cloud's root: one in a folder takes its folder's placement on the server.
  private async placementBackfillWrites(
    authGeneration: number
  ): Promise<PlacementBackfillWrite[] | null> {
    const candidates = await this.privatePlacementCandidates(authGeneration);
    if (!candidates || this.placementBackfillComplete()) return null;
    this.pulledPlacements = new Map();
    try {
      if (!(await this.pullFolders(false, true)) || !(await this.pullNotes(false, true)))
        return null;
      if (!this.canSync()) return null;
      await assertAuthGenerationCurrent(authGeneration);
      const rows = await window.electronAPI.getPrivatePlacementBackupRows?.(
        authGeneration,
        candidates
      );
      await assertAuthGenerationCurrent(authGeneration);
      if (!rows?.success) return null;
      const pulled = this.pulledPlacements;
      const unplaced = (row: PrivatePlacementBackupRow, kind: PlacementBackfillWrite["kind"]) => {
        const cloud = pulled.get(row.cloud_id);
        return (
          !!cloud &&
          cloud.private_workspace_id === null &&
          (kind === "folder" || cloud.folder_id === null)
        );
      };
      const toWrite = (kind: PlacementBackfillWrite["kind"], rows: PrivatePlacementBackupRow[]) =>
        rows
          .filter((row) => unplaced(row, kind))
          .map((row) => ({
            kind,
            id: row.id,
            cloudId: row.cloud_id,
            clientId: row.client_id,
            workspaceId: row.workspace_id,
          }));
      return [...toWrite("folder", rows.folders ?? []), ...toWrite("note", rows.notes ?? [])];
    } finally {
      this.pulledPlacements = null;
    }
  }

  // False when the write may succeed on a later pass (offline, a server error). A refusal is
  // final. A placement the server already had is kept, and this device follows it.
  private async writeBackfillPlacement(
    write: PlacementBackfillWrite,
    authGeneration: number,
    parentLinks: FolderParentLink[]
  ): Promise<boolean> {
    const body = { private_workspace_id: write.workspaceId, placement_backfill: true } as const;
    try {
      const cloud =
        write.kind === "folder"
          ? await FoldersService.update(write.cloudId, body, authGeneration)
          : await NotesService.update(write.cloudId, body, authGeneration);
      if (cloud.private_workspace_id && cloud.private_workspace_id !== write.workspaceId) {
        await this.followCloudPlacement(write, cloud, authGeneration, parentLinks);
      }
      return true;
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      if (!(err instanceof CloudApiError) || err.status < 400 || err.status >= 500) return false;
      console.warn(
        `Placement backfill refused for ${write.kind} ${write.id}:`,
        err.status,
        err.code
      );
      return true;
    }
  }

  // Files the local copy in the Private of the workspace the cloud copy names, as a pull would.
  // A copy edited since it was read is left to the pull, which raises the conflict.
  // A followed folder's server parent is kept for once the batch is done
  // (parentLinks), when a parent followed later lands beside it.
  private async followCloudPlacement(
    write: PlacementBackfillWrite,
    cloud: CloudNote | Awaited<ReturnType<typeof FoldersService.update>>,
    authGeneration: number,
    parentLinks: FolderParentLink[]
  ): Promise<void> {
    const local =
      write.kind === "folder"
        ? await window.electronAPI.getFolderByClientId?.(write.clientId)
        : await window.electronAPI.getNote?.(write.id);
    if (!local || local.sync_status !== "synced" || local.deleted_at) return;
    const ctx = await this.buildSpaceContext();
    const space = await this.personalSpaceForCloudRow(cloud, undefined, ctx, authGeneration);
    if (!space) return;
    if (write.kind === "folder") {
      const folder = cloud as Awaited<ReturnType<typeof FoldersService.update>>;
      const stored = await window.electronAPI.upsertFolderFromCloud?.(
        folder as unknown as Record<string, unknown>,
        space.id,
        authGeneration
      );
      stopIfPullStale(stored);
      if (stored?.cloud_id && folder.parent_folder_id !== undefined) {
        parentLinks.push({
          cloudId: stored.cloud_id,
          parentCloudId: folder.parent_folder_id,
          snapshot: stored,
          adoptIfPending: false,
        });
      }
      return;
    }
    const note = cloud as CloudNote;
    const { cloudToLocal, personalFolderIn } = await this.buildCloudToLocalFolderMap();
    stopIfPullStale(
      await window.electronAPI.upsertNoteFromCloud?.(
        note as unknown as Record<string, unknown>,
        resolvePulledNoteFolderId(note, space.id, cloudToLocal, personalFolderIn(space.id)),
        space.id,
        authGeneration
      )
    );
  }

  private async relocatePulledPrivateWorkspaces(
    accountId: string,
    authGeneration: number
  ): Promise<void> {
    const state = useWorkspaceStore.getState();
    // Every account has a default workspace, so an empty list is a faulty answer.
    if (
      !state.loaded ||
      state.error ||
      state.workspaces.length === 0 ||
      state.listAccountId !== accountId ||
      !this.canSync()
    )
      return;
    const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
    await assertAuthGenerationCurrent(authGeneration);
    const lost = spaces.filter(
      (space) =>
        space.kind === "private" &&
        space.account_id === accountId &&
        space.workspace_id &&
        space.workspace_id !== state.defaultWorkspaceId &&
        !space.is_default_private &&
        !state.workspaces.some((workspace) => workspace.id === space.workspace_id)
    );
    if (lost.length === 0) return;
    // The list may predate a workspace made or joined on another device. A fresh one moves only
    // the Privates of workspaces the account is confirmed to be out of.
    await useWorkspaceStore.getState().refresh({ fresh: true });
    await assertAuthGenerationCurrent(authGeneration);
    const remaining = (await window.electronAPI.getSpaces?.()) ?? [];
    await assertAuthGenerationCurrent(authGeneration);
    if (lost.some((space) => !remaining.some((current) => current.id === space.id)))
      this.syncAllPending = true;
  }

  private async personalSpaceForCloudRow(
    cloud: { private_workspace_id?: string | null },
    localSpaceId: number | undefined,
    ctx: SpaceSyncContext,
    authGeneration: number
  ): Promise<SpaceItem | null> {
    if (cloud.private_workspace_id) {
      const known = [...ctx.byId.values()].find(
        (space) => space.kind === "private" && space.workspace_id === cloud.private_workspace_id
      );
      if (known) return known;
      await assertAuthGenerationCurrent(authGeneration);
      const id = await window.electronAPI.getPrivateSpaceId?.(
        cloud.private_workspace_id,
        authGeneration
      );
      await assertAuthGenerationCurrent(authGeneration);
      if (id != null) {
        const fresh = await this.buildSpaceContext();
        ctx.byId = fresh.byId;
        ctx.byCloudSpaceId = fresh.byCloudSpaceId;
        return ctx.byId.get(id) ?? null;
      }
      return null;
    }
    const known = localSpaceId === undefined ? undefined : ctx.byId.get(localSpaceId);
    if (cloud.private_workspace_id == null && known?.kind === "private") return known;
    return this.defaultPrivateSpace(ctx, authGeneration);
  }

  private async buildSpaceContext(): Promise<SpaceSyncContext> {
    const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
    return {
      byId: new Map(spaces.map((s) => [s.id, s])),
      byCloudSpaceId: new Map(
        spaces.filter((s) => s.cloud_space_id).map((s) => [s.cloud_space_id!, s])
      ),
      refreshedSpaces: false,
    };
  }

  // Personal rows without a workspace association land in the default Private.
  // Main may create its pending row while answering, so refresh an unlisted id.
  private async defaultPrivateSpace(
    ctx: SpaceSyncContext,
    authGeneration?: number
  ): Promise<SpaceItem | null> {
    if (ctx.defaultPrivateSpace !== undefined) return ctx.defaultPrivateSpace;
    if (authGeneration !== undefined) await assertAuthGenerationCurrent(authGeneration);
    const id = await window.electronAPI.getDefaultPrivateSpaceId?.(authGeneration);
    if (authGeneration !== undefined) await assertAuthGenerationCurrent(authGeneration);
    if (id != null && !ctx.byId.has(id)) {
      const fresh = await this.buildSpaceContext();
      ctx.byId = fresh.byId;
      ctx.byCloudSpaceId = fresh.byCloudSpaceId;
    }
    const space = id != null ? ctx.byId.get(id) : undefined;
    ctx.defaultPrivateSpace = space?.kind === "private" ? space : null;
    return ctx.defaultPrivateSpace;
  }

  // Maps a cloud row's space to its local row (space_id null → the default's
  // Private). An unknown space means we gained access to it mid-pass: re-pull
  // spaces once, then park still-unmapped rows — space content never files
  // into Personal.
  private async resolveSpaceForCloudRow(
    cloudSpaceId: string | null | undefined,
    ctx: SpaceSyncContext
  ): Promise<SpaceItem | null> {
    if (!cloudSpaceId) return this.defaultPrivateSpace(ctx);
    // Live read on every row: a purge can land mid-pass (this ctx would still
    // hold the deleted space), and writing the row would orphan it forever.
    if (readPurgedSpaceIds()[cloudSpaceId]) return null;
    const known = ctx.byCloudSpaceId.get(cloudSpaceId);
    if (known) return known;
    if (ctx.refreshedSpaces) return null;
    ctx.refreshedSpaces = true;
    try {
      const cloudSpaces = await SpacesService.mySpaces();
      // New spaces stay 'pending' so the next spaces pass backfills their
      // pre-existing content (this delta pull only sees rows past the cursor).
      await upsertCloudSpaces(cloudSpaces);
    } catch (err) {
      console.error("Mid-pass spaces refresh failed:", err);
      return null;
    }
    const fresh = await this.buildSpaceContext();
    ctx.byId = fresh.byId;
    ctx.byCloudSpaceId = fresh.byCloudSpaceId;
    ctx.defaultPrivateSpace = undefined;
    return ctx.byCloudSpaceId.get(cloudSpaceId) ?? null;
  }

  // Scope fields for push payloads. Space rows carry their space identity;
  // when the server supports space scope, personal rows send explicit nulls so
  // local moves out of a space propagate (the server treats an absent space_id
  // as "keep the current scope"). Returns null for space rows that must not
  // push: spaces with no cloud id yet (local-only dev spaces), or a server
  // that doesn't understand space scope and would file the row as personal.
  private pushScopeFields(space: SpaceItem | undefined): PushScopeFields | null {
    if (space?.kind === "team") {
      if (!space.cloud_space_id || !this.hasTeamSpacesCapability()) return null;
      return {
        workspace_id: space.workspace_id,
        space_id: space.cloud_space_id,
        ...(this.hasPrivatePlacementCapability() ? { private_workspace_id: null } : {}),
      };
    }
    return {
      ...(this.hasTeamSpacesCapability() ? { workspace_id: null, space_id: null } : {}),
      ...(this.hasPrivatePlacementCapability()
        ? { private_workspace_id: space?.workspace_id ?? null }
        : {}),
    };
  }

  // Resolves every note/folder push through the same two gates. Retractions
  // must wait for team-scope support or settling the row would erase the
  // pending scope change; team rows without a cloud scope must stay local.
  private resolvePushScope(
    kind: "folder" | "note",
    row: FolderItem | NoteItem,
    ctx: SpaceSyncContext,
    sharingPrivateNote = false
  ): PushScopeFields | null {
    if (row.left_team && row.cloud_id && !this.hasTeamSpacesCapability()) return null;

    const space = ctx.byId.get(row.space_id);
    if (
      space?.kind !== "team" &&
      !this.canSync() &&
      !sharingPrivateNote &&
      !(kind === "note" && (row as NoteItem).is_shared) &&
      !(row.left_team && row.cloud_id)
    )
      return null;
    const scope = this.pushScopeFields(space);
    if (!scope) {
      console.warn(`Skipping ${kind} ${row.id} push: its team space has no cloud team yet`);
    }
    return scope;
  }

  // A push was rejected because the note's team is gone or access was revoked
  // (plan §7.2). The server row (if any) stays the team's, but this pending
  // row carries unpushed work — it is here because a push was attempted — so
  // it survives as a private note with a forked identity, exactly like the
  // pull-side access_removed stub; never destroy the edits. Personal Backup consent governs later uploads of the fork.
  private async handleRevokedNotePush(note: NoteItem, ctx: SpaceSyncContext): Promise<void> {
    const spaceName = ctx.byId.get(note.space_id)?.name ?? null;
    const privateSpaceId = await this.forkPrivateSpaceId(note.space_id, ctx);
    if (privateSpaceId == null) {
      // The private space is a schema invariant. If a damaged database breaks
      // it, preserve the pending row rather than destroying unpushed edits.
      console.error(`Cannot relocate revoked note ${note.id}: private space is missing`);
      return;
    }
    await this.forkNoteToPrivate(note, privateSpaceId, "push", spaceName);
  }

  // Where a row forked out of a teamspace goes: the Private of that
  // teamspace's workspace (made the first time; a workspace the account has
  // lost moves its Private to the default on its next workspace list), or the
  // default's for a legacy team with no workspace. A private row keeps its own.
  private async forkPrivateSpaceId(spaceId: number, ctx: SpaceSyncContext): Promise<number | null> {
    const space = ctx.byId.get(spaceId);
    if (space?.kind === "private") return space.id;
    const workspaceId = space?.workspace_id ?? null;
    const id = workspaceId ? await window.electronAPI.getPrivateSpaceId?.(workspaceId) : null;
    return id ?? (await this.defaultPrivateSpace(ctx))?.id ?? null;
  }

  private readLocalRecord<T = number>(key: string): Record<string, T> {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
    } catch {
      return {};
    }
  }

  private writeLocalRecord<T>(key: string, counts: Record<string, T>): void {
    if (Object.keys(counts).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(counts));
    }
  }

  // Reset a row's consecutive-404 streak: the pull resolved it, a later push
  // settled, or it forked. Skips the write when the row wasn't being tracked.
  private clear404(key: string, clientId: string): void {
    const counts = this.readLocalRecord(key);
    const next = clearUpdate404(counts, clientId);
    if (next !== counts) this.writeLocalRecord(key, next);
  }

  // A note update PATCH 404'd. Rather than fork immediately (the 403
  // team_access_revoked path did), defer to this pass's pull to disambiguate a
  // revocation (access_removed stub → forkNoteToPrivate) from a genuine delete
  // (tombstone → hardDeleteNote). Only once the note has 404'd across
  // UPDATE_404_FORK_THRESHOLD consecutive stub-less passes do we fork to
  // Personal, so a stub that never lands can't loop forever. Marking the row
  // 'error' re-queues it for the next pass's push (and re-count).
  private async handleNoteUpdate404(note: NoteItem, ctx: SpaceSyncContext): Promise<void> {
    const { fork, next } = recordUpdate404(
      this.readLocalRecord(NOTE_UPDATE_404_KEY),
      note.client_note_id,
      UPDATE_404_FORK_THRESHOLD
    );
    this.writeLocalRecord(NOTE_UPDATE_404_KEY, next);
    if (fork) {
      await this.handleRevokedNotePush(note, ctx);
      return;
    }
    await window.electronAPI.markNoteSyncError?.(note.id);
  }

  // Folder counterpart of handleNoteUpdate404. A revoked member's folder PATCH
  // is already coded (team_not_found / team_access_revoked, caught by
  // isSpaceAccessError), so a bare 404 here is a genuine-delete race; defer to
  // the pull (access_removed stub → relocateRevokedFolder; tombstone →
  // hardDeleteFolder) and fork to Personal only as the stub-less fallback.
  // Folders have no 'error' status: an unsettled row stays 'pending', which
  // getPendingFolders already re-queues, so no explicit re-mark is needed.
  private async handleFolderUpdate404(folder: FolderItem, ctx: SpaceSyncContext): Promise<void> {
    const { fork, next } = recordUpdate404(
      this.readLocalRecord(FOLDER_UPDATE_404_KEY),
      folder.client_folder_id,
      UPDATE_404_FORK_THRESHOLD
    );
    this.writeLocalRecord(FOLDER_UPDATE_404_KEY, next);
    if (fork) await this.handleRevokedFolderPush(folder, ctx);
  }

  // Applies the plan §7.2 fork (see revokedNoteForkUpdate) and surfaces the
  // relocation toast when the note actually moved.
  private async forkNoteToPrivate(
    note: NoteItem,
    privateSpaceId: number,
    source: "push" | "pull",
    spaceName: string | null | undefined
  ): Promise<void> {
    const { update, relocated } = revokedNoteForkUpdate(note, privateSpaceId, source);
    await window.electronAPI.updateNote(note.id, update);
    if (relocated) this.dispatchNoteRelocated(note.title, spaceName);
  }

  // Applies a note delete made on another device or by a teammate. An edit that
  // never reached the cloud has no other copy, so it survives as a new note in
  // the Private a revoked row would go to; this device's own delete and clean
  // copies just go. False keeps the row for a later pass (no Private to fork
  // into).
  private async applyPulledNoteDelete(
    local: NoteItem,
    ctx: SpaceSyncContext,
    authGeneration: number
  ): Promise<boolean> {
    if (!local.deleted_at && hasUnpushedNoteEdits(local)) {
      const privateSpaceId = await this.forkPrivateSpaceId(local.space_id, ctx);
      if (privateSpaceId == null) {
        console.warn(`Keeping note ${local.id} deleted elsewhere: its Private is missing`);
        return false;
      }
      await this.forkNoteToPrivate(
        local,
        privateSpaceId,
        "pull",
        ctx.byId.get(local.space_id)?.name
      );
      return true;
    }
    await window.electronAPI.hardDeleteNote?.(local.id, authGeneration);
    return true;
  }

  // A folder PATCH was rejected because its team is gone or access was
  // revoked: the server row moved to a scope we can't write, so retrying
  // would fail forever. Preserve the dirty folder in Private with a forked
  // identity (plan §7.2); later personal uploads require Backup consent.
  private async handleRevokedFolderPush(folder: FolderItem, ctx: SpaceSyncContext): Promise<void> {
    const privateSpaceId = await this.forkPrivateSpaceId(folder.space_id, ctx);
    if (privateSpaceId == null) return;
    await window.electronAPI.relocateRevokedFolder?.(folder.id, privateSpaceId, true);
    this.dispatchNoteRelocated(folder.name, ctx.byId.get(folder.space_id)?.name);
  }

  // A note PATCH was denied (note_access_denied / note_scope_change_denied):
  // the server row is intact but this user may not change it. Preserve the
  // dirty local copy as a Personal fork with a new client identity — the
  // server row keeps the old one — then the caller snapshot-pulls the
  // untouched server note back into its original space.
  private async handleDeniedNoteUpdate(note: NoteItem, ctx: SpaceSyncContext): Promise<void> {
    const privateSpaceId = await this.forkPrivateSpaceId(note.space_id, ctx);
    if (privateSpaceId == null) {
      console.error(`Cannot preserve denied note ${note.id}: private space is missing`);
      return;
    }
    const { update } = revokedNoteForkUpdate(note, privateSpaceId, "push");
    await window.electronAPI.updateNote(note.id, update);
    this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
    this.emitSyncUiEvent("note-update-denied", { title: note.title });
  }

  // A note DELETE was denied: only the owner or an admin may delete it. Revive
  // the local row in place (preserving chat/speaker identity) and let the
  // caller snapshot-pull the authoritative server note over it. A row written
  // after its delete comes back pending with that write, pushed on a re-run.
  private async handleDeniedNoteDelete(note: NoteItem): Promise<void> {
    const restored = await window.electronAPI.restoreNoteAfterDeniedDelete?.(note.id);
    this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
    this.emitSyncUiEvent("note-delete-denied", { title: note.title });
    if (restored?.pending) this.syncAllPending = true;
  }

  // A folder PATCH was denied (folder_access_denied): only a space admin may
  // move a space folder. Preserve the dirty folder and its dirty/unsynced
  // child notes in Personal (forked identities); the caller snapshot-pulls
  // the untouched server folder and its contents back.
  private async handleDeniedFolderUpdate(folder: FolderItem, ctx: SpaceSyncContext): Promise<void> {
    const privateSpaceId = await this.forkPrivateSpaceId(folder.space_id, ctx);
    if (privateSpaceId == null) {
      console.error(`Cannot preserve denied folder ${folder.id}: private space is missing`);
      return;
    }
    await window.electronAPI.relocateRevokedFolder?.(folder.id, privateSpaceId, true);
    this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
    this.emitSyncUiEvent("folder-update-denied", { name: folder.name });
  }

  // A folder DELETE was denied: only a space admin may delete a space folder.
  private async handleDeniedFolderDelete(folder: FolderItem): Promise<void> {
    const restored = await window.electronAPI.restoreFolderAfterDeniedDelete?.(folder.id);
    if (!restored?.success) {
      // Must not throw: this runs in pushFolderDeletes' per-row catch, so a
      // throw would abort the whole pass. Surface a name clash for the user to
      // resolve; the tombstone stays journaled and retries next pass.
      if (restored?.reason === "name-taken") {
        this.dispatchFolderNameTaken(folder.name);
      } else {
        console.error(
          `Could not roll back denied folder delete ${folder.id}: ${restored?.error ?? "unknown error"}`
        );
      }
      return;
    }
    this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
    this.emitSyncUiEvent("folder-delete-denied", { name: folder.name });
  }

  // After a permission denial the server rows are unchanged. Rollback first
  // revives delete tombstones in place (updates may still fork dirty work);
  // a snapshot then reconciles any server changes that happened meanwhile.
  // Folders pull before notes so notes always find their parent, and snapshot
  // passes never advance the ordinary delta cursors.
  private async restoreDeniedRows(kind: "note" | "folder"): Promise<void> {
    const teamOnly = !this.canSync();
    if (kind === "folder") await this.pullFolders(teamOnly, true);
    await this.pullNotes(teamOnly, true);
    if (kind === "folder" && this.canSync()) await this.pullConversations(true);
  }

  // Sync passes run in whichever window holds the web lock (often the always-
  // on dictation overlay), so pass-raised UI signals rebroadcast to every
  // window through the main process instead of window-local CustomEvents.
  private emitSyncUiEvent(name: string, payload: Record<string, unknown>): void {
    void window.electronAPI.emitSyncEvent?.(name, payload)?.catch(console.error);
  }

  // spaceId is the LOCAL space id: the renderer's displaced-note memo (set
  // when the space-purged broadcast cleared the open note) is keyed by it.
  private dispatchSpaceRevoked(spaceName: string | null, spaceId: number | null = null): void {
    this.emitSyncUiEvent("space-revoked", { spaceName, spaceId });
  }

  private dispatchNoteRelocated(title: string | null, spaceName: string | null | undefined): void {
    this.emitSyncUiEvent("note-relocated", { title, spaceName: spaceName ?? null });
  }

  private dispatchFolderNameTaken(name: string): void {
    this.emitSyncUiEvent("folder-name-taken", { name });
  }

  // A 409 whose cloud copy only moved (onlyMovedSince) holds nothing for the user to choose:
  // the note takes that copy's base and pushes again. Returns whether it will.
  private async pushAgainIfOnlyMoved(
    note: NoteItem,
    payload: object,
    cloudNote: CloudNote
  ): Promise<boolean> {
    if (!onlyMovedSince(payload, cloudNote)) return false;
    const result = await window.electronAPI.setNoteCloudBase?.(
      note.id,
      cloudNote.updated_at,
      cloudNote.revision ?? null
    );
    if (!result?.success) return false;
    if (this.syncing) this.syncAllPending = true;
    else this.requestSyncAll("retry");
    return true;
  }

  // Conflicts land in this window's store (the pull may run here) AND
  // rebroadcast, so the editor window's banner shows no matter which window
  // detected them.
  private async surfaceNoteConflict(clientNoteId: string, cloudNote: CloudNote): Promise<void> {
    const { setNoteConflict } = await import("../stores/noteStore.js");
    setNoteConflict(clientNoteId, cloudNote);
    this.emitSyncUiEvent("note-conflict", { clientNoteId, cloudNote });
  }

  // A pull found a newer cloud copy over unpushed local edits. A push of the
  // note may still be waiting for its answer, which can show that copy was this
  // device's own write, so decide only once any such push has settled. One that
  // doesn't settle in time raises a real conflict itself: its own 409, or the
  // next push's.
  private async surfacePulledNoteConflict(local: NoteItem, cloudNote: CloudNote): Promise<void> {
    await this.withNotePushLocks([local.id], async () => {
      const current = await window.electronAPI.getNote?.(local.id);
      if (current && isStaleNoteConflict(current, cloudNote)) return;
      await this.surfaceNoteConflict(local.client_note_id, cloudNote);
    });
  }

  // Settles a conflict the note's own base already covers (isStaleNoteConflict),
  // which also frees notes earlier releases parked after racing themselves.
  // Returns whether the note may push.
  private async settleOwnNoteConflict(note: NoteItem): Promise<boolean> {
    const conflict = readNoteConflicts()[note.client_note_id];
    if (!conflict) return true;
    if (!isStaleNoteConflict(note, conflict)) return false;
    await this.settleNoteConflict(note.client_note_id);
    return true;
  }

  // Web Locks aren't re-entrant: nothing run under a note's lock may ask for
  // it again, and a pull (which takes note locks) never runs under one.
  private withNotePushLock<T>(
    localId: number,
    task: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    return navigator.locks.request(`${NOTE_PUSH_LOCK_PREFIX}${localId}`, { signal }, task);
  }

  // These notes' push locks, for a pass or a pull. After
  // NOTE_PUSH_LOCK_PASS_WAIT_MS the task is skipped, leaving the notes to the
  // next pass.
  private async withNotePushLocks(localIds: number[], task: () => Promise<void>): Promise<void> {
    const wait = new AbortController();
    const timer = setTimeout(() => wait.abort(), NOTE_PUSH_LOCK_PASS_WAIT_MS);
    const take = ([first, ...rest]: number[]): Promise<void> =>
      first === undefined ? task() : this.withNotePushLock(first, () => take(rest), wait.signal);
    try {
      await take(localIds);
    } catch (err) {
      // Anything but the wait running out still propagates.
      if (!wait.signal.aborted || err !== wait.signal.reason) throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async settleNoteConflict(clientNoteId: string): Promise<void> {
    const { clearNoteConflict } = await import("../stores/noteStore.js");
    clearNoteConflict(clientNoteId);
    this.emitSyncUiEvent("note-conflict-clear", { clientNoteId });
  }

  private async syncFolders(teamOnly = false): Promise<void> {
    if (!teamOnly) await this.claimBoundFolders();
    if (!this.passIsCurrent()) return;
    const parentsKnown = await this.backfillFolderParents(teamOnly);
    if (!this.passIsCurrent()) return;
    await this.pushPendingFolders(teamOnly, parentsKnown);
    if (!this.passIsCurrent()) return;
    await this.pushFolderDeletes(teamOnly);
    if (!this.passIsCurrent()) return;
    if (!teamOnly && this.teamCursorLagging("folders")) {
      await this.pullFolders(true);
      if (!this.passIsCurrent()) return;
    }
    await this.pullFolders(teamOnly);
    if (teamOnly || !this.passIsCurrent()) return;
    // After the pull, so a cloud namesake links a Private's folder before it is uploaded.
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const queued = await window.electronAPI.queueUnlinkedPrivateFolders?.(authGeneration);
    if (typeof queued === "number" && queued > 0)
      await this.pushPendingFolders(false, parentsKnown);
  }

  // What this pass's pull covers and no earlier pull has replayed: personal rows
  // on a full pass, team rows whenever the list includes them.
  private owedFolderParentBackfills(teamOnly: boolean): string[] {
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
    return [...(teamOnly ? [] : ["personal"]), ...(teamCapable ? ["team"] : [])]
      .map((rows) => `${FOLDER_PARENTS_BACKFILLED_KEY}.${rows}.${accountId}`)
      .filter((key) => localStorage.getItem(key) === null);
  }

  // A row with a cloud id and no local parent, whose push says "top level": the
  // backfill may be about to tell it otherwise. A folder leaving a team still goes,
  // since its retraction can't wait and the move drops any parent anyway.
  private couldFlattenBeforeBackfill(folder: FolderItem): boolean {
    return !!folder.cloud_id && folder.parent_folder_id == null && !folder.left_team;
  }

  // Delta pulls never replay folders pulled before parent_folder_id existed, so
  // such a subfolder stays flat here and its next push un-nests it for everyone.
  // Returns false when those rows must wait: the list itself failed. New folders
  // and nested rows still push, so a list that keeps failing can't stop backups. A
  // parked row retries the backfill next pass without holding anything back.
  private async backfillFolderParents(teamOnly: boolean): Promise<boolean> {
    const owed = this.owedFolderParentBackfills(teamOnly);
    if (owed.length === 0) return true;
    const pulled = await this.pullFolders(teamOnly, true, true);
    if (pulled) {
      for (const key of owed) localStorage.setItem(key, "true");
    }
    return pulled || this.lastFolderPullParkedRows;
  }

  // A full account folder list proves which cloud-bound legacy folders it owns.
  // A foreign default cannot stand in for the account's own same-named folder.
  private async claimBoundFolders(): Promise<void> {
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null || this.boundFoldersClaimedFor === accountId) return;
    const ctx = await this.buildSpaceContext();
    const local = (await window.electronAPI.getFolders?.()) ?? [];
    const unclaimed = local.filter(
      (folder) =>
        !folder.account_id &&
        folder.cloud_id &&
        !folder.deleted_at &&
        ctx.byId.get(folder.space_id)?.kind === "private"
    );
    if (unclaimed.length > 0) {
      try {
        const { folders: cloudFolders } = await FoldersService.list(
          undefined,
          undefined,
          authGeneration,
          "no-store"
        );
        const ownCloudIds = new Set(
          cloudFolders
            .filter((folder) => !folder.space_id && !folder.deleted_at)
            .map((folder) => folder.id)
        );
        const foreignDefaults: string[] = [];
        for (const folder of unclaimed) {
          stopIfSignInReplaced(authGeneration);
          const cloudId = folder.cloud_id!;
          if (!ownCloudIds.has(cloudId)) {
            if (folder.is_default) foreignDefaults.push(cloudId);
            continue;
          }
          // Settling a pending row would discard an unsent edit; its own push claims it.
          if (folder.sync_status !== "synced") continue;
          stopIfPullStale(
            await window.electronAPI.markFolderSyncedIfUnchanged?.(
              folder.id,
              folder,
              cloudId,
              authGeneration
            )
          );
        }
        if (foreignDefaults.length > 0) {
          await window.electronAPI.ensureAccountDefaultFolders?.(foreignDefaults, {
            accountId,
            authGeneration,
          });
        }
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        console.error("Bound folder claim failed:", err);
        return;
      }
    }
    stopIfSignInReplaced(authGeneration);
    this.boundFoldersClaimedFor = accountId;
  }

  private async pushFolderDeletes(teamOnly = false): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    let deletes = (await window.electronAPI.getPendingFolderDeletes?.()) ?? [];
    if (teamOnly && deletes.length > 0) {
      const { byId } = await this.buildSpaceContext();
      deletes = deletes.filter((f) => byId.get(f.space_id)?.kind === "team");
    }
    let denied = false;
    for (const f of deletes) {
      if (!f.cloud_id) continue;
      try {
        await FoldersService.delete(f.cloud_id, authGeneration);
        await window.electronAPI.hardDeleteFolder?.(f.id, authGeneration);
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (isPermissionDenialError(err)) {
          await this.handleDeniedFolderDelete(f);
          denied = true;
        } else if (isHttpStatus(err, 404) || isSpaceAccessError(err)) {
          // An already-gone row or a space we can no longer access can never
          // be deleted by this client. Clear the local tombstone (and any
          // update-404 streak the row carried) instead of retrying forever.
          await window.electronAPI.hardDeleteFolder?.(f.id, authGeneration);
          this.clear404(FOLDER_UPDATE_404_KEY, f.client_folder_id);
        } else {
          console.error("Folder delete sync failed:", err);
        }
      }
    }
    if (denied) await this.restoreDeniedRows("folder");
  }

  private async pushPendingFolders(teamOnly = false, parentsKnown = true): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    await this.ensurePrivatePlacementCapability();
    // A subfolder waits for its parent to reach the cloud, so a parent created
    // or updated in this pass (a Private placement move included) pushes first
    // and the subfolders that waited follow in a second round; a parent whose
    // push failed holds them back.
    const waiting = await this.pushPendingFolderRound(teamOnly, parentsKnown, authGeneration);
    if (waiting.size > 0) {
      await this.pushPendingFolderRound(teamOnly, parentsKnown, authGeneration, waiting);
    }
  }

  // Returns the subfolders still waiting for their parent to reach the cloud.
  // `only` limits the round to those ids, so rows that already failed aren't
  // retried.
  private async pushPendingFolderRound(
    teamOnly: boolean,
    parentsKnown: boolean,
    authGeneration: number,
    only?: Set<number>
  ): Promise<Set<number>> {
    const waiting = new Set<number>();
    const pending = (
      (await window.electronAPI.getPendingFolders?.(teamOnly ? "team" : undefined)) ?? []
    ).filter(
      (folder) =>
        (!only || only.has(folder.id)) && (parentsKnown || !this.couldFlattenBeforeBackfill(folder))
    );
    if (pending.length === 0) return waiting;

    const ctx = await this.buildSpaceContext();
    const folderMap = await this.buildLocalToCloudFolderMap(ctx);
    const pushable: Array<{
      folder: FolderItem;
      scope: PushScopeFields;
      parentFolderId: string | null;
    }> = [];
    for (const folder of pending) {
      const scope = this.resolvePushScope("folder", folder, ctx);
      if (!scope) continue;
      const parentFolderId = this.cloudParentFolderId(folder, folderMap);
      // Still waiting for its parent too: one created this round lets it nest in the next.
      if (
        parentFolderId === undefined ||
        (folder.cloud_id && nestingStillOwed(folder, folderMap))
      ) {
        waiting.add(folder.id);
        continue;
      }
      pushable.push({ folder, scope, parentFolderId });
    }

    const migration = pushable.filter(({ folder }) => folder.cloud_id);
    const fresh = pushable.filter(({ folder }) => !folder.cloud_id);

    let denied = false;
    for (const { folder, scope, parentFolderId } of migration) {
      try {
        await FoldersService.update(
          folder.cloud_id!,
          {
            name: folder.name,
            sort_order: folder.sort_order,
            parent_folder_id: parentFolderId,
            ...folderPushScope(scope, parentFolderId),
          },
          authGeneration
        );
        // Settle only if the row wasn't edited while the PATCH was in flight;
        // a withheld parent keeps it pending until it can be sent.
        await window.electronAPI.markFolderSyncedIfUnchanged?.(
          folder.id,
          withSentParent(folder, parentFolderId),
          folder.cloud_id!,
          authGeneration
        );
        this.recordFolderPushLanded(folder, parentFolderId);
        this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (isFolderNameTakenError(err)) {
          // Leave the row pending; retried on the next pass. The 409 also
          // proves the folder is still accessible, so reset any 404 streak.
          this.recordFolderRefused(folder);
          this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
        } else if (isInvalidParentFolderError(err)) {
          await this.unnestRefusedFolder(folder, authGeneration);
        } else if (isPermissionDenialError(err)) {
          await this.handleDeniedFolderUpdate(folder, ctx);
          denied = true;
        } else if (isSpaceAccessError(err)) {
          await this.handleRevokedFolderPush(folder, ctx);
          this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
        } else if (isHttpStatus(err, 404)) {
          await this.handleFolderUpdate404(folder, ctx);
        } else {
          console.error("Folder migration sync failed:", err);
        }
      }
    }
    if (denied) await this.restoreDeniedRows("folder");

    // A round's parents are all in the cloud already, so chunks can land in any order.
    for (let start = 0; start < fresh.length; start += BATCH_SIZE) {
      const chunk = fresh.slice(start, start + BATCH_SIZE);
      try {
        const { created, refused = [] } = await FoldersService.batchCreate(
          chunk.map(({ folder, scope, parentFolderId }) => ({
            name: folder.name,
            client_folder_id: folder.client_folder_id,
            is_default: !!folder.is_default,
            sort_order: folder.sort_order,
            parent_folder_id: parentFolderId,
            ...folderPushScope(scope, parentFolderId),
          })),
          authGeneration
        );
        // An unacknowledged row retains its local content and pending state.
        const refusedIds = new Set(refused.map((row) => row.client_folder_id));
        const accepted = chunk.filter(({ folder }) => !refusedIds.has(folder.client_folder_id));
        for (const row of refused) {
          const entry = chunk.find(
            ({ folder }) => folder.client_folder_id === row.client_folder_id
          );
          if (entry)
            await this.settleRefusedFolderCreate(entry.folder, row.code, ctx, authGeneration);
        }
        // created preserves the order of the rows the server accepted; the
        // cloud may return an existing folder with a different
        // client_folder_id when a same-named default already exists there —
        // adopt its identity in that case.
        if (created.length !== accepted.length) {
          console.error(
            `Folder batch create returned ${created.length} folders for ${accepted.length} inputs; skipping identity adoption`
          );
          continue;
        }
        for (const [i, cloudFolder] of created.entries()) {
          const { folder, parentFolderId } = accepted[i];
          await this.acknowledgeCreatedFolder(
            withSentParent(folder, parentFolderId),
            cloudFolder,
            authGeneration
          );
          this.recordFolderPushLanded(folder, parentFolderId);
        }
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (
          isSpaceAccessError(err) ||
          isPermissionDenialError(err) ||
          isInvalidParentFolderError(err) ||
          isFolderNameTakenError(err)
        ) {
          // A typed rejection can't be attributed to a row from the batch
          // response, and the server stops at the first one; create
          // individually so one rejected folder settles on its own without
          // stranding (or relocating) the rest.
          for (const { folder, scope, parentFolderId } of chunk) {
            await this.pushFreshFolder(folder, scope, parentFolderId, ctx, authGeneration);
          }
        } else {
          console.error("Folder batch create failed:", err);
        }
      }
    }
    return waiting;
  }

  // Batch-create fallback row push: recognized terminal rejections settle the
  // row by forking it into Private, with a fresh identity; anything
  // else stays 'pending' for the next pass.
  private async pushFreshFolder(
    folder: FolderItem,
    scope: PushScopeFields,
    parentFolderId: string | null,
    ctx: SpaceSyncContext,
    authGeneration: number
  ): Promise<void> {
    try {
      await this.createCloudFolder(folder, scope, parentFolderId, authGeneration);
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      const code = err instanceof CloudApiError ? err.code : undefined;
      if (!(await this.settleRefusedFolderCreate(folder, code, ctx, authGeneration))) {
        console.error("Folder create sync failed:", err);
      }
    }
  }

  // A create the server refused by code, alone or as a batch's refused row. It
  // adopts no folder: a name taken elsewhere in the Private area (the server
  // never takes a same-named folder under another parent) waits for the user,
  // pending, while its subfolders and notes go on (recordFolderRefused); a
  // parent it can't nest under un-nests it here; a space it may no longer
  // write moves it to Private. False for any other refusal, left to retry.
  private async settleRefusedFolderCreate(
    folder: FolderItem,
    code: string | undefined,
    ctx: SpaceSyncContext,
    authGeneration: number
  ): Promise<boolean> {
    if (code === "folder_name_taken") {
      this.recordFolderRefused(folder);
    } else if (code === "invalid_parent_folder") {
      await this.unnestRefusedFolder(folder, authGeneration);
    } else if (isSpaceAccessErrorCode(code) || isPermissionDenialCode(code)) {
      await this.handleRevokedFolderPush(folder, ctx);
      this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
    } else {
      return false;
    }
    return true;
  }

  // backfillParents replays parents onto rows the ordinary pull leaves alone (see
  // backfillFolderParents). A pending row with no parent adopts the cloud's: a row
  // from before subfolders couldn't have been nested here, so a queued rename won't
  // flatten it. One with a local parent keeps it.
  private async pullFolders(
    teamOnly = false,
    snapshot = false,
    backfillParents = false
  ): Promise<boolean> {
    this.lastFolderPullParkedRows = false;
    try {
      const authGeneration = getValidatedAuthGeneration();
      if (authGeneration == null || (!teamOnly && !this.canSync())) return false;
      if (
        !teamOnly &&
        !this.placementBackfillComplete() &&
        !(await this.privatePlacementCandidates(authGeneration))
      )
        return false;
      const cursorKey = teamOnly ? "lastSyncedAt.folders.team" : "lastSyncedAt.folders";
      const stored = snapshot ? undefined : (localStorage.getItem(cursorKey) ?? undefined);
      const since = stored === undefined ? undefined : overlappedSince(stored);
      const startedAtMs = Date.now();
      const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
      // Without a scope the list holds the account's personal rows alone.
      const scope = teamCapable ? "all" : undefined;
      const foldersBeforePull = new Map(
        ((await window.electronAPI.getFolderIdMap?.()) ?? []).map((folder) => [
          folder.cloud_id,
          folder,
        ])
      );
      const { folders: cloudFolders } = await FoldersService.list(
        since,
        scope,
        authGeneration,
        "no-store"
      );
      // Rows re-read from the overlap were applied before: no work moved.
      if (cloudFolders.some((folder) => pastCursor(folder.updated_at, stored))) {
        this.teamPassMovedWork = true;
      }
      const ctx = await this.buildSpaceContext();
      // Parked or failed rows must retry: they hold the cursor back (and fail
      // a backfill) so one bad row never drops the rest of the delta.
      let parkedRows = 0;
      const parentLinks: FolderParentLink[] = [];
      const addParentLink = (
        folder: FolderItem | null | undefined,
        parentCloudId: string | null | undefined
      ): void => {
        // Guard both edits during the request and edits while the rest of this
        // page is being stored, including edits sharing a SQLite timestamp. An
        // API without the field leaves the local parent alone.
        if (folder?.cloud_id && parentCloudId !== undefined) {
          parentLinks.push({
            cloudId: folder.cloud_id,
            parentCloudId,
            snapshot: folder,
            adoptIfPending: backfillParents,
          });
        }
      };

      for (const cloudFolder of cloudFolders) {
        try {
          stopIfSignInReplaced(authGeneration);
          if (!teamOnly && !this.canSync()) return false;
          // Cloud identity also finds rows whose local client key was preserved
          // after a collision with an earlier import.
          const local =
            (await window.electronAPI.getFolderByClientId?.(cloudFolder.client_folder_id ?? "")) ??
            (await window.electronAPI.getFolderByCloudId?.(cloudFolder.id));

          // Redacted stub: the folder moved out of one of our teams. Clean
          // local copies (folder and child notes) are no longer ours to keep;
          // dirty ones move to the teamspace's workspace's Private with forked
          // identities so unpushed work survives (plan §7.2). Only a team copy
          // can lose access: a private folder is this device's own.
          if (cloudFolder.access_removed) {
            if (!local || !isTeamRow(local, ctx)) continue;
            const privateSpaceId = await this.forkPrivateSpaceId(local.space_id, ctx);
            if (privateSpaceId != null) {
              const preserveFolder = local.sync_status === "pending" && !local.deleted_at;
              const result = await window.electronAPI.relocateRevokedFolder?.(
                local.id,
                privateSpaceId,
                preserveFolder
              );
              if (result?.success) {
                const spaceName = ctx.byCloudSpaceId.get(cloudFolder.previous_space_id ?? "")?.name;
                if (result.folder) {
                  this.dispatchNoteRelocated(result.folder.name, spaceName);
                } else {
                  for (const note of result.relocatedNotes ?? []) {
                    this.dispatchNoteRelocated(note.title, spaceName);
                  }
                }
                // The pull disambiguated a 404'd push as a revocation and
                // resolved it, so the fallback fork must stand down.
                this.clear404(FOLDER_UPDATE_404_KEY, local.client_folder_id);
              } else {
                parkedRows++;
                console.warn(`Could not relocate revoked folder ${local.id}:`, result?.error);
              }
            } else if (await this.applyPulledFolderDelete(local, authGeneration)) {
              this.clear404(FOLDER_UPDATE_404_KEY, local.client_folder_id);
            } else {
              parkedRows++;
            }
            continue;
          }

          // With Backup off, only an existing team row's transition to personal
          // scope is applied; ordinary personal rows remain untouched.
          if (teamOnly && !cloudFolder.space_id) {
            if (!local || local.deleted_at || !isTeamRow(local, ctx)) continue;
            if (cloudFolder.deleted_at) {
              if (await this.applyPulledFolderDelete(local, authGeneration)) {
                this.clear404(FOLDER_UPDATE_404_KEY, local.client_folder_id);
              } else {
                parkedRows++;
              }
            } else if (
              // Pending rows are never overwritten by pull (D2), here too.
              local.sync_status !== "pending" &&
              isCloudEntryNewer(cloudFolder.updated_at, local.updated_at)
            ) {
              const privateSpace = await this.personalSpaceForCloudRow(
                cloudFolder,
                local.space_id,
                ctx,
                authGeneration
              );
              if (!privateSpace) {
                parkedRows++;
                continue;
              }
              const stored = await window.electronAPI.upsertFolderFromCloud?.(
                cloudFolder as unknown as Record<string, unknown>,
                privateSpace.id,
                authGeneration
              );
              stopIfPullStale(stored);
              if (!stored) parkedRows++;
              // The space change cleared the parent; a carried subfolder
              // nests again under its parent once both are private.
              addParentLink(stored, cloudFolder.parent_folder_id);
            }
            continue;
          }

          if (cloudFolder.deleted_at) {
            if (local) {
              if (await this.applyPulledFolderDelete(local, authGeneration)) {
                // A tombstone disambiguates a 404'd push as a genuine delete;
                // drop any streak so it can't resurrect the folder in Personal.
                this.clear404(FOLDER_UPDATE_404_KEY, local.client_folder_id);
              } else {
                parkedRows++;
              }
            }
            continue;
          }

          if (!cloudFolder.space_id) {
            this.pulledPlacements?.set(cloudFolder.id, {
              private_workspace_id: cloudFolder.private_workspace_id ?? null,
              folder_id: null,
            });
          }
          const space = !cloudFolder.space_id
            ? await this.personalSpaceForCloudRow(cloudFolder, local?.space_id, ctx, authGeneration)
            : await this.resolveSpaceForCloudRow(cloudFolder.space_id, ctx);
          if (!space) {
            parkedRows++;
            console.warn(`Parking folder ${cloudFolder.id}: unknown space ${cloudFolder.space_id}`);
            continue;
          }

          // A folder created elsewhere arrives with an unknown
          // client_folder_id; inserting it would violate the per-space unique
          // folder name. Converge by adopting the cloud identity onto the
          // same-named local folder in the same space. Only unlinked folders
          // are adoptable (never re-point one already bound to another cloud
          // folder), and the case-insensitive fallback stays reserved for
          // fixed-name defaults so distinct user folders like "work"/"Work"
          // never merge. Team rows skip this — upsertFolderFromCloud's
          // collision convergence owns those. Only a folder at the cloud row's
          // level is adoptable: the server keeps same-named folders under
          // different parents apart, and taking one would move its notes and
          // nesting (an API without parents says nothing about levels).
          if (!local && !cloudFolder.space_id) {
            const allFolders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
            const cloudIdOf = new Map(allFolders.map((f) => [f.id, f.cloud_id]));
            const atCloudLevel = (f: FolderItem): boolean =>
              cloudFolder.parent_folder_id === undefined ||
              (f.parent_folder_id == null
                ? cloudFolder.parent_folder_id === null
                : !!cloudFolder.parent_folder_id &&
                  cloudIdOf.get(f.parent_folder_id) === cloudFolder.parent_folder_id);
            const adoptable = allFolders.filter(
              (f) =>
                f.space_id === space.id &&
                (!f.cloud_id || f.cloud_id === cloudFolder.id) &&
                atCloudLevel(f)
            );
            const nameMatch =
              adoptable.find((f) => f.name === cloudFolder.name) ??
              adoptable.find(
                (f) =>
                  (f.is_default || cloudFolder.is_default) &&
                  f.name.toLowerCase() === cloudFolder.name.toLowerCase()
              );
            if (nameMatch) {
              const adopt = async (clientFolderId: string) => {
                const result = await window.electronAPI.acknowledgeFolderCreate?.(
                  nameMatch.id,
                  nameMatch,
                  nameMatch.cloud_id,
                  clientFolderId,
                  cloudFolder.id,
                  cloudFolder.updated_at,
                  authGeneration
                );
                stopIfPullStale(result);
                if (result?.outcome === "synced") {
                  addParentLink(
                    {
                      ...nameMatch,
                      client_folder_id: clientFolderId,
                      cloud_id: cloudFolder.id,
                      sync_status: "synced",
                      left_team: 0,
                      updated_at: cloudFolder.updated_at,
                    },
                    cloudFolder.parent_folder_id
                  );
                }
                return result?.outcome === "synced" || result?.outcome === "pending";
              };
              const adopted = await adopt(
                cloudFolder.client_folder_id ?? nameMatch.client_folder_id
              );
              // A local key collision must not strand an otherwise matching row.
              if (!adopted && !(await adopt(nameMatch.client_folder_id))) {
                parkedRows++;
                console.warn(`Parking folder ${cloudFolder.id}: no local folder took it`);
              }
              continue;
            }
          }

          if (local?.deleted_at) continue;
          // Pending rows are never overwritten by pull: an unpushed change
          // (e.g. a team→private move awaiting its scope PATCH) must win over
          // a teammate's rename, or the move silently snaps back (D2).
          if (
            !local ||
            (local.sync_status !== "pending" &&
              (isCloudEntryNewer(cloudFolder.updated_at, local.updated_at) ||
                misplacedPrivateRow(cloudFolder, local, space)))
          ) {
            const stored = await window.electronAPI.upsertFolderFromCloud?.(
              cloudFolder as unknown as Record<string, unknown>,
              space.id,
              authGeneration
            );
            stopIfPullStale(stored);
            if (!stored) {
              parkedRows++;
              console.warn(`Parking folder ${cloudFolder.id}: it wasn't stored`);
            }
            addParentLink(stored, cloudFolder.parent_folder_id);
          } else if (
            backfillParents
              ? local.sync_status !== "pending" || local.parent_folder_id === null
              : local.sync_status !== "pending" &&
                normalizeTimestamp(local.updated_at) === normalizeTimestamp(cloudFolder.updated_at)
          ) {
            // An equal-version replay may finish a link whose parent failed
            // to load on the previous pass. Only the pre-request row may match.
            addParentLink(foldersBeforePull.get(cloudFolder.id), cloudFolder.parent_folder_id);
          }
        } catch (err) {
          // The sign-in changed: the rest of the list is the departed account's.
          if (isAuthContextError(err)) throw err;
          parkedRows++;
          console.error(`Folder pull failed for cloud folder ${cloudFolder.id}:`, err);
        }
      }
      if (parentLinks.length > 0) {
        stopIfPullStale(
          await window.electronAPI.applyCloudFolderParents?.(parentLinks, authGeneration)
        );
      }

      const { advanceCursor, advanceTeamCursor } = resolvePullCursorAdvance({
        snapshot,
        parked: parkedRows > 0,
        teamOnly,
        teamCapable,
        hasTeamSpaces: [...ctx.byId.values()].some((s) => s.kind === "team"),
      });
      if (!this.passIsCurrent()) return false;
      const cursorAt = serverTimeIso(startedAtMs);
      if (advanceCursor) localStorage.setItem(cursorKey, cursorAt);
      if (advanceTeamCursor) localStorage.setItem("lastSyncedAt.folders.team", cursorAt);
      this.lastFolderPullParkedRows = parkedRows > 0;
      return parkedRows === 0;
    } catch (err) {
      if (!isAuthContextError(err)) console.error("Folder pull failed:", err);
      return false;
    }
  }

  // Applies a folder delete made on another device or by a teammate. Its notes
  // stay, unfiled in place: the server tombstoned the ones it held in the folder,
  // and the note pull later in this pass applies those deletes (an unsent edit
  // survives as a new note). The database still takes this device's own delete
  // whole. False leaves the row for a later pass.
  private async applyPulledFolderDelete(
    local: FolderItem,
    authGeneration: number
  ): Promise<boolean> {
    const result = await window.electronAPI.hardDeleteFolder?.(local.id, authGeneration, {
      preserveDirtyNotes: true,
    });
    stopIfPullStale(result);
    if (!result?.success) {
      console.warn(`Could not apply deleted folder ${local.id}:`, result?.error);
      return false;
    }
    return true;
  }

  // Cursors from before they were stamped on the server's clock came from this
  // device's own. If that clock runs fast, they sit ahead of rows the server
  // stamped since, and every delta pull has skipped those rows. Such cursors
  // go back to the start once, and so does any cursor ahead of the server now,
  // which only a fast clock could have written. A note cursor is removed, so
  // the next pull replays the feed; the others restart at the feed's start,
  // since a pull without a cursor lists only live rows and misses deletes.
  private dropFastClockCursors(): void {
    const offsetMs = serverClockOffsetMs();
    if (offsetMs === null) return;
    const serverNowMs = Date.now() + offsetMs;
    const oldStamps =
      localStorage.getItem(SERVER_CLOCK_CURSORS_KEY) !== "1" && -offsetMs > FAST_CLOCK_TOLERANCE_MS;
    for (const key of PULL_CURSOR_KEYS) {
      const stamp = Date.parse(localStorage.getItem(key) ?? "");
      if (!Number.isFinite(stamp)) continue;
      if (!oldStamps && stamp - serverNowMs <= FAST_CLOCK_TOLERANCE_MS) continue;
      if (key.startsWith("lastSyncedAt.notes")) localStorage.removeItem(key);
      else localStorage.setItem(key, FEED_START);
    }
    localStorage.setItem(SERVER_CLOCK_CURSORS_KEY, "1");
  }

  // The team cursor lags the personal one only when degraded passes advanced
  // the personal cursor during a capability outage; the gap is exactly the
  // teammate edits the recovery pull below must cover.
  private teamCursorLagging(kind: "notes" | "folders"): boolean {
    if (!this.canSyncTeamSpaces() || !this.hasTeamSpacesCapability()) return false;
    const team = localStorage.getItem(`lastSyncedAt.${kind}.team`);
    const full = localStorage.getItem(`lastSyncedAt.${kind}`);
    return !!team && !!full && team < full;
  }

  private async syncNotes(teamOnly = false): Promise<void> {
    await this.pushPendingNotes(teamOnly);
    if (!this.passIsCurrent()) return;
    await this.pushNoteDeletes();
    if (!this.passIsCurrent()) return;
    await this.backfillNoteOwners(teamOnly);
    if (!this.passIsCurrent()) return;
    if (!teamOnly && this.teamCursorLagging("notes")) {
      await this.pullNotes(true);
      if (!this.passIsCurrent()) return;
    }
    const replayKey = teamOnly ? NOTE_FEED_REPLAY_TEAM_KEY : NOTE_FEED_REPLAY_KEY;
    const cursorKey = teamOnly ? "lastSyncedAt.notes.team" : "lastSyncedAt.notes";
    const fromStart = !localStorage.getItem(cursorKey);
    // A missing cursor can follow a partial legacy pull. Read tombstones too,
    // so its saved copies are repaired without a second full traversal.
    // A parked pull left its cursors in place, so the next pass re-sees the
    // parked rows — typically after syncSpaces has mirrored the missing team.
    if (await this.pullNotes(teamOnly, false, fromStart)) {
      const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
      const uncoveredTeams =
        !teamCapable &&
        ((await window.electronAPI.getSpaces?.()) ?? []).some((space) => space.kind === "team");
      // Personal deltas still run during an outage, but cannot complete a
      // repair of existing team copies or spend its bounded retry attempts.
      if (!uncoveredTeams) {
        if (fromStart) {
          localStorage.setItem(replayKey, String(NOTE_FEED_REPLAY_ATTEMPTS));
        } else {
          await this.replayNoteFeed(teamOnly, replayKey);
        }
      }
    }
    if (!this.passIsCurrent()) return;
    // After the delta pull, which usually shows whether the server keeps
    // revisions without a probe.
    await this.backfillNoteRevisions(teamOnly);
  }

  // Team notes mirrored before owner_user_id existed have a NULL owner, and
  // their server rows may never re-enter a delta pull (unchanged updated_at
  // is skipped), so the UI would fail closed on them forever. One snapshot
  // pull fills them via the pull's set-owner hook (shouldSetOwnerFromCloud),
  // which applies even when last-write-wins skips the content upsert. At most
  // once per session: enough to converge, bounded if the API doesn't return
  // user_id yet.
  private async backfillNoteOwners(teamOnly: boolean): Promise<void> {
    if (this.ownerBackfillChecked) return;
    this.ownerBackfillChecked = true;
    try {
      const missing = (await window.electronAPI.countTeamNotesMissingOwner?.()) ?? 0;
      if (missing > 0) await this.pullNotes(teamOnly, true);
    } catch (err) {
      console.error("Note owner backfill failed:", err);
    }
  }

  // Pulls used to match a cloud row only by client id, so a delete never found a
  // copy stored under another key, and the cursor has since moved past it. One
  // read of the whole feed brings those deletes back, for the normal path to
  // apply. A note the feed no longer returns stays: the API purges deletes after
  // 30 days, but absence can also mean the row exists and this account can't read
  // it. A row that stays parked must not make every session a full read, so this
  // runs once a session and stops after a few attempts.
  private async replayNoteFeed(teamOnly: boolean, replayKey: string): Promise<void> {
    const attempts = Number(localStorage.getItem(replayKey)) || 0;
    if (attempts >= NOTE_FEED_REPLAY_ATTEMPTS || this.noteFeedReplayTried.has(replayKey)) return;
    this.noteFeedReplayTried.add(replayKey);
    localStorage.setItem(replayKey, String(attempts + 1));
    if (await this.pullNotes(teamOnly, false, true)) {
      localStorage.setItem(replayKey, String(NOTE_FEED_REPLAY_ATTEMPTS));
    }
  }

  // Rows synced before revisions carry none, and an unchanged server row never
  // re-enters a delta pull, so a clear made elsewhere while this device ran a
  // release that kept the text would never arrive. One successful snapshot per
  // session applies them (pullNotes takes a clean pre-revision row whole),
  // and only against a server that keeps revisions: an older API would
  // otherwise repeat it every session for nothing.
  private async backfillNoteRevisions(teamOnly: boolean): Promise<void> {
    if (this.revisionBackfillChecked) return;
    try {
      const missing =
        (await window.electronAPI.countNotesMissingRevision?.(teamOnly ? "team" : undefined)) ?? 0;
      // An unanswered probe retries on the next pass.
      const supported = missing > 0 ? await this.noteRevisionsSupported() : false;
      if (supported === null) return;
      this.revisionBackfillChecked = !supported || (await this.pullNotes(teamOnly, true));
    } catch (err) {
      console.error("Note revision backfill failed:", err);
    }
  }

  // A pull usually answers this already; otherwise one row is enough to tell.
  private async noteRevisionsSupported(): Promise<boolean | null> {
    if (this.noteRevisionsKnown === null) {
      try {
        const { notes } = await NotesService.list(1);
        const row = notes.find((note) => !note.access_removed);
        if (row) this.noteRevisionsKnown = hasNoteRevision(row.revision);
      } catch (err) {
        console.error("Note revision probe failed:", err);
      }
    }
    return this.noteRevisionsKnown;
  }

  private async pushPendingNotes(teamOnly = false): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    await this.ensurePrivatePlacementCapability();
    // Without Backup, shared Private notes still sync, so their failed pushes retry too.
    const queue = teamOnly ? "syncable" : undefined;
    let pending = (await window.electronAPI.getPendingNotes?.(queue)) ?? [];
    // A conflict this device's own write left behind is no conflict: settle it
    // first, so the note pushes in this pass (see isStaleNoteConflict).
    for (const note of pending) await this.settleOwnNoteConflict(note);
    const conflicted = readNoteConflictIds();
    // A surfaced conflict already holds its cloud copy; only rows still
    // awaiting one need the snapshot pull, as an unchanged cloud row may be
    // absent from the delta feed. A rejected create pulls until its conflict
    // surfaces; a clear on a row without a revision gets one successful
    // snapshot per session when the server keeps revisions (the pull adopts
    // one or surfaces a conflict, see pullNotes).
    const unresolved = pending.filter((note) => !conflicted.has(note.client_note_id));
    const pullsForUnrevisionedClear =
      !this.unrevisionedClearPullDone &&
      unresolved.some(hasUnrevisionedNoteClear) &&
      (await this.noteRevisionsSupported()) === true;
    if (
      pullsForUnrevisionedClear ||
      unresolved.some((note) => note.cloud_create_rejected || note.cloud_create_pending)
    ) {
      const pulled = await this.pullNotes(teamOnly, true);
      if (pullsForUnrevisionedClear && pulled) this.unrevisionedClearPullDone = true;
      pending = (await window.electronAPI.getPendingNotes?.(queue)) ?? [];
    }
    if (pending.length === 0) return;
    this.teamPassMovedWork = true;

    const ctx = await this.buildSpaceContext();
    const folderMap = await this.buildLocalToCloudFolderMap(ctx);
    const folderWait = {
      ...folderMap,
      releasedFolderIds: this.releaseWaitingFolders(folderMap.waitingFolders),
    };
    const pushable = pending.filter((note) =>
      this.stillPushable(note, note.cloud_id, folderWait, ctx)
    );

    const migration = pushable.filter((note) => note.cloud_id);
    const fresh = pushable.filter((note) => !note.cloud_id);

    let denied = false;
    for (const queued of migration) {
      await this.withNotePushLocks([queued.id], async () => {
        // A debounced push may have sent the note while this pass waited for
        // its lock: read it again, so the PATCH carries the base it left.
        const note = await window.electronAPI.getNote?.(queued.id);
        const scope = note ? this.stillPushable(note, queued.cloud_id, folderWait, ctx) : null;
        if (!note || !scope) return;
        // Carry the full content: a pending row may hold edits that never
        // reached the server (offline debounced pushes fail silently), and
        // this PATCH marks the row synced — settling it without content
        // would strand the edit locally and hand the next pull a stale-but-
        // newer cloud copy to overwrite it with.
        const cloudFolderId = pushedFolderId(note, folderMap);
        const payload = this.notePushPayload(
          note,
          cloudFolderId,
          folderPlacedNoteScope(note, scope, cloudFolderId, ctx)
        );
        try {
          const cloud = await NotesService.update(
            note.cloud_id!,
            { client_note_id: note.client_note_id, ...payload },
            authGeneration
          );
          // Settle only if the row wasn't edited while the PATCH was in flight.
          await window.electronAPI.markNoteSyncedIfUnchanged?.(
            note.id,
            note,
            note.cloud_id!,
            cloud.updated_at,
            cloud.user_id ?? null,
            cloud.revision ?? null,
            cloud,
            authGeneration
          );
          this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
        } catch (err) {
          if (isAuthContextError(err)) throw err;
          if (isNoteVersionConflictError(err)) {
            // Stays pending (not error): unpushed local work awaiting the
            // user's Keep/Refresh choice; the registry gate above skips the
            // row on later passes so the 409 doesn't repeat. A 409 also proves
            // the note is still accessible, so reset any prior 404 streak. A row
            // sending only its folder link has no edit to weigh: this pass's pull
            // takes the newer copy and the link retries on its revision.
            const cloudNote = hasUnpushedNoteEdits(note) ? conflictCloudNote(err) : null;
            if (cloudNote && !(await this.pushAgainIfOnlyMoved(note, payload, cloudNote)))
              await this.surfaceNoteConflict(note.client_note_id, cloudNote);
            this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
          } else if (isPermissionDenialError(err)) {
            await this.handleDeniedNoteUpdate(note, ctx);
            denied = true;
          } else if (isSpaceAccessError(err)) {
            await this.handleRevokedNotePush(note, ctx);
            this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
          } else if (isHttpStatus(err, 404)) {
            await this.handleNoteUpdate404(note, ctx);
          } else {
            await window.electronAPI.markNoteSyncError?.(note.id);
          }
        }
      });
    }
    if (denied) await this.restoreDeniedRows("note");

    for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
      const batch = fresh.slice(i, i + BATCH_SIZE);
      await this.withNotePushLocks(
        batch.map((note) => note.id),
        async () => {
          // A debounced push may have created some of these meanwhile. They
          // hold a cloud id now, and their later text goes out as an update.
          const unsent: Array<{ note: NoteItem; scope: PushScopeFields }> = [];
          for (const queued of batch) {
            const note = await window.electronAPI.getNote?.(queued.id);
            const scope = note ? this.stillPushable(note, queued.cloud_id, folderWait, ctx) : null;
            if (note && scope) {
              unsent.push({
                note,
                scope: folderPlacedNoteScope(note, scope, pushedFolderId(note, folderMap), ctx),
              });
            }
          }
          const recorded = await recordNoteCreateAttempts(
            unsent.map(({ note }) => note.client_note_id),
            authGeneration
          );
          const chunk = unsent.filter(
            ({ note }) =>
              recorded.has(note.client_note_id) && this.resolvePushScope("note", note, ctx)
          );
          if (chunk.length === 0) return;
          try {
            const { created } = await NotesService.batchCreate(
              chunk.map(({ note: n, scope }) => ({
                client_note_id: n.client_note_id,
                ...buildNoteCreatePayload(n, pushedFolderId(n, folderMap)),
                created_at: n.created_at,
                ...scope,
              })),
              authGeneration
            );
            for (const cloud of created) {
              const local = chunk.find(({ note }) => note.client_note_id === cloud.client_note_id);
              if (local) await this.acknowledgeCloudNoteCreate(local.note, cloud, authGeneration);
            }
          } catch (err) {
            if (isAuthContextError(err)) throw err;
            if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
              // A typed rejection can't be attributed to a row from the batch
              // response; create individually so one rejected note settles
              // terminally without stranding (or relocating) the rest.
              for (const { note, scope } of chunk) {
                await this.pushFreshNote(
                  note,
                  scope,
                  pushedFolderId(note, folderMap),
                  ctx,
                  authGeneration
                );
              }
            } else {
              for (const { note } of chunk) {
                await window.electronAPI.markNoteSyncError?.(note.id);
              }
            }
          }
        }
      );
    }
  }

  // The scope to push a pending note in, as queued and again under its push
  // lock, or null once this push no longer applies: sent meanwhile, deleted,
  // parked behind a conflict or create, or still behind its folder's own change.
  private stillPushable(
    note: NoteItem,
    queuedCloudId: string | null,
    folderWait: LocalToCloudFolderMap & { releasedFolderIds: Set<number> },
    ctx: SpaceSyncContext
  ): PushScopeFields | null {
    if (note.deleted_at || note.sync_status === "synced" || note.cloud_id !== queuedCloudId) {
      return null;
    }
    if (
      readNoteConflictIds().has(note.client_note_id) ||
      noteAwaitsCloudResolution(note, this.noteRevisionsKnown !== false)
    ) {
      // An unresolved pull conflict or rejected create: pushing now would
      // auto-resolve it as local-wins before the user chose Keep or Refresh
      // (which clear the registry entry and unblock the row). A clear with
      // no revision waits for a pull to supply one.
      return null;
    }
    if (this.noteWaitsForFolder(note, folderWait, folderWait.releasedFolderIds)) {
      // The folder's own changes haven't landed (e.g. a cross-space move
      // that 409'd on a name conflict, or a new subfolder whose parent hasn't
      // reached the cloud): the server would reject the note's folder_id as
      // out of scope, stranding it in 'error', or the note would upload with
      // no folder. Stay pending; folder and notes push together once the
      // folder settles.
      return null;
    }
    return this.resolvePushScope("note", note, ctx);
  }

  // A cloud copy only exists through prior consent (backup or sync-and-share),
  // so deletes always propagate — even for notes never shared and with the
  // backup toggle off.
  private async pushNoteDeletes(): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const deletes = (await window.electronAPI.getPendingNoteDeletes?.()) ?? [];
    let denied = false;
    for (const note of deletes) {
      if (!note.cloud_id) continue;
      try {
        await NotesService.delete(note.cloud_id, authGeneration);
        await window.electronAPI.hardDeleteNote?.(note.id, authGeneration);
        // A settled tombstone can never resolve a conflict; drop the entry
        // (and its full cloud snapshot) from the durable registry.
        await this.settleNoteConflict(note.client_note_id);
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (isPermissionDenialError(err)) {
          await this.handleDeniedNoteDelete(note);
          denied = true;
        } else if (isHttpStatus(err, 404) || isSpaceAccessError(err)) {
          // An already-gone row or a space we can no longer access can never
          // be deleted by this client. Clear the local tombstone (and any
          // update-404 streak the row carried) instead of retrying forever.
          await window.electronAPI.hardDeleteNote?.(note.id, authGeneration);
          this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
          await this.settleNoteConflict(note.client_note_id);
        } else {
          console.error("Note delete sync failed:", err);
        }
      }
    }
    if (denied) await this.restoreDeniedRows("note");
  }

  private async pullNotes(
    teamOnly = false,
    snapshot = false,
    replayFeed = false
  ): Promise<boolean> {
    try {
      const authGeneration = getValidatedAuthGeneration();
      if (authGeneration == null || (!teamOnly && !this.canSync())) return false;
      if (
        !teamOnly &&
        !this.placementBackfillComplete() &&
        !(await this.privatePlacementCandidates(authGeneration))
      )
        return false;
      const cursorKey = teamOnly ? "lastSyncedAt.notes.team" : "lastSyncedAt.notes";
      const stored =
        snapshot || replayFeed ? undefined : (localStorage.getItem(cursorKey) ?? undefined);
      const since = snapshot
        ? undefined
        : replayFeed
          ? FEED_START
          : stored === undefined
            ? undefined
            : overlappedSince(stored);
      const startedAtMs = Date.now();
      const ctx = await this.buildSpaceContext();
      const { cloudToLocal, personalFolderIn } = await this.buildCloudToLocalFolderMap();
      const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
      // Without a scope the list holds the account's personal rows alone.
      const scope = teamCapable ? "all" : undefined;

      let cursor: string | undefined = since;
      let cursorId: string | undefined;
      // Only rows that still need to be applied hold the delta cursor back.
      // Conflicts are durable in the local registry and resolve directly from
      // their stored cloud copy, so they must not re-pull the whole delta.
      let parkedRows = 0;
      while (true) {
        const { notes: cloudNotes } = since
          ? await NotesService.list(
              BATCH_SIZE,
              undefined,
              cursor,
              scope,
              cursorId,
              authGeneration,
              "no-store"
            )
          : await NotesService.list(
              BATCH_SIZE,
              cursor,
              undefined,
              scope,
              cursorId,
              authGeneration,
              "no-store"
            );
        if (cloudNotes.length === 0) break;
        // Rows re-read from the overlap were applied before: no work moved.
        if (cloudNotes.some((note) => pastCursor(note.updated_at, stored))) {
          this.teamPassMovedWork = true;
        }

        for (const cloudNote of cloudNotes) {
          try {
            stopIfSignInReplaced(authGeneration);
            if (!teamOnly && !this.canSync()) return false;
            const local = await window.electronAPI.getNoteForCloudRow?.(
              cloudNote.client_note_id,
              cloudNote.id
            );
            if (local && heldOverlapNote(local, cloudNote, stored)) continue;

            if (
              local &&
              (await this.renewTeamPublicationFromPersonalTombstone(
                local,
                cloudNote,
                authGeneration
              ))
            )
              continue;

            // An old delete must not take text this device hasn't pushed. Its
            // push gets a 404 and forks it into a note of its own.
            if (replayFeed && cloudNote.deleted_at && (!local || hasUnpushedNoteEdits(local))) {
              continue;
            }

            // A parent folder DELETE owns this note until its server result is
            // known. Do not turn a newer live row into a conflict or apply a
            // per-note tombstone; denial restores the journaled row in place,
            // while confirmation removes it with the folder cascade.
            if (local?.folder_delete_pending) continue;
            if (!cloudNote.access_removed) {
              this.noteRevisionsKnown = hasNoteRevision(cloudNote.revision);
            }

            const personalRow = !cloudNote.space_id && !cloudNote.access_removed;
            if (personalRow) {
              this.pulledPlacements?.set(cloudNote.id, {
                private_workspace_id: cloudNote.private_workspace_id ?? null,
                folder_id: cloudNote.folder_id ?? null,
              });
            }
            const teamCopy = !!local && isTeamRow(local, ctx);
            const sharedPersonal = personalRow && !!local && isLegacySharedPrivateNote(local);

            // Copy the cloud owner before any last-write-wins decision: an
            // unchanged note skips the upsert but must still gain its owner
            // (the owner_user_id backfill relies on this).
            if (local && shouldSetOwnerFromCloud(cloudNote, local)) {
              await window.electronAPI.setNoteOwnerFromCloud?.(local.id, cloudNote.user_id!);
            }

            // Redacted stub: the note moved out of one of our teams. Clean local
            // copies are no longer ours to keep; dirty ones ('pending' or
            // 'error') move to the teamspace's workspace's Private so unpushed
            // work survives (plan §7.2). Only a team copy can lose access: a
            // private note is this device's own.
            if (cloudNote.access_removed) {
              if (!local || !teamCopy) continue;
              const privateSpaceId =
                hasUnpushedNoteEdits(local) && !local.deleted_at
                  ? await this.forkPrivateSpaceId(local.space_id, ctx)
                  : null;
              if (privateSpaceId != null) {
                await this.forkNoteToPrivate(
                  local,
                  privateSpaceId,
                  "pull",
                  ctx.byCloudSpaceId.get(cloudNote.previous_space_id ?? "")?.name
                );
              } else {
                await window.electronAPI.hardDeleteNote?.(local.id, authGeneration);
              }
              // The pull disambiguated a 404'd push as a revocation and resolved
              // it, so the fallback fork must stand down. Any unresolved
              // conflict is moot too — its cloud copy is no longer ours to
              // resolve — and settling drops the full snapshot the durable
              // registry keeps in localStorage.
              this.clear404(NOTE_UPDATE_404_KEY, local.client_note_id);
              await this.settleNoteConflict(local.client_note_id);
              continue;
            }

            // Rejected create retries must be resolved against the actual row,
            // even when its timestamp predates the local offline snapshot.
            if (local?.cloud_create_rejected && !cloudNote.deleted_at) {
              await this.surfaceNoteConflict(local.client_note_id, cloudNote);
              continue;
            }

            if (teamOnly && personalRow && !sharedPersonal && !local?.cloud_create_pending) {
              // A personal row whose local copy still sits in a team space
              // announces a team→personal transition — apply it, or a later
              // edit's push would re-team the privatized note. An explicit
              // owner-only workspace association determines its Private filing.
              if (local && teamCopy && !local.deleted_at) {
                if (cloudNote.deleted_at) {
                  if (!(await this.applyPulledNoteDelete(local, ctx, authGeneration))) {
                    parkedRows++;
                    continue;
                  }
                  await this.settleNoteConflict(local.client_note_id);
                } else if (isCloudNoteNewer(cloudNote, local)) {
                  // 'error' rows carry unpushed work just like 'pending' ones.
                  if (hasUnpushedNoteEdits(local)) {
                    await this.surfacePulledNoteConflict(local, cloudNote);
                  } else {
                    const privateSpace = await this.personalSpaceForCloudRow(
                      cloudNote,
                      local.space_id,
                      ctx,
                      authGeneration
                    );
                    if (
                      !privateSpace ||
                      (cloudNote.folder_id && !cloudToLocal.has(cloudNote.folder_id))
                    ) {
                      parkedRows++;
                      continue;
                    }
                    const stored = await window.electronAPI.upsertNoteFromCloud?.(
                      cloudNote as unknown as Record<string, unknown>,
                      resolvePulledNoteFolderId(
                        cloudNote,
                        privateSpace.id,
                        cloudToLocal,
                        personalFolderIn(privateSpace.id)
                      ),
                      privateSpace.id,
                      authGeneration
                    );
                    stopIfPullStale(stored);
                    if (!stored) parkedRows++;
                  }
                }
              }
              continue;
            }

            if (cloudNote.deleted_at) {
              if (local) {
                if (!(await this.applyPulledNoteDelete(local, ctx, authGeneration))) {
                  parkedRows++;
                  continue;
                }
                // A tombstone disambiguates a 404'd push as a genuine delete;
                // drop any streak so it can't resurrect the note in Personal,
                // and settle any conflict so the registry doesn't keep the
                // deleted note's full cloud snapshot forever.
                this.clear404(NOTE_UPDATE_404_KEY, local.client_note_id);
                await this.settleNoteConflict(local.client_note_id);
              }
              continue;
            }

            const personalSpaceId = personalRow
              ? local && !teamCopy
                ? local.space_id
                : cloudToLocal.get(cloudNote.folder_id ?? "")?.space_id
              : undefined;
            const space = personalRow
              ? await this.personalSpaceForCloudRow(cloudNote, personalSpaceId, ctx, authGeneration)
              : await this.resolveSpaceForCloudRow(cloudNote.space_id, ctx);
            if (!space) {
              parkedRows++;
              console.warn(`Parking note ${cloudNote.id}: unknown space ${cloudNote.space_id}`);
              continue;
            }
            const localFolderId =
              teamOnly && sharedPersonal && local
                ? local.folder_id
                : resolvePulledNoteFolderId(
                    cloudNote,
                    space.id,
                    cloudToLocal,
                    personalFolderIn(space.id)
                  );
            const folderUnknown =
              !(teamOnly && sharedPersonal) &&
              !!cloudNote.folder_id &&
              !cloudToLocal.has(cloudNote.folder_id);

            if (local?.deleted_at) continue;
            if (local?.cloud_create_pending) {
              if (folderUnknown) {
                parkedRows++;
                continue;
              }
              const result = await window.electronAPI.acknowledgeNoteCreate?.(
                local.id,
                local,
                cloudNote.id,
                cloudNote.updated_at,
                cloudNote.user_id ?? null,
                {
                  expectedAuthGeneration: authGeneration,
                  reconcilePending: true,
                  cloudNote,
                  cloudRevision: cloudNote.revision ?? null,
                  localFolderId,
                  localSpaceId: space.id,
                }
              );
              stopIfPullStale(result);
              if (result?.outcome === "conflict") {
                await this.surfaceNoteConflict(local.client_note_id, cloudNote);
              } else if (result?.outcome === "synced" || result?.outcome === "pending") {
                await this.settleNoteConflict(local.client_note_id);
              } else {
                parkedRows++;
              }
              continue;
            }
            const preRevision =
              local &&
              !hasNoteRevision(local.cloud_revision) &&
              hasNoteRevision(cloudNote.revision) &&
              local.cloud_id === cloudNote.id;
            if (preRevision && hasUnpushedNoteEdits(local)) {
              // Adopt the revision when this device's base is the server's
              // current row. An unpushed edit on a row acked before timestamp
              // bases existed pushed last-write-wins until now; it still does.
              const sameBase =
                normalizeTimestamp(local.cloud_updated_at) ===
                normalizeTimestamp(cloudNote.updated_at);
              if (!sameBase && local.cloud_updated_at) {
                await this.surfaceNoteConflict(local.client_note_id, cloudNote);
                continue;
              }
              await window.electronAPI.setNoteCloudBase?.(
                local.id,
                cloudNote.updated_at,
                cloudNote.revision
              );
              local.cloud_revision = cloudNote.revision;
            }
            // A clean row synced before revisions takes the cloud copy whole:
            // adopting only the revision would mark the copies equal from now
            // on, so a clear made elsewhere while this device ran a release that
            // kept the text would never arrive.
            const cleanPreRevision = preRevision && !hasUnpushedNoteEdits(local);
            if (
              !local ||
              cleanPreRevision ||
              isCloudNoteNewer(cloudNote, local) ||
              misplacedPrivateRow(cloudNote, local, space)
            ) {
              if (local && hasUnpushedNoteEdits(local)) {
                // A newer cloud copy over unpushed local edits ('pending' or
                // 'error'): surface the conflict to the editor banner instead
                // of silently dropping the local edit (plan §7.3).
                await this.surfacePulledNoteConflict(local, cloudNote);
                continue;
              }
              if (folderUnknown) {
                // The note's folder isn't known locally yet (created moments
                // ago, or its pull failed). Filing it to the fallback would
                // stick — the advanced cursor never re-pulls the row — so park
                // it like an unknown space until the folder arrives.
                parkedRows++;
                console.warn(`Parking note ${cloudNote.id}: unknown folder ${cloudNote.folder_id}`);
                continue;
              }
              const applied = await window.electronAPI.upsertNoteFromCloud?.(
                cloudNote as unknown as Record<string, unknown>,
                localFolderId,
                space.id,
                authGeneration
              );
              stopIfPullStale(applied);
              // A failed local write must keep this row eligible for the next pull.
              if (!applied) {
                parkedRows++;
                console.warn(`Parking note ${cloudNote.id}: it wasn't stored`);
                continue;
              }
              if (local) {
                // Applying cloud over a clean row settles any stale conflict,
                // including one left under the key this row just adopted. A
                // skipped upsert adopted nothing, and that key is another row's.
                await this.settleNoteConflict(local.client_note_id);
                if (
                  applied &&
                  "client_note_id" in applied &&
                  applied.client_note_id !== local.client_note_id
                ) {
                  await this.settleNoteConflict(applied.client_note_id);
                }
              }
            }
          } catch (err) {
            // The sign-in changed: the rest of the feed is the departed account's.
            if (isAuthContextError(err)) throw err;
            // Parked like a row waiting on its folder: the cursor holds so the
            // next pass retries it, and the rest of the delta still applies.
            parkedRows++;
            console.error(`Note pull failed for cloud note ${cloudNote.id}:`, err);
          }
        }

        if (cloudNotes.length < BATCH_SIZE) break;
        const last = cloudNotes[cloudNotes.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor && last.id === cursorId) {
          console.warn(`Note pull cursor stalled at ${next} / ${last.id}`);
          return false;
        }
        cursor = next;
        cursorId = last.id;
      }

      const { advanceCursor, advanceTeamCursor } = resolvePullCursorAdvance({
        snapshot,
        parked: parkedRows > 0,
        teamOnly,
        teamCapable,
        hasTeamSpaces: [...ctx.byId.values()].some((s) => s.kind === "team"),
      });
      if (!this.passIsCurrent()) return false;
      const cursorAt = serverTimeIso(startedAtMs);
      if (advanceCursor) localStorage.setItem(cursorKey, cursorAt);
      if (advanceTeamCursor) localStorage.setItem("lastSyncedAt.notes.team", cursorAt);
      return parkedRows === 0;
    } catch (err) {
      if (!isAuthContextError(err)) console.error("Note pull failed:", err);
      return false;
    }
  }

  private async syncConversations(accountId: string): Promise<void> {
    await this.repairUnsentChatMessages(accountId);
    if (!this.passIsCurrent() || !this.canSync()) return;
    await this.pushPendingConversations();
    if (!this.passIsCurrent()) return;
    await this.pushConversationDeletes();
    if (!this.passIsCurrent()) return;
    await this.pullConversations();
  }

  // Older builds never queued synced chats again. Check each local cloud ID:
  // a delta pull cannot see unchanged copies, and timestamp-only snapshot
  // pagination can skip chats created in the same second at a page boundary.
  private async repairUnsentChatMessages(accountId: string): Promise<void> {
    const key = `${CHAT_MESSAGE_REPAIR_PREFIX}${accountId}`;
    const state = localStorage.getItem(key);
    if (state === "done" || Date.now() < Number(state)) return;
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    let checked = false;
    try {
      const conversations =
        (await window.electronAPI.getSyncedLinkedConversations?.(authGeneration)) ?? [];
      stopIfPullStale(conversations);
      for (const conversation of conversations) {
        stopIfSignInReplaced(authGeneration);
        if (!this.canSync()) return;
        const local = await window.electronAPI.getAgentConversation?.(conversation.id);
        if (
          !local ||
          local.cloud_id !== conversation.cloud_id ||
          !(await this.canUploadConversation(local))
        )
          continue;
        try {
          const { messages } = await ConversationsService.listMessages(
            conversation.cloud_id,
            authGeneration
          );
          stopIfSignInReplaced(authGeneration);
          if (cloudCopyIsMissingMessages(local.messages, messages)) {
            stopIfPullStale(
              await window.electronAPI.markConversationPending?.(local.id, authGeneration)
            );
          }
        } catch (error) {
          // Normal delete reconciliation handles cloud copies that no longer exist.
          if (!isHttpStatus(error, 404)) throw error;
        }
      }
      await assertAuthGenerationCurrent(authGeneration);
      checked = true;
    } catch (error) {
      if (!isAuthContextError(error)) console.error("Chat message repair failed:", error);
    }
    // A check the sign-in ended under says nothing about this account's chats.
    if (!this.passIsCurrent()) return;
    localStorage.setItem(key, checked ? "done" : String(Date.now() + CHAT_MESSAGE_REPAIR_RETRY_MS));
  }

  private async pushPendingConversations(): Promise<void> {
    const sender = chatPushSender();
    if (!sender) return;
    const pending = (await window.electronAPI.getPendingConversations?.()) ?? [];
    if (pending.length === 0) return;

    const linked = pending.filter((c) => c.cloud_id);
    const fresh = pending.filter((c) => !c.cloud_id);

    for (const conv of linked) {
      try {
        await this.sendMissingConversationContent(conv.id, conv.cloud_id!, sender);
      } catch (err) {
        if (!isAuthContextError(err)) console.error("Linked conversation sync failed:", err);
      }
    }

    for (const conv of fresh) {
      try {
        const full = await window.electronAPI.getAgentConversation?.(conv.id);
        if (!full || hasTurnInProgress(full)) continue;
        await this.createCloudConversation(full, sender);
      } catch (err) {
        if (!isAuthContextError(err)) console.error("Conversation sync failed:", err);
      }
    }
  }

  private async pushConversationDeletes(): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const sender = chatPushSender();
    if (sender) await this.deleteOrphanedChatCreates(sender);
    const queue = this.openDeleteQueue("conversations", sender?.accountId ?? null);
    const deletes = (await window.electronAPI.getPendingConversationDeletes?.()) ?? [];
    for (const conv of deletes) {
      if (!conv.cloud_id || queue.isParked(conv)) continue;
      try {
        await ConversationsService.delete(conv.cloud_id, authGeneration);
        await window.electronAPI.hardDeleteConversation?.(conv.id, authGeneration);
      } catch (err) {
        // 404: this account's cloud holds no live copy.
        if (isHttpStatus(err, 404)) {
          if (await queue.endsUnconfirmed(conv)) {
            await window.electronAPI.hardDeleteConversation?.(conv.id, authGeneration);
          }
        } else {
          if (!isAuthContextError(err)) console.error("Conversation delete sync failed:", err);
        }
      }
    }
    queue.save();
  }

  private async pullConversations(snapshot = false): Promise<boolean> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return false;
    try {
      const since = snapshot
        ? undefined
        : (localStorage.getItem("lastSyncedAt.conversations") ?? undefined);
      const startedAtMs = Date.now();

      let cursor: string | undefined = since;
      while (true) {
        const { conversations: cloudConvs } = since
          ? await ConversationsService.list(BATCH_SIZE, undefined, false, "messages", cursor)
          : await ConversationsService.list(BATCH_SIZE, cursor, false, "messages");
        if (cloudConvs.length === 0) break;

        for (const cloudConv of cloudConvs) {
          const local = await window.electronAPI.getConversationByClientId?.(
            cloudConv.client_conversation_id ?? ""
          );

          // As with held notes, the parent folder operation owns this row.
          // A denial revives it first and immediately runs this same pull in
          // snapshot mode, so authoritative remote changes are not lost.
          if (local?.folder_delete_pending || local?.device_only) continue;

          // A tombstone speaks only for the copy this row is linked to. A live row
          // that isn't linked to it still has the only copy of its chat. A row
          // deleted here before its create receipt arrived has nothing else to
          // clear it, since the delete queue needs a cloud id.
          if (cloudConv.deleted_at) {
            const isLinkedCopy = local?.cloud_id === cloudConv.id;
            if (local && (isLinkedCopy || (local.deleted_at && !local.cloud_id))) {
              stopIfPullStale(
                await window.electronAPI.hardDeleteConversation?.(local.id, authGeneration)
              );
            }
            continue;
          }

          // The account's own cloud returning an unattributed chat proves whose
          // it is. Claimed apart from applying the copy, which the rules below
          // may hold back: a claim never touches the chat's messages.
          if (local && !local.account_id) {
            stopIfPullStale(
              await window.electronAPI.claimConversationFromCloud?.(
                cloudConv as unknown as Record<string, unknown>,
                authGeneration
              )
            );
          }

          // A live cloud row cannot override a local pending delete. The
          // tombstone stays queued for push; only the cloud tombstone branch
          // above is authoritative enough to hard-delete it locally.
          if (local?.deleted_at) continue;

          // The next push sends what this row is still missing from the cloud.
          if (local?.cloud_id && local.sync_status === "pending") continue;

          // A linked chat the cloud is missing messages of was settled as synced
          // by an older build, which never queued a chat again after its first
          // upload; queued now, the next push sends only what's missing. The
          // counts come first, so a complete chat costs no lookup.
          if (
            local?.cloud_id === cloudConv.id &&
            local.message_count > (cloudConv.messages?.length ?? 0)
          ) {
            const full = await window.electronAPI.getAgentConversation?.(local.id);
            stopIfSignInReplaced(authGeneration);
            if (full && cloudCopyIsMissingMessages(full.messages, cloudConv.messages ?? [])) {
              stopIfPullStale(
                await window.electronAPI.markConversationPending?.(local.id, authGeneration)
              );
              continue;
            }
          }

          // Applying a cloud copy replaces every local message, and messages added
          // after a chat's first create exist only on this device.
          const holdsLocalHistory =
            (cloudConv.messages?.length ?? 0) >= (local?.message_count ?? 0);
          if (
            !local ||
            (holdsLocalHistory && isCloudEntryNewer(cloudConv.updated_at, local.updated_at))
          ) {
            stopIfPullStale(
              await window.electronAPI.upsertConversationFromCloud?.(
                cloudConv as unknown as Record<string, unknown>,
                (cloudConv.messages ?? []) as unknown as Array<Record<string, unknown>>,
                local ?? null,
                authGeneration
              )
            );
          }
        }

        if (cloudConvs.length < BATCH_SIZE) break;
        const last = cloudConvs[cloudConvs.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor) break;
        cursor = next;
      }

      await assertAuthGenerationCurrent(authGeneration);
      if (!snapshot) localStorage.setItem("lastSyncedAt.conversations", serverTimeIso(startedAtMs));
      return true;
    } catch (err) {
      if (!isAuthContextError(err)) console.error("Conversation pull failed:", err);
      return false;
    }
  }

  // The Insights view uses this same guarded path before reading the account
  // summary, so queued uploads and foreground refreshes use one consent gate.
  async syncAnalyticsNow(): Promise<boolean> {
    return this.syncAnalytics();
  }

  // Push-only: the account summary is read live by the Insights view, so there
  // is nothing to pull back into the device's own counters.
  private async syncAnalytics(): Promise<boolean> {
    const consent = this.consent();
    if (!consent.shared) return false;
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null) return false;
    const participationContext = { userId: accountId, authGeneration };
    // A leaderboard opt-out outlives the window that made it, so every pass
    // retries the one this account is still waiting for. It only ever leaves,
    // and nothing below depends on whether it has landed, so it runs beside
    // the pass rather than ahead of it: this method executes under
    // SYNC_ALL_LOCK and cloud requests carry no timeout, so awaiting it here
    // let one hung PATCH hold every window's sync behind the lock.
    void LeaderboardService.flushPendingLeave(participationContext).catch((error: unknown) => {
      // The account changing mid-queue is expected; the gate below sees it too.
      if (!isAuthContextError(error)) {
        console.error("Retrying the leaderboard leave failed:", error);
      }
    });
    // Participation controls roster visibility, not analytics consent. A
    // missing or failed participation route must never interrupt Insights Sync.
    const uploadRequested = consent.analytics;
    let uploadAllowed = false;
    const verifyUploadAllowed = async (): Promise<boolean> => {
      await assertAuthGenerationCurrent(authGeneration);
      const current = getAuthRequestContextSnapshot();
      if (
        current.sessionUserId !== accountId ||
        current.sessionGeneration !== authGeneration ||
        current.validatedGeneration !== authGeneration
      ) {
        throw Object.assign(new Error("Authentication context changed during analytics sync"), {
          code: "AUTH_CONTEXT_CHANGED",
        });
      }
      // A pass requested while local sync was off may run erasures, but must
      // never gain upload authority merely because a later setting changed.
      uploadAllowed = uploadRequested && this.consent().analytics;
      return uploadAllowed;
    };
    try {
      // Revoking retention/Insights consent blocks new uploads, never deletion
      // of rows that may already exist in the account. The gate itself reaches
      // the head of AnalyticsService's queue before it resolves, so a local
      // opt-out while another pass runs still wins before rows are read.
      if (
        (await syncPendingAnalytics({
          uploadAllowed: verifyUploadAllowed,
          context: { accountId, authGeneration },
        })) > 0
      ) {
        this.analyticsPassMovedWork = true;
      }
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      // A rejected batch stays pending for the next pass; the rest of this one
      // still has folders, notes, and transcriptions to finish.
      console.error("Analytics sync failed:", err);
      return false;
    }
    return uploadAllowed && this.consent().analytics;
  }

  private async syncTranscriptions(): Promise<void> {
    await this.pushPendingTranscriptions();
    if (!this.passIsCurrent()) return;
    await this.pushTranscriptionDeletes();
    if (!this.passIsCurrent()) return;
    await this.pullTranscriptions();
  }

  private async pushTranscriptionDeletes(): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const queue = this.openDeleteQueue(
      "transcriptions",
      getAuthRequestContextSnapshot().sessionUserId
    );
    const deletes = (await window.electronAPI.getPendingTranscriptionDeletes?.()) ?? [];
    const withCloudId = deletes.filter((t) => t.cloud_id && !queue.isParked(t));

    for (let i = 0; i < withCloudId.length; i += TRANSCRIPTION_BATCH_SIZE) {
      const chunk = withCloudId.slice(i, i + TRANSCRIPTION_BATCH_SIZE);
      try {
        const { deleted } = await TranscriptionsService.batchDelete(
          chunk.map((t) => t.cloud_id!),
          authGeneration
        );
        // The response lists only rows this request deleted. One it leaves out
        // is not live in this account's cloud, so its retry would never end.
        const confirmed = new Set(deleted);
        for (const local of chunk) {
          if (confirmed.has(local.cloud_id!) || (await queue.endsUnconfirmed(local))) {
            await window.electronAPI.hardDeleteTranscription?.(local.id, authGeneration);
          }
        }
      } catch (err) {
        if (!isAuthContextError(err)) console.error("Transcription batch delete failed:", err);
      }
    }
    queue.save();
  }

  private async pushPendingTranscriptions(): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const pending = ((await window.electronAPI.getPendingTranscriptions?.()) ?? []).filter(
      (t) => t.status !== "failed" && !!t.text?.trim()
    );
    if (pending.length === 0) return;

    for (let i = 0; i < pending.length; i += TRANSCRIPTION_BATCH_SIZE) {
      const chunk = pending.slice(i, i + TRANSCRIPTION_BATCH_SIZE);
      try {
        const { created } = await TranscriptionsService.batchCreate(
          chunk.map((t) => ({
            client_transcription_id: t.client_transcription_id,
            text: t.text,
            raw_text: t.raw_text,
            provider: t.provider,
            model: t.model,
            audio_duration_ms: t.audio_duration_ms,
            status: t.status,
            created_at: t.created_at,
          })),
          authGeneration
        );
        for (const cloudT of created) {
          const local = chunk.find(
            (t) => t.client_transcription_id === cloudT.client_transcription_id
          );
          if (local) await this.acknowledgeTranscriptionCreate(local.id, cloudT.id, authGeneration);
        }
      } catch (err) {
        if (!isAuthContextError(err)) console.error("Transcription batch create failed:", err);
      }
    }
  }

  private async pullTranscriptions(snapshot = false): Promise<boolean> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return false;
    try {
      const since = snapshot
        ? undefined
        : (localStorage.getItem("lastSyncedAt.transcriptions") ?? undefined);
      const startedAtMs = Date.now();

      let cursor: string | undefined = since;
      while (true) {
        const { transcriptions: cloudTs } = since
          ? await TranscriptionsService.list(TRANSCRIPTION_BATCH_SIZE, undefined, cursor)
          : await TranscriptionsService.list(TRANSCRIPTION_BATCH_SIZE, cursor);
        if (cloudTs.length === 0) break;

        for (const cloudT of cloudTs) {
          const local = await window.electronAPI.getTranscriptionByClientId?.(
            cloudT.client_transcription_id ?? ""
          );

          if (cloudT.deleted_at) {
            if (local) {
              stopIfPullStale(
                await window.electronAPI.hardDeleteTranscription?.(local.id, authGeneration)
              );
            }
            continue;
          }

          if (!cloudT.text) continue;

          if (!local || !local.account_id) {
            stopIfPullStale(
              await window.electronAPI.upsertTranscriptionFromCloud?.(
                cloudT as unknown as Record<string, unknown>,
                authGeneration
              )
            );
          }
        }

        if (cloudTs.length < TRANSCRIPTION_BATCH_SIZE) break;
        const last = cloudTs[cloudTs.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor) break;
        cursor = next;
      }

      await assertAuthGenerationCurrent(authGeneration);
      if (!snapshot)
        localStorage.setItem("lastSyncedAt.transcriptions", serverTimeIso(startedAtMs));
      return true;
    } catch (err) {
      if (!isAuthContextError(err)) console.error("Transcription pull failed:", err);
      return false;
    }
  }

  private async syncDictionary(): Promise<boolean> {
    // Fail loud on preload skew: a missing binding silently optional-chained to
    // a no-op would lose user data, so assert the whole surface up front.
    const api = window.electronAPI;
    const required = [
      "getPendingDictionary",
      "getPendingDictionaryDeletes",
      "getDictionaryByClientId",
      "upsertDictionaryFromCloud",
      "markDictionarySynced",
      "hardDeleteDictionary",
      "clearDictionaryCloudId",
      "broadcastDictionaryUpdated",
    ] as const;
    const missing = required.filter((name) => typeof api[name] !== "function");
    if (missing.length > 0) {
      throw new Error(
        `Dictionary IPC bindings missing — preload out of date: ${missing.join(", ")}`
      );
    }

    const pushed = await this.pushPendingDictionary();
    if (!this.passIsCurrent()) return false;
    const deleted = await this.pushDictionaryDeletes();
    if (!this.passIsCurrent()) return false;
    const pulled = await this.pullDictionary();
    return pushed && deleted && pulled;
  }

  private async pushPendingDictionary(): Promise<boolean> {
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return false;
    const pending = (await window.electronAPI.getPendingDictionary?.()) ?? [];
    if (pending.length === 0) return true;
    let succeeded = true;

    const updates = pending.filter((e) => e.cloud_id);
    const creates = pending.filter((e) => !e.cloud_id);

    const parkedKey = parked404Key("dictionary", accountId);
    const parked = this.readLocalRecord<string>(parkedKey);
    const stillParked: Record<string, string> = {};
    for (const entry of updates) {
      // The account's own row is re-created, so it is never parked.
      const own = accountId !== null && entry.account_id === accountId;
      if (!own && parked[entry.client_dict_id] === entry.updated_at) {
        stillParked[entry.client_dict_id] = entry.updated_at;
        continue;
      }
      try {
        const server = await DictionaryService.update(
          entry.cloud_id!,
          {
            word: entry.word,
            source: entry.source,
            // Only a local set or clear: an ordinary edit leaves the server's
            // value alone, which another device may have set meanwhile.
            ...(entry.shared_at_dirty ? { shared_at: toCloudSharedAt(entry.shared_at) } : {}),
          },
          authGeneration
        );
        await window.electronAPI.markDictionarySynced?.(
          entry.id,
          server.id,
          server.updated_at,
          entry.word,
          entry.source,
          server.source,
          entry,
          authGeneration
        );
      } catch (err) {
        succeeded = false;
        // 404: the cloud row is gone. The account's own row loses its stale
        // cloud_id, so the next push re-creates it; an unattributed one is
        // parked instead (see PARKED_UPDATE_404_PREFIX). A clear refused for a
        // replaced sign-in decides nothing, and the row stays for the next pass.
        if (isHttpStatus(err, 404)) {
          const cleared = await window.electronAPI.clearDictionaryCloudId?.(
            entry.id,
            authGeneration
          );
          if (!own && !cleared?.success && !cleared?.stale) {
            stillParked[entry.client_dict_id] = entry.updated_at;
          }
        } else {
          if (!isAuthContextError(err)) console.error("Dictionary update sync failed:", err);
        }
      }
    }
    this.writeLocalRecord(parkedKey, stillParked);

    for (let i = 0; i < creates.length; i += DICTIONARY_BATCH_SIZE) {
      const chunk = creates.slice(i, i + DICTIONARY_BATCH_SIZE);
      try {
        const { created } = await DictionaryService.batchCreate(
          chunk.map((e) => ({
            client_dict_id: e.client_dict_id,
            word: e.word,
            source: e.source,
            created_at: e.created_at,
            updated_at: e.updated_at,
            // Absent keeps the server's value (a re-created row may revive a
            // tombstone); a moved word resends it, and a local clear sends null.
            ...(e.shared_at || e.shared_at_dirty
              ? { shared_at: toCloudSharedAt(e.shared_at) }
              : {}),
          })),
          authGeneration
        );
        const byClientId = new Map(created.map((c) => [c.client_dict_id, c]));
        let unmatched = 0;
        for (const local of chunk) {
          const server = byClientId.get(local.client_dict_id);
          if (!server) {
            unmatched += 1;
            continue;
          }
          // 0 changes means the local row was deleted between snapshot and ack —
          // delete the freshly-created server row so we don't orphan it. A stale
          // ack (the account changed) never cleans up: the server merges a create
          // into an existing word, so that row may be the account's own.
          const result = await window.electronAPI.markDictionarySynced?.(
            local.id,
            server.id,
            server.updated_at,
            local.word,
            local.source,
            server.source,
            local,
            authGeneration
          );
          if (result && result.changes === 0 && !result.stale) {
            try {
              await DictionaryService.delete(server.id, authGeneration);
            } catch (deleteErr) {
              succeeded = false;
              console.error("Dictionary orphan cleanup failed:", deleteErr);
            }
          }
        }
        if (unmatched > 0) {
          succeeded = false;
          console.warn(
            `Dictionary batch-create: ${unmatched}/${chunk.length} rows had no matching server response`
          );
        }
      } catch (err) {
        succeeded = false;
        if (!isAuthContextError(err)) console.error("Dictionary batch create failed:", err);
      }
    }
    return succeeded;
  }

  private async pushDictionaryDeletes(): Promise<boolean> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return false;
    let succeeded = true;
    const queue = this.openDeleteQueue("dictionary", getAuthRequestContextSnapshot().sessionUserId);
    const deletes = (await window.electronAPI.getPendingDictionaryDeletes?.()) ?? [];
    for (const entry of deletes) {
      if (!entry.cloud_id || queue.isParked(entry)) continue;
      try {
        await DictionaryService.delete(entry.cloud_id, authGeneration);
        await window.electronAPI.hardDeleteDictionary?.(entry.id, authGeneration);
      } catch (err) {
        // 404: this account's cloud holds no live copy.
        if (isHttpStatus(err, 404)) {
          if (await queue.endsUnconfirmed(entry)) {
            await window.electronAPI.hardDeleteDictionary?.(entry.id, authGeneration);
          }
        } else {
          succeeded = false;
          if (!isAuthContextError(err)) console.error("Dictionary delete sync failed:", err);
        }
      }
    }
    queue.save();
    return succeeded;
  }

  // A snapshot walks every row from the epoch and leaves the cursors alone.
  private async pullDictionary(snapshot = false): Promise<boolean> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return false;
    let changed = false;
    let succeeded = true;
    try {
      const since = snapshot
        ? DICTIONARY_PULL_EPOCH
        : (localStorage.getItem("lastSyncedAt.dictionary") ?? DICTIONARY_PULL_EPOCH);
      const sinceId = snapshot
        ? undefined
        : (localStorage.getItem("lastSyncedAt.dictionary.id") ?? undefined);

      let cursor: string | undefined = since;
      let cursorId: string | undefined = sinceId;
      let maxUpdatedAt = normalizeTimestamp(since);
      let maxId = sinceId ?? "";
      // Starting at the epoch includes tombstones when backfilling moved words.
      // Keep every page on the updated_at keyset, including the first: switching
      // from created_at ordering would skip words edited out of creation order.
      while (true) {
        const { entries, hasMore } = await DictionaryService.listDelta(
          cursor,
          DICTIONARY_BATCH_SIZE,
          cursorId
        );
        if (entries.length === 0) break;

        for (const cloudEntry of entries) {
          const local = await window.electronAPI.getDictionaryByClientId?.(
            cloudEntry.client_dict_id ?? ""
          );

          // Last-writer-wins on normalized timestamps (see normalizeTimestamp).
          const cloudTs = normalizeTimestamp(cloudEntry.updated_at);
          const localTs = local ? normalizeTimestamp(local.updated_at) : "";

          if (cloudEntry.deleted_at) {
            // A pull from the epoch sees old tombstones too; a newer local
            // edit still waiting to be pushed outlives them. A live one is
            // re-created: its cloud id is dead, and on a device another
            // account has used its 404 would otherwise park it for good.
            if (local?.sync_status === "pending" && localTs > cloudTs) {
              if (!local.deleted_at) {
                stopIfPullStale(
                  await window.electronAPI.keepNewerDictionaryEdit?.(local.id, authGeneration)
                );
              }
            } else if (local) {
              stopIfPullStale(
                await window.electronAPI.hardDeleteDictionary?.(local.id, authGeneration)
              );
              changed = true;
            }
          } else if (
            !local ||
            !local.account_id ||
            cloudTs > localTs ||
            // A fallback retired here is only this device's guess; a live
            // cloud row means the server kept it.
            (local.deleted_at && local.fallback_retired) ||
            sharedAtOnlyDiffers(cloudEntry, local, cloudTs, localTs)
          ) {
            stopIfPullStale(
              await window.electronAPI.upsertDictionaryFromCloud?.(
                cloudEntry as unknown as Record<string, unknown>,
                authGeneration
              )
            );
            changed = true;
          }

          if (cloudTs > maxUpdatedAt) {
            maxUpdatedAt = cloudTs;
            maxId = cloudEntry.id;
          } else if (cloudTs === maxUpdatedAt && cloudEntry.id > maxId) {
            maxId = cloudEntry.id;
          }
        }

        if (!hasMore) break;
        const last = entries[entries.length - 1];
        // Stall guard: a page that ends where it started would loop forever.
        // An API whose timestamps are finer than the cursor it accepts repeats
        // a batch written at one instant, so this keeps what the applied pages
        // reached and ends the pass rather than failing: a pull that saved
        // nothing would download everything again on every pass.
        if (last.updated_at === cursor && last.id === cursorId) {
          succeeded = false;
          console.warn("Dictionary pull stopped advancing; resuming next pass", {
            cursor,
            cursorId,
          });
          break;
        }
        cursor = last.updated_at;
        cursorId = last.id;
      }

      await assertAuthGenerationCurrent(authGeneration);
      if (!snapshot) {
        if (maxUpdatedAt) localStorage.setItem("lastSyncedAt.dictionary", maxUpdatedAt);
        if (maxId) localStorage.setItem("lastSyncedAt.dictionary.id", maxId);
      }
    } catch (err) {
      succeeded = false;
      if (!isAuthContextError(err)) console.error("Dictionary pull failed:", err);
    }
    // Pages applied before a failure are already in the database.
    if (changed) await window.electronAPI.broadcastDictionaryUpdated?.()?.catch(console.error);
    return succeeded;
  }

  // Dropping the cursor makes the next pull read from the epoch, tombstones
  // included. An interrupted pull saves no cursor, so it simply starts over.
  private backfillPersonalSharedAt(): void {
    if (localStorage.getItem(DICTIONARY_SHARED_AT_BACKFILL_KEY) != null) return;
    localStorage.removeItem("lastSyncedAt.dictionary");
    localStorage.removeItem("lastSyncedAt.dictionary.id");
    localStorage.setItem(DICTIONARY_SHARED_AT_BACKFILL_KEY, "true");
  }

  /**
   * Mirrors the active workspace's shared lists and the member's hides. DB
   * writes are keyed by workspace and always safe; publishing (the store's
   * load, the hints) and the arrival event happen only while the account and
   * workspace the pass started under are still current.
   */
  private async syncSharedDictionary(authGeneration: number): Promise<DictionarySyncResult> {
    this.backfillPersonalSharedAt();
    this.sharedDictionaryPassChanged = false;
    const store = useSharedDictionaryStore.getState();
    const generation = store.generation;
    // Not this window's store: it follows a switch made in another window a
    // task later, and a pass for the old workspace must not publish.
    const workspaceId = readActiveWorkspaceId();
    const isCurrent = (): boolean => {
      const current = useSharedDictionaryStore.getState();
      return current.generation === generation && current.workspaceId === workspaceId;
    };
    const api = window.electronAPI;

    try {
      const required = [
        "getSharedDictionary",
        "applySharedDictionaryPull",
        "replaceSharedDictionary",
        "applySharedDictionaryHides",
        "replaceSharedDictionaryHides",
        "clearSharedDictionary",
        "pruneSharedDictionary",
      ] as const;
      const missing = required.filter((name) => typeof api?.[name] !== "function");
      if (missing.length > 0) {
        throw new Error(
          `Shared dictionary IPC bindings missing — preload out of date: ${missing.join(", ")}`
        );
      }

      // Only the workspaces the member left go: a switch back to one they
      // still belong to then needs no full re-download. Without a loaded list
      // nobody can tell, so every mirror stays until one loads.
      const { loaded, error, workspaces } = useWorkspaceStore.getState();
      if (loaded && !error) {
        const keep = workspaces.map((workspace) => workspace.id);
        // A list loaded before the switch may not name the active one yet.
        if (workspaceId && !keep.includes(workspaceId)) keep.push(workspaceId);
        const result = await api.pruneSharedDictionary!(keep);
        this.noteSharedDictionaryChange(result?.changed);
        clearSharedCursorsExcept(keep);
      }

      if (!workspaceId) {
        if (isCurrent()) {
          useSettingsStore.getState().setSharedDictionaryHints(EMPTY_SHARED_HINTS, null);
        }
        return "skipped";
      }
      if (this.sharedDictionaryRoutesMissingFor === authGeneration) return "skipped";

      if (isCurrent()) store.setSyncing(true);
      const before = await api.getSharedDictionary!(workspaceId);
      // Billing may have changed on another device since this mirror paused.
      await this.pullSharedDictionary(workspaceId, before, authGeneration);
      store.setStatus("ready", workspaceId);

      if (!isCurrent()) return "skipped";
      const mirrorLoaded = await store.load(workspaceId, generation);
      if (!isCurrent()) return "skipped";
      if (!mirrorLoaded) return "failed";
      if (
        useSharedDictionaryStore.getState().snapshot?.meta?.paused === false &&
        isKnownWithoutSharedDictionaryPlan(workspaceId)
      ) {
        // The server resumed sharing; refresh the billing that gates its controls.
        await assertAuthGenerationCurrent(authGeneration);
        await useWorkspaceStore.getState().refresh();
        if (!isCurrent()) return "skipped";
        if (useWorkspaceStore.getState().error) return "failed";
      }
      this.announceSharedDictionaryArrival(workspaceId, countApplyingSharedWords(before));
      return "synced";
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      const lostAccess = workspaceId ? sharedDictionaryAccessLost(err) : null;
      if (workspaceId && lostAccess) {
        // The refusal may have been answered under the next account's token.
        await assertAuthGenerationCurrent(authGeneration);
        clearSharedCursors(workspaceId);
        let cleared = true;
        try {
          const result = await api?.clearSharedDictionary?.(workspaceId);
          // Only a clear that removed something is work: a member who stays
          // locked out must not pin the ambient cadence on every pass.
          this.noteSharedDictionaryChange(result?.changed);
        } catch (clearErr) {
          cleared = false;
          console.error("Shared dictionary cleanup failed:", clearErr);
        }
        store.setStatus(lostAccess, workspaceId);
        if (!isCurrent()) return "skipped";
        // A load after a failed clear would republish the lost lists' words.
        if (cleared) await store.load(workspaceId, generation);
        else useSettingsStore.getState().setSharedDictionaryHints(EMPTY_SHARED_HINTS, workspaceId);
        return "skipped";
      }
      // A plain 404 is an API without the shared dictionary routes: nothing
      // to sync, nothing to tell the user.
      if (isHttpStatus(err, 404)) {
        this.sharedDictionaryRoutesMissingFor = authGeneration;
        store.setStatus("unavailable", workspaceId);
        return "skipped";
      }
      console.error("Shared dictionary sync failed:", err);
      return "failed";
    } finally {
      if (isCurrent()) useSharedDictionaryStore.getState().setSyncing(false);
      // Lets every window's Dictionary page reload a mirror this pass rewrote,
      // including pages applied before a failure.
      if (workspaceId && this.sharedDictionaryPassChanged) {
        this.emitSyncUiEvent("shared-dictionary-changed", { workspaceId });
      }
    }
  }

  private noteSharedDictionaryChange(changed: number | undefined): void {
    if (!changed) return;
    this.teamPassMovedWork = true;
    this.sharedDictionaryPassChanged = true;
  }

  // Recorded, not marked welcomed: the toast lives in the control panel, which
  // may be closed or in the tray. It takes the arrival when it's shown (see
  // SharedDictionaryArrivalToastListener); the event only tells an open one.
  private announceSharedDictionaryArrival(workspaceId: string, applyingBefore: number): void {
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    if (!accountId) return;
    const count = countApplyingSharedWords(useSharedDictionaryStore.getState().snapshot);
    if (applyingBefore > 0 || count === 0) return;
    if (hasWelcomedSharedDictionary(accountId, workspaceId)) return;
    const arrival = { accountId, workspaceId, count };
    recordSharedDictionaryArrival(arrival);
    this.emitSyncUiEvent("shared-dictionary-arrived", arrival);
  }

  // An expired cursor or a returning list re-runs the whole pass as a snapshot,
  // once; that snapshot can't expire (see pullSharedEntries for a list joined
  // during it).
  private async pullSharedDictionary(
    workspaceId: string,
    before: SharedDictionarySnapshot,
    authGeneration: number
  ): Promise<void> {
    let forceSnapshot = false;
    while (true) {
      try {
        const entries = await this.pullSharedEntries(
          workspaceId,
          forceSnapshot ? null : before,
          authGeneration
        );
        if (entries === "scopesReturned") {
          clearSharedCursors(workspaceId);
          forceSnapshot = true;
          continue;
        }
        await this.pullSharedHides(workspaceId, entries === "snapshot", authGeneration);
        return;
      } catch (err) {
        if (forceSnapshot || !isSharedDictionaryCursorExpired(err)) throw err;
        clearSharedCursors(workspaceId);
        forceSnapshot = true;
      }
    }
  }

  // `mirror` is the workspace's mirror before the pass; null forces the pass's
  // one re-run as a snapshot.
  private async pullSharedEntries(
    workspaceId: string,
    mirror: SharedDictionarySnapshot | null,
    authGeneration: number
  ): Promise<SharedEntriesPull> {
    const api = window.electronAPI;
    const key = sharedEntriesCursorKey(workspaceId);
    const stored = readSharedCursor(key);
    const storedMeta = mirror?.meta ?? null;
    const limit = SHARED_DICTIONARY_PAGE_LIMIT;

    // No cursor, or no mirror to apply a delta to: page the whole snapshot
    // into memory and write it once, so a pass cut short never half-replaces.
    if (!stored || !storedMeta) {
      const entries: CloudSharedEntry[] = [];
      const contributors: SharedContributor[][] = [];
      let page: SharedDictionaryPage = { limit };
      let passStartedAt: string | undefined;
      let firstScopes: SharedScope[] | undefined;
      while (true) {
        const response = await SharedDictionaryService.list(workspaceId, page);
        await assertAuthGenerationCurrent(authGeneration);
        passStartedAt ??= response.server_time;
        firstScopes ??= response.scopes;
        entries.push(...response.entries);
        contributors.push(response.contributors);
        if (response.hasMore) {
          const last = response.entries.at(-1);
          if (!last || (last.created_at === page.cursor && last.id === page.cursorId)) {
            throw new Error("Shared dictionary snapshot stopped advancing");
          }
          page = { cursor: last.created_at, cursorId: last.id, limit };
          continue;
        }
        // A list the member joined after the first page (added to a space
        // mid-pass) had its older rows paged past already: re-run once, and
        // after that keep what was read but store no cursor, so the next pass
        // snapshots again.
        const joinedMidPass = hasReturningScope(firstScopes, response.scopes);
        if (mirror && joinedMidPass) return "scopesReturned";
        const meta: SharedDictionaryMeta = {
          scopes: response.scopes,
          contributors: mergeContributors(contributors),
          paused: response.paused,
        };
        const result = await api.replaceSharedDictionary!(workspaceId, { entries, meta });
        this.noteSharedDictionaryChange(result?.changed);
        if (!joinedMidPass) writeSharedCursor(key, null, passStartedAt);
        return "snapshot";
      }
    }

    // Starts before the stored cursor (see DELTA_READ_OVERLAP_MS),
    // with no since_id, and re-applies the overlap idempotently.
    const contributors: SharedContributor[][] = [];
    const adderIds = new Set(
      (mirror?.entries ?? []).flatMap((entry) => (entry.addedByUserId ? [entry.addedByUserId] : []))
    );
    let page: SharedDictionaryPage = { since: overlappedSince(stored), limit };
    let passStartedAt: string | undefined;
    while (true) {
      const response = await SharedDictionaryService.list(workspaceId, page);
      await assertAuthGenerationCurrent(authGeneration);
      passStartedAt ??= response.server_time;
      contributors.push(response.contributors);
      const upserts = response.entries.filter((entry) => !entry.deleted_at);
      for (const entry of upserts) {
        if (entry.added_by_user_id) adderIds.add(entry.added_by_user_id);
      }
      const deletedIds = response.entries
        .filter((entry) => entry.deleted_at)
        .map((entry) => entry.id);
      const last = response.entries.at(-1);

      if (response.hasMore) {
        const result = await api.applySharedDictionaryPull!(workspaceId, { upserts, deletedIds });
        this.noteSharedDictionaryChange(result?.changed);
        // Stall guard: the next request must start after this one.
        if (!last || (last.updated_at === page.since && last.id === page.sinceId)) {
          throw new Error("Shared dictionary delta stopped advancing");
        }
        page = { since: last.updated_at, sinceId: last.id, limit };
        continue;
      }

      if (hasReturningScope(storedMeta.scopes, response.scopes)) return "scopesReturned";
      const meta: SharedDictionaryMeta = {
        scopes: response.scopes,
        contributors: deltaPassContributors(storedMeta.contributors, adderIds, contributors),
        paused: response.paused,
      };
      const result = await api.applySharedDictionaryPull!(workspaceId, {
        upserts,
        deletedIds,
        meta,
      });
      this.noteSharedDictionaryChange(result?.changed);
      writeSharedCursor(key, stored, passStartedAt);
      return "delta";
    }
  }

  private async pullSharedHides(
    workspaceId: string,
    snapshot: boolean,
    authGeneration: number
  ): Promise<void> {
    const api = window.electronAPI;
    const key = sharedHidesCursorKey(workspaceId);
    const stored = snapshot ? null : readSharedCursor(key);
    const limit = SHARED_DICTIONARY_PAGE_LIMIT;
    const toRecord = (hide: CloudSharedHide): SharedDictionaryHideRecord => ({
      entryId: hide.entry_id,
      updatedAt: hide.updated_at,
    });

    if (!stored) {
      const hidden: SharedDictionaryHideRecord[] = [];
      let page: SharedDictionaryPage = { limit };
      let passStartedAt: string | undefined;
      while (true) {
        const response = await SharedDictionaryService.hides(workspaceId, page);
        await assertAuthGenerationCurrent(authGeneration);
        passStartedAt ??= response.server_time;
        hidden.push(...response.hides.filter((hide) => !hide.deleted_at).map(toRecord));
        if (response.hasMore) {
          const last = response.hides.at(-1);
          if (!last || (last.updated_at === page.cursor && last.entry_id === page.cursorId)) {
            throw new Error("Shared dictionary hides snapshot stopped advancing");
          }
          page = { cursor: last.updated_at, cursorId: last.entry_id, limit };
          continue;
        }
        const result = await api.replaceSharedDictionaryHides!(workspaceId, hidden);
        this.noteSharedDictionaryChange(result?.changed);
        writeSharedCursor(key, null, passStartedAt);
        return;
      }
    }

    let page: SharedDictionaryPage = { since: overlappedSince(stored), limit };
    let passStartedAt: string | undefined;
    while (true) {
      const response = await SharedDictionaryService.hides(workspaceId, page);
      await assertAuthGenerationCurrent(authGeneration);
      passStartedAt ??= response.server_time;
      const result = await api.applySharedDictionaryHides!(workspaceId, {
        hidden: response.hides.filter((hide) => !hide.deleted_at).map(toRecord),
        unhidden: response.hides.filter((hide) => hide.deleted_at).map((hide) => hide.entry_id),
      });
      this.noteSharedDictionaryChange(result?.changed);
      const last = response.hides.at(-1);
      if (!response.hasMore) {
        writeSharedCursor(key, stored, passStartedAt);
        return;
      }
      if (!last || (last.updated_at === page.since && last.entry_id === page.sinceId)) {
        throw new Error("Shared dictionary hides delta stopped advancing");
      }
      page = { since: last.updated_at, sinceId: last.entry_id, limit };
    }
  }

  private async syncSnippets(): Promise<void> {
    const api = window.electronAPI;
    const required = [
      "getPendingSnippets",
      "getPendingSnippetDeletes",
      "getSnippetForCloudMerge",
      "upsertSnippetFromCloud",
      "markSnippetSynced",
      "hardDeleteSnippet",
      "clearSnippetCloudId",
      "broadcastSnippetsUpdated",
    ] as const;
    const missing = required.filter((name) => typeof api[name] !== "function");
    if (missing.length > 0) {
      throw new Error(`Snippet IPC bindings missing — preload out of date: ${missing.join(", ")}`);
    }

    await this.pushPendingSnippets();
    if (!this.passIsCurrent()) return;
    await this.pushSnippetDeletes();
    if (!this.passIsCurrent()) return;
    await this.pullSnippets();
  }

  private async pushPendingSnippets(): Promise<void> {
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const pending = (await window.electronAPI.getPendingSnippets?.()) ?? [];
    if (pending.length === 0) return;

    const updates = pending.filter((e) => e.cloud_id);
    const creates = pending.filter((e) => !e.cloud_id);

    const parkedKey = parked404Key("snippets", accountId);
    const parked = this.readLocalRecord<string>(parkedKey);
    const stillParked: Record<string, string> = {};
    for (const entry of updates) {
      const own = accountId !== null && entry.account_id === accountId;
      if (!own && parked[entry.client_snippet_id] === entry.updated_at) {
        stillParked[entry.client_snippet_id] = entry.updated_at;
        continue;
      }
      try {
        const server = await SnippetService.update(
          entry.cloud_id!,
          { trigger: entry.trigger, replacement: entry.replacement },
          authGeneration
        );
        await window.electronAPI.markSnippetSynced?.(
          entry.id,
          server.id,
          server.updated_at,
          entry.trigger,
          entry.replacement,
          authGeneration
        );
      } catch (err) {
        if (isHttpStatus(err, 404)) {
          // As with dictionary words: the account's own row is re-created, an
          // unattributed one is parked.
          const cleared = await window.electronAPI.clearSnippetCloudId?.(entry.id, authGeneration);
          if (!own && !cleared?.success && !cleared?.stale) {
            stillParked[entry.client_snippet_id] = entry.updated_at;
          }
        } else if (isHttpStatus(err, 409)) {
          // Another snippet already holds this trigger, so the server keeps
          // rejecting the rename. Mark synced to stop re-pushing the doomed PATCH.
          await window.electronAPI.markSnippetSynced?.(
            entry.id,
            entry.cloud_id!,
            undefined,
            entry.trigger,
            entry.replacement,
            authGeneration
          );
        } else {
          if (!isAuthContextError(err)) console.error("Snippet update sync failed:", err);
        }
      }
    }
    this.writeLocalRecord(parkedKey, stillParked);

    for (let i = 0; i < creates.length; i += SNIPPET_BATCH_SIZE) {
      const chunk = creates.slice(i, i + SNIPPET_BATCH_SIZE);
      try {
        const { created } = await SnippetService.batchCreate(
          chunk.map((e) => ({
            client_snippet_id: e.client_snippet_id,
            trigger: e.trigger,
            replacement: e.replacement,
            created_at: e.created_at,
            updated_at: e.updated_at,
          })),
          authGeneration
        );
        const byClientId = new Map(created.map((c) => [c.client_snippet_id, c]));
        let unmatched = 0;
        for (const local of chunk) {
          const server = byClientId.get(local.client_snippet_id);
          if (!server) {
            unmatched += 1;
            continue;
          }
          // As with dictionary words, a stale ack never cleans up.
          const result = await window.electronAPI.markSnippetSynced?.(
            local.id,
            server.id,
            server.updated_at,
            local.trigger,
            local.replacement,
            authGeneration
          );
          if (result && result.changes === 0 && !result.stale) {
            try {
              await SnippetService.delete(server.id, authGeneration);
            } catch (deleteErr) {
              console.error("Snippet orphan cleanup failed:", deleteErr);
            }
          }
        }
        if (unmatched > 0) {
          console.warn(
            `Snippet batch-create: ${unmatched}/${chunk.length} rows had no matching server response`
          );
        }
      } catch (err) {
        if (!isAuthContextError(err)) console.error("Snippet batch create failed:", err);
      }
    }
  }

  private async pushSnippetDeletes(): Promise<void> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    const queue = this.openDeleteQueue("snippets", getAuthRequestContextSnapshot().sessionUserId);
    const deletes = (await window.electronAPI.getPendingSnippetDeletes?.()) ?? [];
    for (const entry of deletes) {
      if (!entry.cloud_id || queue.isParked(entry)) continue;
      try {
        await SnippetService.delete(entry.cloud_id, authGeneration);
        await window.electronAPI.hardDeleteSnippet?.(entry.id, authGeneration);
      } catch (err) {
        // As with dictionary words.
        if (isHttpStatus(err, 404)) {
          if (await queue.endsUnconfirmed(entry)) {
            await window.electronAPI.hardDeleteSnippet?.(entry.id, authGeneration);
          }
        } else {
          if (!isAuthContextError(err)) console.error("Snippet delete sync failed:", err);
        }
      }
    }
    queue.save();
  }

  // As pullDictionary.
  private async pullSnippets(snapshot = false): Promise<boolean> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return false;
    try {
      const since = snapshot
        ? undefined
        : (localStorage.getItem("lastSyncedAt.snippets") ?? undefined);
      const sinceId = snapshot
        ? undefined
        : (localStorage.getItem("lastSyncedAt.snippets.id") ?? undefined);
      let changed = false;

      let cursor: string | undefined = since;
      let cursorId: string | undefined = sinceId;
      let maxUpdatedAt = normalizeTimestamp(since);
      let maxId = sinceId ?? "";
      const cursorField: keyof Pick<CloudSnippetEntry, "created_at" | "updated_at"> = since
        ? "updated_at"
        : "created_at";

      while (true) {
        const { entries, hasMore } = since
          ? await SnippetService.listDelta(cursor, SNIPPET_BATCH_SIZE, cursorId)
          : await SnippetService.listSnapshot(cursor, SNIPPET_BATCH_SIZE, cursorId);
        if (entries.length === 0) break;

        for (const cloudEntry of entries) {
          const cloudTs = normalizeTimestamp(cloudEntry.updated_at);
          const local = await window.electronAPI.getSnippetForCloudMerge?.(
            cloudEntry as unknown as Record<string, unknown>,
            authGeneration
          );
          stopIfPullStale(local);

          if (cloudTs > maxUpdatedAt) {
            maxUpdatedAt = cloudTs;
            maxId = cloudEntry.id;
          } else if (cloudTs === maxUpdatedAt && cloudEntry.id > maxId) {
            maxId = cloudEntry.id;
          }

          if (cloudEntry.deleted_at) {
            // As with dictionary words, a newer edit outlives the tombstone. Only
            // a row the tombstone matched by id is the deleted one; a pending
            // row with no cloud id that matched by trigger was never uploaded.
            const sameRow =
              local?.client_snippet_id === cloudEntry.client_snippet_id ||
              (local?.cloud_id != null && local.cloud_id === cloudEntry.id);
            if (
              local &&
              sameRow &&
              local.sync_status === "pending" &&
              !local.deleted_at &&
              normalizeTimestamp(local.updated_at) > cloudTs
            ) {
              stopIfPullStale(
                await window.electronAPI.keepNewerSnippetEdit?.(local.id, authGeneration)
              );
            } else if (local && !(local.sync_status === "pending" && !local.cloud_id)) {
              stopIfPullStale(
                await window.electronAPI.hardDeleteSnippet?.(local.id, authGeneration)
              );
              changed = true;
            }
            continue;
          }

          const localTs = local ? normalizeTimestamp(local.updated_at) : "";
          const shouldApply =
            !local ||
            (!local.account_id &&
              (local.client_snippet_id === cloudEntry.client_snippet_id ||
                local.cloud_id === cloudEntry.id)) ||
            cloudTs > localTs ||
            (local.sync_status !== "pending" &&
              (!local.cloud_id || local.cloud_id !== cloudEntry.id));
          if (shouldApply) {
            stopIfPullStale(
              await window.electronAPI.upsertSnippetFromCloud?.(
                cloudEntry as unknown as Record<string, unknown>,
                authGeneration
              )
            );
            changed = true;
          }
        }

        if (!hasMore) break;
        const last = entries[entries.length - 1];
        const nextCursor = last[cursorField];
        if (nextCursor === cursor && last.id === cursorId) break;
        cursor = nextCursor;
        cursorId = last.id;
      }

      await assertAuthGenerationCurrent(authGeneration);
      if (!snapshot) {
        if (maxUpdatedAt) localStorage.setItem("lastSyncedAt.snippets", maxUpdatedAt);
        if (maxId) localStorage.setItem("lastSyncedAt.snippets.id", maxId);
      }
      if (changed) await window.electronAPI.broadcastSnippetsUpdated?.();
      return true;
    } catch (err) {
      if (!isAuthContextError(err)) console.error("Snippet pull failed:", err);
      return false;
    }
  }

  private async syncSkills(): Promise<void> {
    const api = window.electronAPI;
    const required = [
      "getPendingSkills",
      "getPendingSkillDeletes",
      "exportSkillForCloud",
      "getSkillForCloudMerge",
      "applySkillFromCloud",
      "markSkillSynced",
      "hardDeleteSkill",
      "queueSkillCloudDelete",
      "clearSkillCloudId",
      "broadcastSkillsUpdated",
    ] as const;
    const missing = required.filter((name) => typeof api[name] !== "function");
    if (missing.length > 0) {
      throw new Error(`Skill IPC bindings missing — preload out of date: ${missing.join(", ")}`);
    }

    // Unlike snippets, the pull goes first: a skill this computer has never sent meets a copy
    // of the same name from another device there, and the newer of the two wins. So no such
    // skill is sent until a pull has compared it. An API from before skills answers 404 on
    // every skills route: nothing to do there.
    const pulled = await this.pullSkills();
    if (pulled === "unsupported" || !this.passIsCurrent()) return;
    await this.pushPendingSkills(pulled);
    if (!this.passIsCurrent()) return;
    await this.pushSkillDeletes();
  }

  private async pushPendingSkills(pulled: Exclude<SkillPullResult, "unsupported">): Promise<void> {
    const pending = (await window.electronAPI.getPendingSkills?.()) ?? [];
    const updates = [];
    const creates = [];
    for (const row of pending) {
      const exported = await window.electronAPI.exportSkillForCloud?.(row.name);
      // A skill that needs fixing, or is over the backup caps, stays on this computer.
      if (!exported || "tooLargeToSync" in exported) continue;
      const entry = {
        name: row.name,
        enabled: row.enabled === 1,
        content_hash: exported.contentHash,
        files: exported.files,
        edited_at: normalizeTimestamp(row.updated_at),
      };
      if (row.cloud_id) {
        const switchOnly = exported.contentHash === row.synced_hash;
        updates.push({ cloudId: row.cloud_id, entry, switchOnly });
      } else if (pulled !== "failed" && !pulled.unwritten.has(row.name))
        creates.push({
          ...entry,
          client_skill_id: row.client_skill_id,
          created_at: row.created_at,
        });
    }

    for (const { cloudId, entry, switchOnly } of updates) {
      try {
        const { name: _name, ...fields } = entry;
        // Files unchanged here go unsent, so they can't replace a newer copy from another device.
        const server = await SkillsService.update(
          cloudId,
          switchOnly ? { enabled: entry.enabled, edited_at: entry.edited_at } : fields
        );
        await window.electronAPI.markSkillSynced?.(
          entry.name,
          server.id,
          server.updated_at,
          entry.content_hash,
          entry.enabled
        );
      } catch (err) {
        if (isHttpStatus(err, 404)) {
          // Purged in the cloud, or deleted there from another device: the next push creates
          // it again, so the skill comes back.
          await window.electronAPI.clearSkillCloudId?.(entry.name);
        } else {
          console.error("Skill update sync failed:", err);
        }
      }
    }

    for (const batch of skillBatches(creates)) {
      try {
        const { created } = await SkillsService.batchCreate(batch);
        const byName = new Map(created.map((server) => [server.name, server]));
        for (const local of batch) {
          const server = byName.get(local.name);
          if (!server) continue;
          const result = await window.electronAPI.markSkillSynced?.(
            local.name,
            server.id,
            server.updated_at,
            local.content_hash,
            local.enabled
          );
          if (result?.changes !== 0) continue;
          // Edited meanwhile, it is sent again next pass. Uninstalled meanwhile, the copy
          // that got through must go too, or the next pull would bring it back.
          const row = await window.electronAPI.getSkillForCloudMerge?.(server);
          // A lookup that failed can't tell, so the copy is left as it is.
          if (isSkillLookupFailed(row)) continue;
          if (!row || row.deleted_at) {
            await window.electronAPI.queueSkillCloudDelete?.(local.name, server.id);
          }
        }
      } catch (err) {
        console.error("Skill batch create failed:", err);
      }
    }
  }

  private async pushSkillDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingSkillDeletes?.()) ?? [];
    for (const row of deletes) {
      if (!row.cloud_id) continue;
      try {
        await SkillsService.delete(row.cloud_id);
        await window.electronAPI.hardDeleteSkill?.(row.name);
      } catch (err) {
        if (isHttpStatus(err, 404)) {
          await window.electronAPI.hardDeleteSkill?.(row.name);
        } else {
          console.error("Skill delete sync failed:", err);
        }
      }
    }
  }

  private async pullSkills(): Promise<SkillPullResult> {
    let changed = false;
    try {
      // Listing rescans the skills folder, so an edit made outside the app since it was last
      // read is a pending change here, which the cloud's copy doesn't replace.
      await window.electronAPI.skillsList?.();
      const since = localStorage.getItem("lastSyncedAt.skills") ?? undefined;
      const sinceId = localStorage.getItem("lastSyncedAt.skills.id") ?? undefined;
      // A skill that couldn't be written holds the cursor back, so the next pass tries it again.
      const unwritten = new Set<string>();

      let cursor: string | undefined = since;
      let cursorId: string | undefined = sinceId;
      let maxUpdatedAt = normalizeTimestamp(since);
      let maxId = sinceId ?? "";
      const cursorField: keyof Pick<CloudSkillEntry, "created_at" | "updated_at"> = since
        ? "updated_at"
        : "created_at";

      while (true) {
        const { entries, hasMore } = since
          ? await SkillsService.listDelta(cursor, SKILL_PAGE_SIZE, cursorId)
          : await SkillsService.listSnapshot(cursor, SKILL_PAGE_SIZE, cursorId);
        if (entries.length === 0) break;

        for (const cloudEntry of entries) {
          const cloudTs = normalizeTimestamp(cloudEntry.updated_at);
          const local = await window.electronAPI.getSkillForCloudMerge?.(cloudEntry);
          // Comparing with nothing would take the cloud's copy over this one.
          if (isSkillLookupFailed(local)) throw new Error("Couldn't read a skill on this computer");

          if (cloudTs > maxUpdatedAt) {
            maxUpdatedAt = cloudTs;
            maxId = cloudEntry.id;
          } else if (cloudTs === maxUpdatedAt && cloudEntry.id > maxId) {
            maxId = cloudEntry.id;
          }

          // A delete wins, as for snippets, except over a skill this computer has never sent.
          // A change waiting to be sent wins over the cloud's copy (the push that follows
          // replaces it); a skill never sent meets the cloud's copy, and the one edited last
          // wins, by when each device edited it rather than when the cloud received it. A
          // synced skill whose files differ from the cloud's takes them, since a switch-only
          // push leaves the files another device sent meanwhile in the cloud only.
          const pending = local?.sync_status === "pending";
          const shouldApply = cloudEntry.deleted_at
            ? !!local && !local.deleted_at && !(pending && !local.cloud_id)
            : !local ||
              (pending
                ? !local.cloud_id &&
                  normalizeTimestamp(cloudEntry.edited_at) > normalizeTimestamp(local.updated_at)
                : cloudTs > normalizeTimestamp(local.updated_at) ||
                  local.cloud_id !== cloudEntry.id ||
                  local.content_hash !== cloudEntry.content_hash);
          if (!shouldApply) continue;
          try {
            const applied = await window.electronAPI.applySkillFromCloud?.(
              cloudEntry,
              local ?? null
            );
            if (typeof applied === "object") {
              throw new Error(`Couldn't write the skill: ${applied.error}`);
            }
            if (applied) changed = true;
          } catch (err) {
            unwritten.add(cloudEntry.name);
            console.error("Skill pull could not write a skill:", err);
          }
        }

        if (!hasMore) break;
        const last = entries[entries.length - 1];
        const nextCursor = last[cursorField];
        if (nextCursor === cursor && last.id === cursorId) break;
        cursor = nextCursor;
        cursorId = last.id;
      }

      // After a sign-in change mid-pull, the pages came from another account than the cursor's.
      if (unwritten.size === 0 && this.passIsCurrent()) {
        if (maxUpdatedAt) localStorage.setItem("lastSyncedAt.skills", maxUpdatedAt);
        if (maxId) localStorage.setItem("lastSyncedAt.skills.id", maxId);
      }
      return { unwritten };
    } catch (err) {
      if (isHttpStatus(err, 404)) return "unsupported";
      console.error("Skill pull failed:", err);
      return "failed";
    } finally {
      // Also after a pull that stopped early: the skills it wrote are on disk already.
      if (changed) await window.electronAPI.broadcastSkillsUpdated?.();
    }
  }

  private async buildLocalToCloudFolderMap(ctx: SpaceSyncContext): Promise<LocalToCloudFolderMap> {
    const folders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
    const backup = this.canSync();
    const localToCloud = new Map(folders.filter((f) => f.cloud_id).map((f) => [f.id, f.cloud_id!]));
    const pending = folders.filter((f) => f.sync_status === "pending");
    const refusedFolderIds = this.currentFolderRecords(
      FOLDER_PUSH_REFUSED_KEY,
      pending,
      folderRefusalFingerprint
    );
    const nestingOwed = this.currentFolderRecords(
      FOLDER_NESTING_OWED_KEY,
      pending.filter((f) => f.cloud_id && f.parent_folder_id != null),
      folderPushFingerprint
    );
    const unpushed = new Set(
      pending.filter((f) => f.cloud_id && !nestingOwed.has(f.id)).map((f) => f.id)
    );
    // With no cloud id: a Private folder while Backup will push it (a subfolder
    // there included), a team subfolder while its parent hasn't reached the cloud.
    const blocked = folders.filter((f) =>
      f.cloud_id
        ? unpushed.has(f.id)
        : ctx.byId.get(f.space_id)?.kind === "private"
          ? backup
          : this.cloudParentFolderId(f, {
              localToCloud,
              blockedFolderIds: unpushed,
              refusedFolderIds,
            }) === undefined
    );
    return {
      localToCloud,
      blockedFolderIds: new Set(blocked.map((f) => f.id)),
      waitingFolders: blocked.filter((f) => !f.cloud_id),
      refusedFolderIds,
      nestingOwedFolderIds: nestingOwed,
    };
  }

  // The folders a per-folder record still holds for, as the rows stand now. A
  // record whose row is gone or changed is dropped.
  private currentFolderRecords(
    key: string,
    candidates: FolderItem[],
    fingerprint: (folder: FolderItem) => string
  ): Set<number> {
    const record = this.readLocalRecord<string>(key);
    const held = new Set(
      candidates.filter((f) => record[f.id] === fingerprint(f)).map((f) => f.id)
    );
    const kept = Object.fromEntries(Object.entries(record).filter(([id]) => held.has(Number(id))));
    if (Object.keys(kept).length !== Object.keys(record).length) this.writeLocalRecord(key, kept);
    return held;
  }

  // Records when each waiting folder started waiting, forgets the ones no longer
  // waiting, and returns those past the limit. Their notes upload unfiled, keeping
  // the local folder; the link follows when the folder gets its cloud id.
  private releaseWaitingFolders(waitingFolders: FolderItem[]): Set<number> {
    const now = Date.now();
    const started = this.readLocalRecord(FOLDER_WAIT_STARTED_KEY);
    const next = Object.fromEntries(
      waitingFolders.map((f) => [f.client_folder_id, started[f.client_folder_id] ?? now])
    );
    this.writeLocalRecord(FOLDER_WAIT_STARTED_KEY, next);
    const released = waitingFolders.filter(
      (f) => now - next[f.client_folder_id] >= FOLDER_WAIT_RELEASE_MS
    );
    for (const folder of released) {
      console.warn(`Folder ${folder.id} still has no cloud id; its notes upload without it`);
    }
    return new Set(released.map((f) => f.id));
  }

  // Folders with a cloud id hold their notes until their own changes land. One
  // without holds them only until the limit. Neither holds a note leaving a team:
  // it stays visible to teammates until its retraction lands, so it goes unfiled
  // (pushedFolderId) and its folder link follows.
  private noteWaitsForFolder(
    note: NoteItem,
    { localToCloud, blockedFolderIds }: LocalToCloudFolderMap,
    releasedFolderIds: Set<number>
  ): boolean {
    if (!note.folder_id || !blockedFolderIds.has(note.folder_id) || note.left_team) return false;
    if (localToCloud.has(note.folder_id)) return true;
    return !releasedFolderIds.has(note.folder_id);
  }

  // personalFolderIn(spaceId): a private space's default "Personal" folder,
  // where a personal note whose folder isn't in that space is filed.
  private async buildCloudToLocalFolderMap(): Promise<{
    cloudToLocal: Map<string, { id: number; space_id: number }>;
    personalFolderIn: (spaceId: number) => number | null;
  }> {
    const folders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
    const cloudToLocal = new Map(
      folders
        .filter((f) => f.cloud_id)
        .map((f) => [f.cloud_id!, { id: f.id, space_id: f.space_id }])
    );
    const personalFolderIn = (spaceId: number): number | null =>
      findDefaultFolder(folders.filter((folder) => folder.space_id === spaceId))?.id ?? null;
    return { cloudToLocal, personalFolderIn };
  }
}

export const syncService = new SyncService();
