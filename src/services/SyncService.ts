import {
  hasUnrevisionedNoteClear,
  hasNoteRevision,
  noteAwaitsCloudResolution,
} from "../helpers/noteFieldSync.js";
import type {
  DictionaryEntryItem,
  NoteItem,
  FolderItem,
  SpaceItem,
  TranscriptionItem,
  ConversationPreview,
  ConversationCreateSnapshot,
  StaleSyncWrite,
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
import { PrivateNotesService } from "./PrivateNotesService";
import {
  importCloudPrivateNotesOnce,
  isWaitingToImport,
  nextImportWait,
  type PrivateNotesImportResult,
  type PrivateNotesImportWait,
} from "./privateNotesImport";
import { CloudApiError, isAuthContextError, wasRefusedBeforeSending } from "./cloudApi.js";
import { LeaderboardService } from "./LeaderboardService";
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
import { readNoteConflictIds } from "../lib/noteConflictRegistry";
import { pendingLeaderboardLeaveDeservesPriority } from "../lib/pendingLeaderboardLeave";
import { hasSharedDictionaryPlan } from "../lib/workspaceBilling";
import {
  cloudBackupResumed,
  effectiveLocalHistoryEnabled,
  isCloudBackupAllowed,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  hasWelcomedSharedDictionary,
  recordSharedDictionaryArrival,
  SHARED_DICTIONARY_CAPABILITY_KEY,
  useSharedDictionaryStore,
} from "../stores/sharedDictionaryStore";
import {
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
  PERSONAL_NOTES_ON_DEVICE,
  privateFolderSync,
  privateNoteSync,
  PRIVATE_NOTE_NOT_SYNCABLE,
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

// Typed 409 from a note PATCH whose base_updated_at is older than the stored
// row — another device wrote first. The body carries the current cloud note.
function isNoteVersionConflictError(err: unknown): boolean {
  return err instanceof CloudApiError && err.code === "note_version_conflict";
}

function conflictCloudNote(err: unknown): CloudNote | null {
  const details = (err as CloudApiError).details as { note?: CloudNote } | undefined;
  return details?.note ?? null;
}

// Typed 409 for a personal note or folder write once the account keeps private
// notes on its devices. The row stays pending as it is: no error mark, no fork,
// no retry this pass. For a note the refusal is also authoritative about its
// share (see endStaleShare).
function isPersonalNotesOnDeviceError(err: unknown): boolean {
  return err instanceof CloudApiError && err.code === PERSONAL_NOTES_ON_DEVICE;
}

export { PRIVATE_NOTE_NOT_SYNCABLE };

// Sharing a private note means moving it to a teamspace first (D10): only a
// note shared before Private stayed on the device has a cloud copy to share.
export class PrivateNoteNotSyncableError extends Error {
  readonly code = PRIVATE_NOTE_NOT_SYNCABLE;

  constructor() {
    super("Private notes stay on this device. Move the note to a teamspace to share it.");
    this.name = "PrivateNoteNotSyncableError";
  }
}

// Extra fields pushed with note/folder payloads so the server files rows into
// the right space scope; `null` scope means the row must not push at all.
type PushScopeFields = { workspace_id?: string | null; space_id?: string | null };

// A pull applies personal rows (no space) only for the one-time import of
// cloud private notes; otherwise just a legacy shared note's (D10).
interface PullOptions {
  includePersonal?: boolean;
  // The import's auth generation: it lists the account's personal rows alone,
  // and its writes are refused once that sign-in is replaced (#2924's fence).
  importUnder?: number;
}

// Per-pull-pass mapping of cloud spaces to local spaces.
interface SpaceSyncContext {
  byId: Map<number, SpaceItem>;
  byCloudSpaceId: Map<string, SpaceItem>;
  // The account's default Private, read on first use (defaultPrivateSpace):
  // most passes apply no personal row and never need it.
  defaultPrivateSpace?: SpaceItem | null;
  // Guard: at most one mid-pass spaces re-pull per pass.
  refreshedSpaces: boolean;
}

// Only team rows sync whole. A row whose space isn't known here counts as
// private, so nothing unknown is ever uploaded.
function isTeamRow(row: { space_id: number }, ctx: SpaceSyncContext): boolean {
  return ctx.byId.get(row.space_id)?.kind === "team";
}

// The cloud folder a note push names. Private folders never reach the cloud,
// so a legacy shared private note goes to the cloud root on create and update
// alike, and a pull keeps it in its local folder (see pullNotes).
function pushedFolderId(
  note: NoteItem,
  teamRow: boolean,
  localToCloud: Map<number, string>
): string | null {
  if (!teamRow || !note.folder_id) return null;
  return localToCloud.get(note.folder_id) ?? null;
}

const PUSH_DEBOUNCE_MS = 2000;
const BATCH_SIZE = 50;
const TRANSCRIPTION_BATCH_SIZE = 100;
const DICTIONARY_BATCH_SIZE = 200;
const SNIPPET_BATCH_SIZE = 200;
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
const NOTE_FEED_START = "1970-01-01T00:00:00.000Z";
// What an account switch saves and restores: the cursors, and the replay
// counters, which say whether that account's note cursors were ever replayed.
// Another account's first pull would otherwise spend them.
const ACCOUNT_SYNC_STATE_KEYS = [
  ...SYNC_CURSOR_KEYS,
  NOTE_FEED_REPLAY_KEY,
  NOTE_FEED_REPLAY_TEAM_KEY,
];
const FOLDER_UPDATE_404_KEY = "folderUpdate404Counts";
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
// Writers on different lists can commit out of updated_at order, so every
// delta re-reads this much before the stored cursor; re-applied rows are no-ops.
// The cursor a pass stores is the FIRST page's server_time: a row deleted (or
// unhidden) behind a later page of the same pass is then still re-read next time.
const SHARED_DICTIONARY_READ_OVERLAP_MS = 10_000;
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

function overlappedSince(cursor: string): string {
  return new Date(Date.parse(cursor) - SHARED_DICTIONARY_READ_OVERLAP_MS).toISOString();
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

// A pull pinned to a sign-in (the import's) looks at no further row once it is
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
  private syncAllPending = false;
  private autoSyncStarted = false;
  private dictionaryDirty = false;
  private snippetsDirty = false;
  // The sign-in the running pass claimed the cursors under. A pass that went on
  // past an account switch would finish as the next account and stamp that
  // account's values into the departed account's cursor slots.
  private passGeneration: number | null = null;
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
  // The cloud private notes import running for each account, and the wait a
  // failed one left (D29).
  private privateNotesImports = new Map<string, Promise<PrivateNotesImportResult>>();
  private privateNotesImportWaits = new Map<string, PrivateNotesImportWait>();
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
    const full = this.canSync();
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
        // Both branches below: shared lists follow membership, not cloud backup.
        const dictionaryGeneration = useSharedDictionaryStore.getState().generation;
        const sharedResult = await this.syncSharedDictionary(authGeneration);
        let personalSucceeded = true;
        if (!this.passIsCurrent()) return;
        if (full) {
          await this.backfillUnownedCursors(accountId);
          if (!this.passIsCurrent()) return;
          await this.syncFolders();
          if (!this.passIsCurrent()) return;
          await this.syncNotes();
          if (!this.passIsCurrent()) return;
          await this.syncConversations();
          if (!this.passIsCurrent()) return;
          await this.syncTranscriptions();
          if (!this.passIsCurrent()) return;
          // Edits during the awaits above set dictionaryDirty (syncing is already
          // true), so re-run until clean rather than stalling until the next trigger.
          do {
            this.dictionaryDirty = false;
            if (!(await this.syncDictionary())) personalSucceeded = false;
          } while (this.dictionaryDirty && this.passIsCurrent());
          if (!this.passIsCurrent()) return;
          do {
            this.snippetsDirty = false;
            await this.syncSnippets();
          } while (this.snippetsDirty && this.passIsCurrent());
        } else {
          // Backup is off: team-space content still syncs (membership is
          // consent, D7) and note deletes still propagate so revoked/deleted
          // shared notes stop being served (edits flow via debouncedPush).
          await this.syncFolders(true);
          if (!this.passIsCurrent()) return;
          await this.syncNotes(true);
        }
        if (!this.passIsCurrent()) return;
        // Once per account, Backup or not: the cloud's private notes come to
        // this device, which keeps them from then on (D2).
        await this.importCloudPrivateNotes(accountId);
        if (!this.passIsCurrent()) return;
        if (personalSucceeded && sharedResult !== "failed" && (full || sharedResult === "synced")) {
          useSharedDictionaryStore.getState().markSynced(dictionaryGeneration);
        }
        // Outside the branch above: Insights uploads ride their own opt-in,
        // while queued erasures run for every authenticated account.
        await this.syncAnalytics();
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
    if (this.syncAllPending) {
      this.syncAllPending = false;
      await this.syncAll();
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
    if (!this.canSync()) return "skipped";
    // A sync already running will drain dictionaryDirty before it finishes, so
    // flag a re-run instead of dropping this request.
    if (this.syncing) {
      this.dictionaryDirty = true;
      return "skipped";
    }
    // Edits sync right away, possibly before this account's first syncAll()
    // claimed the shared cursors, so they claim them under the same lock.
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null) return "skipped";
    this.syncing = true;
    let result: DictionarySyncResult = "failed";
    try {
      result = await navigator.locks.request(SYNC_ALL_LOCK, async () => {
        if (!this.claimSyncCursors(accountId, authGeneration)) return "skipped";
        this.passGeneration = authGeneration;
        let succeeded = true;
        do {
          this.dictionaryDirty = false;
          if (!(await this.syncDictionary())) succeeded = false;
        } while (this.dictionaryDirty && this.passIsCurrent());
        return succeeded ? "synced" : "failed";
      });
    } catch (err) {
      console.error("Dictionary sync failed:", err);
    } finally {
      this.syncing = false;
      this.passGeneration = null;
    }
    await this.runDeferredSyncAll();
    return result;
  }

  // A pass requested while an edit waited for the lock was deferred to it.
  private async runDeferredSyncAll(): Promise<void> {
    if (!this.syncAllPending) return;
    this.syncAllPending = false;
    await this.syncAll();
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
    if (!this.canSync()) return;
    if (this.syncing) {
      this.snippetsDirty = true;
      return;
    }
    const accountId = getAuthRequestContextSnapshot().sessionUserId;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null) return;
    this.syncing = true;
    try {
      await navigator.locks.request(SYNC_ALL_LOCK, async () => {
        if (!this.claimSyncCursors(accountId, authGeneration)) return;
        this.passGeneration = authGeneration;
        do {
          this.snippetsDirty = false;
          await this.syncSnippets();
        } while (this.snippetsDirty && this.passIsCurrent());
      });
    } catch (err) {
      console.error("Snippets sync failed:", err);
    } finally {
      this.syncing = false;
      this.passGeneration = null;
    }
    await this.runDeferredSyncAll();
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
    const folders = (await window.electronAPI.getFolders?.()) ?? [];
    const folder = folders.find((f) => f.id === id);
    if (!folder) return;

    const ctx = await this.buildSpaceContext();
    // Private folders never reach the cloud (D2).
    if (!isTeamRow(folder, ctx)) return this.keepPrivateFolderLocal(folder);
    const scope = this.resolvePushScope("folder", folder, ctx);
    if (!scope) return;

    if (folder.cloud_id) {
      try {
        await FoldersService.update(folder.cloud_id, {
          name: folder.name,
          sort_order: folder.sort_order,
          ...scope,
        });
        // Settle like the batch path: a delivered row left pending would both
        // block its notes' pushes (blockedFolderIds) and re-PATCH stale state
        // over a teammate's newer rename on the next pass. Guarded settle: a
        // rename landing mid-flight stays pending so it still pushes (a blind
        // settle would let the next pull's LWW revert it).
        await window.electronAPI.markFolderSyncedIfUnchanged?.(folder.id, folder, folder.cloud_id);
      } catch (err) {
        if (isPersonalNotesOnDeviceError(err)) {
          return;
        } else if (isFolderNameTakenError(err)) {
          this.dispatchFolderNameTaken(folder.name);
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
      try {
        await this.createCloudFolder(folder, scope);
      } catch (err) {
        if (!isPersonalNotesOnDeviceError(err)) throw err;
      }
    }
  }

  // A private folder that left a team before Private stayed on the device
  // still holds the team's cloud identity; any other private folder has
  // nothing to do with the cloud.
  private async keepPrivateFolderLocal(folder: FolderItem): Promise<void> {
    if (privateFolderSync(folder) === "detach") {
      await window.electronAPI.forkFolderIdentity?.(folder.id);
    }
  }

  // Single-folder create shared by the debounced push and the batch-create
  // isolation fallback. On a same-name collision the API returns the WINNER's
  // existing row; adopt its identity (as the batch path does) so later pulls
  // of that row match this folder instead of inserting a colliding duplicate.
  private async createCloudFolder(folder: FolderItem, scope: PushScopeFields): Promise<void> {
    const cloud = await FoldersService.create({
      name: folder.name,
      client_folder_id: folder.client_folder_id,
      is_default: !!folder.is_default,
      sort_order: folder.sort_order,
      ...scope,
    });
    await window.electronAPI.acknowledgeFolderCreate?.(
      folder.id,
      folder,
      folder.cloud_id,
      cloud.client_folder_id ?? folder.client_folder_id,
      cloud.id,
      cloud.updated_at
    );
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

  private async pushNote(id: number): Promise<void> {
    const note = await window.electronAPI.getNote?.(id);
    if (!note) return;
    const ctx = await this.buildSpaceContext();
    const teamRow = isTeamRow(note, ctx);
    // Private notes stay on the device (D2); only a legacy shared one pushes.
    if (!teamRow && !(await this.settlePrivateNote(note))) return;
    if (readNoteConflictIds().has(note.client_note_id)) {
      // An unresolved conflict: the editor's debounced push would auto-resolve
      // it as local-wins (or 409-spam) before the user chose Keep or Refresh.
      return;
    }
    // Until a pass shows the server has no revisions, a clear on a row without
    // a revision waits for the full pass that resolves it.
    if (noteAwaitsCloudResolution(note, this.noteRevisionsKnown !== false)) {
      // Only a full pass resolves it; stay throttled so typing in the note
      // doesn't start one per debounced push.
      this.requestSyncAll("interval");
      return;
    }

    const { localToCloud, blockedFolderIds } = await this.buildLocalToCloudFolderMap();
    if (teamRow && note.folder_id && blockedFolderIds.has(note.folder_id)) {
      // The folder's own changes haven't landed (e.g. a cross-space move that
      // 409'd on a name conflict): the server would reject this note's
      // folder_id as out of scope. Stay pending; the note retries after the
      // folder settles.
      return;
    }
    const scope = this.resolvePushScope("note", note, ctx);
    if (!scope) return;
    const cloudFolderId = pushedFolderId(note, teamRow, localToCloud);

    try {
      if (note.cloud_id) {
        const cloud = await NotesService.update(
          note.cloud_id,
          this.notePushPayload(note, cloudFolderId, scope)
        );
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
          cloud
        );
      } else {
        await this.createCloudNote(note, cloudFolderId, scope);
      }
    } catch (err) {
      if (isPersonalNotesOnDeviceError(err)) {
        await this.endStaleShare(note, ctx);
        return;
      }
      if (isNoteVersionConflictError(err)) {
        // Another device wrote first. The row stays pending and the banner
        // asks the user to Refresh or Keep; no requestSyncAll echo.
        const cloudNote = conflictCloudNote(err);
        if (cloudNote) await this.surfaceNoteConflict(note.client_note_id, cloudNote);
        return;
      }
      if (isPermissionDenialError(err)) {
        await this.handleDeniedNoteUpdate(note, ctx);
        await this.restoreDeniedRows("note");
        return;
      }
      if (isSpaceAccessError(err)) {
        await this.handleRevokedNotePush(note, ctx);
        return;
      }
      if (isHttpStatus(err, 404) && note.cloud_id) {
        // Defer to a full pass, whose pull disambiguates and applies the
        // stub-less fallback fork (see handleNoteUpdate404). This debounced
        // single push runs outside SYNC_ALL_LOCK, so it must not touch the
        // 404 counts; marking 'error' re-queues the row for that pass.
        await window.electronAPI.markNoteSyncError?.(note.id);
        return;
      }
      throw err;
    }
    // A push into a team must reach teammates fast; a pull may also carry
    // their concurrent edits back (throttled like other ambient triggers).
    if (scope.space_id) this.requestSyncAll("team-push");
  }

  // Single-note create shared by the debounced push and the batch-create
  // isolation fallback. The returned row carries the server-assigned owner
  // (user_id), persisted so the UI can tell "my note" from a teammate's.
  private async acknowledgeCloudNoteCreate(
    note: NoteItem,
    cloud: CloudNoteCreateResult
  ): Promise<void> {
    const outcome = await resolveRendererCloudNoteCreate(note, cloud, (cloudId) =>
      NotesService.delete(cloudId)
    );
    if (outcome === "write-rejected" || outcome === "awaiting-cloud") this.requestSyncAll("retry");
  }

  private async createCloudNote(
    note: NoteItem,
    cloudFolderId: string | null,
    scope: PushScopeFields
  ): Promise<void> {
    const recorded = await recordNoteCreateAttempts([note.client_note_id]);
    if (!recorded.has(note.client_note_id)) return;
    const cloud = await NotesService.create({
      client_note_id: note.client_note_id,
      ...buildNoteCreatePayload(note, cloudFolderId),
      ...scope,
      created_at: note.created_at,
    });
    await this.acknowledgeCloudNoteCreate(note, cloud);
  }

  // Batch-create fallback row push: recognized terminal rejections settle the
  // row by forking it into Private, where it stays on this device; anything
  // else re-queues as 'error'.
  private async pushFreshNote(
    note: NoteItem,
    scope: PushScopeFields,
    cloudFolderId: string | null,
    ctx: SpaceSyncContext
  ): Promise<void> {
    try {
      await this.createCloudNote(note, cloudFolderId, scope);
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      if (isPersonalNotesOnDeviceError(err)) {
        await this.endStaleShare(note, ctx);
        return;
      }
      if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
        await this.handleRevokedNotePush(note, ctx);
        this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
      } else {
        await window.electronAPI.markNoteSyncError?.(note.id);
      }
    }
  }

  // Sharing requires a cloud copy. Deliberate single-note push that does not
  // depend on the global backup toggle; returns the note's cloud id. A private
  // note is shared by moving it to a teamspace (D10), so one is refused with
  // PRIVATE_NOTE_NOT_SYNCABLE, unless it was shared before and so still has
  // its cloud copy. A copy this device made for an unshared note while Backup
  // covered notes doesn't count: sharing it would start a new share.
  async ensureNoteSynced(localId: number): Promise<string | null> {
    const note = await window.electronAPI.getNote?.(localId);
    if (!note) return null;
    if (!isTeamRow(note, await this.buildSpaceContext())) {
      if (!isLegacySharedPrivateNote(note)) throw new PrivateNoteNotSyncableError();
      return note.cloud_id;
    }
    if (note.cloud_id) return note.cloud_id;
    if (!this.canSyncSharedNotes()) return null;
    await this.pushNote(localId);
    const synced = await window.electronAPI.getNote?.(localId);
    return synced?.cloud_id ?? null;
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
    if (!local || hasTurnInProgress(local)) return;
    const snapshot = conversationCreateSnapshot(local);
    const { messages: cloudMessages } = await ConversationsService.listMessages(
      cloudId,
      sender.authGeneration
    );
    for (const message of missingConversationMessages(local.messages, cloudMessages)) {
      await ConversationsService.addMessage(
        cloudId,
        message.role,
        message.content,
        conversationMessageMetadata(message.metadata),
        sender.authGeneration
      );
    }
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
    const recorded = await window.electronAPI.markConversationCreateAttempted?.(
      full.id,
      sender.authGeneration
    );
    if (!recorded?.success) return;
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
    // A note's chat goes only where its note does: one on a private note stays
    // on the device (D11), as getPendingConversations keeps it.
    if (full.note_id != null) {
      const note = await window.electronAPI.getNote?.(full.note_id);
      if (!note || !isTeamRow(note, await this.buildSpaceContext())) return;
    }

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
      cloudSpaces = await SpacesService.mySpaces();
      await assertAuthGenerationCurrent(authGeneration);
    } catch (err) {
      if (isAuthContextError(err)) throw err;
      // 404 = endpoint not deployed yet (rollout probe): remember and skip
      // silently so pulls and pushes stay personal-only until a probe succeeds.
      if (isHttpStatus(err, 404)) {
        this.cacheTeamSpacesCapability(false);
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

  // The account's default Private, where a personal cloud row this device
  // applies is filed (D14): the cloud has one personal space, and the active
  // workspace's Private is only the one on screen. Main may make the row (its
  // pending default) as it answers, so an unlisted id reads the spaces again.
  private async defaultPrivateSpace(ctx: SpaceSyncContext): Promise<SpaceItem | null> {
    if (ctx.defaultPrivateSpace !== undefined) return ctx.defaultPrivateSpace;
    const id = await window.electronAPI.getDefaultPrivateSpaceId?.();
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
      return { workspace_id: space.workspace_id, space_id: space.cloud_space_id };
    }
    return this.hasTeamSpacesCapability() ? { workspace_id: null, space_id: null } : {};
  }

  // Resolves every note/folder push through the same two gates. Retractions
  // must wait for team-scope support or settling the row would erase the
  // pending scope change; team rows without a cloud scope must stay local.
  private resolvePushScope(
    kind: "folder" | "note",
    row: FolderItem | NoteItem,
    ctx: SpaceSyncContext
  ): PushScopeFields | null {
    if (row.left_team && row.cloud_id && !this.hasTeamSpacesCapability()) return null;

    const scope = this.pushScopeFields(ctx.byId.get(row.space_id));
    if (!scope) {
      console.warn(`Skipping ${kind} ${row.id} push: its team space has no cloud team yet`);
    }
    return scope;
  }

  // A push was rejected because the note's team is gone or access was revoked
  // (plan §7.2). The server row (if any) stays the team's, but this pending
  // row carries unpushed work — it is here because a push was attempted — so
  // it survives as a private note with a forked identity, exactly like the
  // pull-side access_removed stub; never destroy the edits. Private notes
  // never upload (D2), so the fork stays on this device.
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

  // Settles a private note a push read, and answers whether it pushes: only a
  // legacy shared one does (D10). One that left a team before this change is
  // first cut loose from the team's row (detachFromTeam); nothing else changes.
  private async settlePrivateNote(note: NoteItem): Promise<boolean> {
    const action = privateNoteSync(note);
    if (action === "detach") await this.detachFromTeam(note);
    return action === "push";
  }

  // A private note that left a team before this change still holds the team's
  // cloud identity and owes it a scope retraction, which would upload the note.
  // It takes a new identity in place instead, so neither the retraction nor its
  // later edits upload and the team keeps its copy, as Copy to Private does (D8).
  private async detachFromTeam(note: NoteItem): Promise<void> {
    await this.forkNoteToPrivate(note, note.space_id, "push", null);
  }

  // The server refuses a write to a personal note only when nobody else can
  // reach it, so a refused private note's share has ended (unshared or revoked
  // on another device). This device's flag is stale: dropping it takes the note
  // out of the syncable queue and the push gate, or every edit and pass would
  // resend the whole note to be refused again. The row stays pending, unmarked.
  private async endStaleShare(note: NoteItem, ctx: SpaceSyncContext): Promise<void> {
    if (isTeamRow(note, ctx) || !note.is_shared) return;
    await window.electronAPI.updateNoteShareState?.(note.id, { is_shared: 0, share_token: null });
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

  // A folder PATCH was rejected because its team is gone or access was
  // revoked: the server row moved to a scope we can't write, so retrying
  // would fail forever. Preserve the dirty folder in Private with a forked
  // identity (plan §7.2); private folders never upload, so it stays here.
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
  // caller snapshot-pull the authoritative server note over it.
  private async handleDeniedNoteDelete(note: NoteItem): Promise<void> {
    await window.electronAPI.restoreNoteAfterDeniedDelete?.(note.id);
    this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
    this.emitSyncUiEvent("note-delete-denied", { title: note.title });
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

  // Conflicts land in this window's store (the pull may run here) AND
  // rebroadcast, so the editor window's banner shows no matter which window
  // detected them.
  private async surfaceNoteConflict(clientNoteId: string, cloudNote: CloudNote): Promise<void> {
    const { setNoteConflict } = await import("../stores/noteStore.js");
    setNoteConflict(clientNoteId, cloudNote);
    this.emitSyncUiEvent("note-conflict", { clientNoteId, cloudNote });
  }

  private async settleNoteConflict(clientNoteId: string): Promise<void> {
    const { clearNoteConflict } = await import("../stores/noteStore.js");
    clearNoteConflict(clientNoteId);
    this.emitSyncUiEvent("note-conflict-clear", { clientNoteId });
  }

  private async syncFolders(teamOnly = false): Promise<void> {
    await this.pushPendingFolders();
    if (!this.passIsCurrent()) return;
    await this.pushFolderDeletes(teamOnly);
    if (!this.passIsCurrent()) return;
    if (!teamOnly && this.teamCursorLagging("folders")) {
      await this.pullFolders(true);
      if (!this.passIsCurrent()) return;
    }
    await this.pullFolders(teamOnly);
  }

  private async pushFolderDeletes(teamOnly = false): Promise<void> {
    let deletes = (await window.electronAPI.getPendingFolderDeletes?.()) ?? [];
    if (teamOnly && deletes.length > 0) {
      const { byId } = await this.buildSpaceContext();
      deletes = deletes.filter((f) => byId.get(f.space_id)?.kind === "team");
    }
    let denied = false;
    for (const f of deletes) {
      if (!f.cloud_id) continue;
      try {
        await FoldersService.delete(f.cloud_id);
        await window.electronAPI.hardDeleteFolder?.(f.id);
      } catch (err) {
        if (isPermissionDenialError(err)) {
          await this.handleDeniedFolderDelete(f);
          denied = true;
        } else if (isHttpStatus(err, 404) || isSpaceAccessError(err)) {
          // An already-gone row or a space we can no longer access can never
          // be deleted by this client. Clear the local tombstone (and any
          // update-404 streak the row carried) instead of retrying forever.
          await window.electronAPI.hardDeleteFolder?.(f.id);
          this.clear404(FOLDER_UPDATE_404_KEY, f.client_folder_id);
        } else {
          console.error("Folder delete sync failed:", err);
        }
      }
    }
    if (denied) await this.restoreDeniedRows("folder");
  }

  // Team folders only, whether or not Backup is on: private folders never
  // reach the cloud (D2), so a full pass reads the team queue too.
  private async pushPendingFolders(): Promise<void> {
    const pending = (await window.electronAPI.getPendingFolders?.("team")) ?? [];
    if (pending.length === 0) return;

    const ctx = await this.buildSpaceContext();
    const pushable: Array<{ folder: FolderItem; scope: PushScopeFields }> = [];
    for (const folder of pending) {
      if (!isTeamRow(folder, ctx)) {
        await this.keepPrivateFolderLocal(folder);
        continue;
      }
      const scope = this.resolvePushScope("folder", folder, ctx);
      if (!scope) continue;
      pushable.push({ folder, scope });
    }

    const migration = pushable.filter(({ folder }) => folder.cloud_id);
    const fresh = pushable.filter(({ folder }) => !folder.cloud_id);

    let denied = false;
    for (const { folder, scope } of migration) {
      try {
        await FoldersService.update(folder.cloud_id!, {
          name: folder.name,
          sort_order: folder.sort_order,
          ...scope,
        });
        // Settle only if the row wasn't edited while the PATCH was in flight.
        await window.electronAPI.markFolderSyncedIfUnchanged?.(folder.id, folder, folder.cloud_id!);
        this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
      } catch (err) {
        if (isPersonalNotesOnDeviceError(err)) {
          // Stays pending as it is; the next pass looks at it again.
        } else if (isFolderNameTakenError(err)) {
          // Leave the row pending; retried on the next pass. The 409 also
          // proves the folder is still accessible, so reset any 404 streak.
          this.dispatchFolderNameTaken(folder.name);
          this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
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

    if (fresh.length > 0) {
      try {
        const { created, refused = [] } = await FoldersService.batchCreate(
          fresh.map(({ folder, scope }) => ({
            name: folder.name,
            client_folder_id: folder.client_folder_id,
            is_default: !!folder.is_default,
            sort_order: folder.sort_order,
            ...scope,
          }))
        );
        // Refused rows stay pending as they are (isPersonalNotesOnDeviceError).
        const refusedIds = new Set(refused.map((row) => row.client_folder_id));
        const accepted = fresh.filter(({ folder }) => !refusedIds.has(folder.client_folder_id));
        // created preserves the order of the rows the server accepted; the
        // cloud may return an existing folder with a different
        // client_folder_id when a same-named default already exists there —
        // adopt its identity in that case.
        if (created.length !== accepted.length) {
          console.error(
            `Folder batch create returned ${created.length} folders for ${accepted.length} inputs; skipping identity adoption`
          );
          return;
        }
        for (const [i, cloudFolder] of created.entries()) {
          const local = accepted[i].folder;
          await window.electronAPI.acknowledgeFolderCreate?.(
            local.id,
            local,
            local.cloud_id,
            cloudFolder.client_folder_id ?? local.client_folder_id,
            cloudFolder.id,
            cloudFolder.updated_at
          );
        }
      } catch (err) {
        if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
          // A typed rejection can't be attributed to a row from the batch
          // response; create individually so one rejected folder settles
          // terminally without stranding (or relocating) the rest.
          for (const { folder, scope } of fresh) {
            await this.pushFreshFolder(folder, scope, ctx);
          }
        } else {
          console.error("Folder batch create failed:", err);
        }
      }
    }
  }

  // Batch-create fallback row push: recognized terminal rejections settle the
  // row by forking it into Private, where it stays on this device; anything
  // else stays 'pending' for the next pass.
  private async pushFreshFolder(
    folder: FolderItem,
    scope: PushScopeFields,
    ctx: SpaceSyncContext
  ): Promise<void> {
    try {
      await this.createCloudFolder(folder, scope);
    } catch (err) {
      if (isPersonalNotesOnDeviceError(err)) {
        // Stays pending as it is; the next pass looks at it again.
      } else if (isFolderNameTakenError(err)) {
        this.dispatchFolderNameTaken(folder.name);
      } else if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
        await this.handleRevokedFolderPush(folder, ctx);
        this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
      } else {
        console.error("Folder create sync failed:", err);
      }
    }
  }

  private async pullFolders(
    teamOnly = false,
    snapshot = false,
    { includePersonal = false, importUnder }: PullOptions = {}
  ): Promise<boolean> {
    try {
      const cursorKey = teamOnly ? "lastSyncedAt.folders.team" : "lastSyncedAt.folders";
      const since = snapshot ? undefined : (localStorage.getItem(cursorKey) ?? undefined);
      const syncStartedAt = new Date().toISOString();
      const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
      // Without a scope the list holds the account's personal rows alone.
      const scope = teamCapable && importUnder === undefined ? "all" : undefined;
      const { folders: cloudFolders } = await FoldersService.list(since, scope, importUnder);
      // The import's rows are no team work (they'd keep team-only passes from backing off).
      if (cloudFolders.length > 0 && importUnder === undefined) this.teamPassMovedWork = true;
      const importWrite = importUnder !== undefined ? { newKeyIfTaken: true } : undefined;
      const ctx = await this.buildSpaceContext();
      // Parked or failed rows must retry: they hold the cursor back (and fail
      // a backfill) so one bad row never drops the rest of the delta.
      let parkedRows = 0;

      for (const cloudFolder of cloudFolders) {
        try {
          stopIfSignInReplaced(importUnder);
          const local = await window.electronAPI.getFolderByClientId?.(
            cloudFolder.client_folder_id ?? ""
          );

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
            } else {
              await window.electronAPI.hardDeleteFolder?.(local.id);
              this.clear404(FOLDER_UPDATE_404_KEY, local.client_folder_id);
            }
            continue;
          }

          // Private folders stay on the device (D2): a personal row, tombstone
          // included, changes no private folder. Outside the one-time import
          // (includePersonal) it is applied only to a team copy, as the
          // team→personal transition an older build made: otherwise a later
          // edit's push would re-team the privatized folder. It lands in the
          // default's Private (D14).
          if (!cloudFolder.space_id && !includePersonal) {
            if (!local || local.deleted_at || !isTeamRow(local, ctx)) continue;
            const privateSpace = await this.defaultPrivateSpace(ctx);
            if (!privateSpace) continue;
            if (cloudFolder.deleted_at) {
              await window.electronAPI.hardDeleteFolder?.(local.id);
              this.clear404(FOLDER_UPDATE_404_KEY, local.client_folder_id);
            } else if (
              // Pending rows are never overwritten by pull (D2), here too.
              local.sync_status !== "pending" &&
              isCloudEntryNewer(cloudFolder.updated_at, local.updated_at)
            ) {
              await window.electronAPI.upsertFolderFromCloud?.(
                cloudFolder as unknown as Record<string, unknown>,
                privateSpace.id
              );
            }
            continue;
          }

          if (cloudFolder.deleted_at) {
            if (local) {
              await window.electronAPI.hardDeleteFolder?.(local.id);
              // A tombstone disambiguates a 404'd push as a genuine delete;
              // drop any streak so it can't resurrect the folder in Personal.
              this.clear404(FOLDER_UPDATE_404_KEY, local.client_folder_id);
            }
            continue;
          }

          const space = await this.resolveSpaceForCloudRow(cloudFolder.space_id, ctx);
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
          // collision convergence owns those.
          if (!local && !cloudFolder.space_id) {
            const allFolders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
            const adoptable = allFolders.filter(
              (f) => f.space_id === space.id && (!f.cloud_id || f.cloud_id === cloudFolder.id)
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
                  importUnder
                );
                stopIfPullStale(result);
                return result?.outcome === "synced" || result?.outcome === "pending";
              };
              const adopted = await adopt(
                cloudFolder.client_folder_id ?? nameMatch.client_folder_id
              );
              // The import leaves no folder behind (D28). Another folder here
              // may hold the cloud's key, so it keeps the folder's own.
              if (
                importUnder !== undefined &&
                !adopted &&
                !(await adopt(nameMatch.client_folder_id))
              ) {
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
              isCloudEntryNewer(cloudFolder.updated_at, local.updated_at))
          ) {
            const stored = await window.electronAPI.upsertFolderFromCloud?.(
              cloudFolder as unknown as Record<string, unknown>,
              space.id,
              importUnder,
              importWrite
            );
            stopIfPullStale(stored);
            if (importUnder !== undefined && !stored) {
              parkedRows++;
              console.warn(`Parking folder ${cloudFolder.id}: it wasn't stored`);
            }
          }
        } catch (err) {
          // The sign-in changed: the rest of the list is the departed account's.
          if (isAuthContextError(err)) throw err;
          parkedRows++;
          console.error(`Folder pull failed for cloud folder ${cloudFolder.id}:`, err);
        }
      }

      const { advanceCursor, advanceTeamCursor } = resolvePullCursorAdvance({
        snapshot,
        parked: parkedRows > 0,
        teamOnly,
        teamCapable,
        hasTeamSpaces: [...ctx.byId.values()].some((s) => s.kind === "team"),
      });
      if (!this.passIsCurrent()) return false;
      if (advanceCursor) localStorage.setItem(cursorKey, syncStartedAt);
      if (advanceTeamCursor) localStorage.setItem("lastSyncedAt.folders.team", syncStartedAt);
      return parkedRows === 0;
    } catch (err) {
      if (!isAuthContextError(err)) console.error("Folder pull failed:", err);
      return false;
    }
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
        (await window.electronAPI.countNotesMissingRevision?.(teamOnly ? "team" : "syncable")) ?? 0;
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

  // A full pass also pushes legacy shared private notes ("syncable"); no other
  // private note is ever read for upload (D2, D10).
  private async pushPendingNotes(teamOnly = false): Promise<void> {
    const queue = teamOnly ? "team" : "syncable";
    let pending = (await window.electronAPI.getPendingNotes?.(queue)) ?? [];
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

    const { localToCloud, blockedFolderIds } = await this.buildLocalToCloudFolderMap();
    const ctx = await this.buildSpaceContext();
    const pushable: Array<{
      note: NoteItem;
      scope: PushScopeFields;
      cloudFolderId: string | null;
    }> = [];
    for (const note of pending) {
      const teamRow = isTeamRow(note, ctx);
      if (!teamRow && !(await this.settlePrivateNote(note))) continue;
      if (
        conflicted.has(note.client_note_id) ||
        noteAwaitsCloudResolution(note, this.noteRevisionsKnown !== false)
      ) {
        // An unresolved pull conflict or rejected create: pushing now would
        // auto-resolve it as local-wins before the user chose Keep or Refresh
        // (which clear the registry entry and unblock the row). A clear with
        // no revision waits for a pull to supply one.
        continue;
      }
      if (teamRow && note.folder_id && blockedFolderIds.has(note.folder_id)) {
        // The folder's own changes haven't landed (e.g. a cross-space move
        // that 409'd on a name conflict): the server would reject the note's
        // folder_id as out of scope, stranding it in 'error'. Stay pending;
        // folder and notes push together once the conflict resolves.
        continue;
      }
      const scope = this.resolvePushScope("note", note, ctx);
      if (!scope) continue;
      pushable.push({ note, scope, cloudFolderId: pushedFolderId(note, teamRow, localToCloud) });
    }

    const migration = pushable.filter(({ note }) => note.cloud_id);
    const fresh = pushable.filter(({ note }) => !note.cloud_id);

    let denied = false;
    for (const { note, scope, cloudFolderId } of migration) {
      try {
        // Carry the full content: a pending row may hold edits that never
        // reached the server (offline debounced pushes fail silently), and
        // this PATCH marks the row synced — settling it without content
        // would strand the edit locally and hand the next pull a stale-but-
        // newer cloud copy to overwrite it with.
        const cloud = await NotesService.update(note.cloud_id!, {
          client_note_id: note.client_note_id,
          ...this.notePushPayload(note, cloudFolderId, scope),
        });
        // Settle only if the row wasn't edited while the PATCH was in flight.
        await window.electronAPI.markNoteSyncedIfUnchanged?.(
          note.id,
          note,
          note.cloud_id!,
          cloud.updated_at,
          cloud.user_id ?? null,
          cloud.revision ?? null,
          cloud
        );
        this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (isPersonalNotesOnDeviceError(err)) {
          await this.endStaleShare(note, ctx);
        } else if (isNoteVersionConflictError(err)) {
          // Stays pending (not error): unpushed local work awaiting the
          // user's Keep/Refresh choice; the registry gate above skips the
          // row on later passes so the 409 doesn't repeat. A 409 also proves
          // the note is still accessible, so reset any prior 404 streak.
          const cloudNote = conflictCloudNote(err);
          if (cloudNote) await this.surfaceNoteConflict(note.client_note_id, cloudNote);
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
    }
    if (denied) await this.restoreDeniedRows("note");

    for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
      const batch = fresh.slice(i, i + BATCH_SIZE);
      const recorded = await recordNoteCreateAttempts(batch.map(({ note }) => note.client_note_id));
      const chunk = batch.filter(({ note }) => recorded.has(note.client_note_id));
      if (chunk.length === 0) continue;
      try {
        // A refused row isn't in created, so nothing acknowledges it: it stays
        // pending as it is (isPersonalNotesOnDeviceError).
        const { created, refused = [] } = await NotesService.batchCreate(
          chunk.map(({ note: n, scope, cloudFolderId }) => ({
            client_note_id: n.client_note_id,
            ...buildNoteCreatePayload(n, cloudFolderId),
            created_at: n.created_at,
            ...scope,
          }))
        );
        for (const cloud of created) {
          const local = chunk.find(({ note }) => note.client_note_id === cloud.client_note_id);
          if (local) await this.acknowledgeCloudNoteCreate(local.note, cloud);
        }
        for (const row of refused) {
          const local = chunk.find(({ note }) => note.client_note_id === row.client_note_id);
          if (local) await this.endStaleShare(local.note, ctx);
        }
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (isPersonalNotesOnDeviceError(err)) {
          for (const { note } of chunk) await this.endStaleShare(note, ctx);
          continue;
        }
        if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
          // A typed rejection can't be attributed to a row from the batch
          // response; create individually so one rejected note settles
          // terminally without stranding (or relocating) the rest.
          for (const { note, scope, cloudFolderId } of chunk) {
            await this.pushFreshNote(note, scope, cloudFolderId, ctx);
          }
        } else {
          for (const { note } of chunk) {
            await window.electronAPI.markNoteSyncError?.(note.id);
          }
        }
      }
    }
  }

  // A cloud copy only exists through prior consent (backup or sync-and-share),
  // so deletes always propagate — even for notes never shared and with the
  // backup toggle off.
  private async pushNoteDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingNoteDeletes?.()) ?? [];
    let denied = false;
    for (const note of deletes) {
      if (!note.cloud_id) continue;
      try {
        await NotesService.delete(note.cloud_id);
        await window.electronAPI.hardDeleteNote?.(note.id);
        // A settled tombstone can never resolve a conflict; drop the entry
        // (and its full cloud snapshot) from the durable registry.
        await this.settleNoteConflict(note.client_note_id);
      } catch (err) {
        if (isPermissionDenialError(err)) {
          await this.handleDeniedNoteDelete(note);
          denied = true;
        } else if (isHttpStatus(err, 404) || isSpaceAccessError(err)) {
          // An already-gone row or a space we can no longer access can never
          // be deleted by this client. Clear the local tombstone (and any
          // update-404 streak the row carried) instead of retrying forever.
          await window.electronAPI.hardDeleteNote?.(note.id);
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
    replayFeed = false,
    { includePersonal = false, importUnder }: PullOptions = {}
  ): Promise<boolean> {
    try {
      const cursorKey = teamOnly ? "lastSyncedAt.notes.team" : "lastSyncedAt.notes";
      const since = snapshot
        ? undefined
        : replayFeed
          ? NOTE_FEED_START
          : (localStorage.getItem(cursorKey) ?? undefined);
      const syncStartedAt = new Date().toISOString();
      const ctx = await this.buildSpaceContext();
      const { cloudToLocal, personalFolderIn } = await this.buildCloudToLocalFolderMap();
      const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
      // Without a scope the list holds the account's personal rows alone.
      const scope = teamCapable && importUnder === undefined ? "all" : undefined;

      let cursor: string | undefined = since;
      let cursorId: string | undefined;
      // Only rows that still need to be applied hold the delta cursor back.
      // Conflicts are durable in the local registry and resolve directly from
      // their stored cloud copy, so they must not re-pull the whole delta.
      let parkedRows = 0;
      const importWrite = importUnder !== undefined ? { newKeyIfTaken: true } : undefined;
      while (true) {
        const { notes: cloudNotes } = since
          ? await NotesService.list(BATCH_SIZE, undefined, cursor, scope, cursorId, importUnder)
          : await NotesService.list(BATCH_SIZE, cursor, undefined, scope, cursorId, importUnder);
        if (cloudNotes.length === 0) break;
        // The import's rows are no team work (they'd keep team-only passes from backing off).
        if (importUnder === undefined) this.teamPassMovedWork = true;

        for (const cloudNote of cloudNotes) {
          try {
            stopIfSignInReplaced(importUnder);
            const local = await window.electronAPI.getNoteForCloudRow?.(
              cloudNote.client_note_id,
              cloudNote.id
            );

            // An old delete must not take text this device hasn't pushed. Its
            // push gets a 404 and forks it into a note of its own.
            if (replayFeed && cloudNote.deleted_at && local?.sync_status !== "synced") {
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

            // Private notes stay on the device (D2): a personal row, tombstone
            // included, creates, changes or deletes no private note, except
            // during the one-time import (includePersonal) and for a legacy
            // shared note, whose guests' edits still arrive (D10). It is
            // applied to a team copy as before: the team→personal transition
            // an older build made.
            const personalRow = !cloudNote.space_id && !cloudNote.access_removed;
            const teamCopy = !!local && isTeamRow(local, ctx);
            const legacyShared =
              personalRow &&
              !includePersonal &&
              !!local &&
              !teamCopy &&
              isLegacySharedPrivateNote(local);
            if (personalRow && !includePersonal && !teamCopy && !legacyShared) continue;
            // Private folders never sync, so a personal row's folder is known
            // only during the import: waiting for it elsewhere would park the
            // row, and hold the cursor, for good.
            const parksOnFolder = !personalRow || includePersonal;

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
                local.sync_status !== "synced" && !local.deleted_at
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
                await window.electronAPI.hardDeleteNote?.(local.id);
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

            if (
              teamOnly &&
              personalRow &&
              !includePersonal &&
              !legacyShared &&
              !local?.cloud_create_pending
            ) {
              // A personal row whose local copy still sits in a team space
              // announces a team→personal transition — apply it, or a later
              // edit's push would re-team the privatized note. It lands in the
              // default's Private (D14).
              const privateSpace = local?.deleted_at ? null : await this.defaultPrivateSpace(ctx);
              if (local && privateSpace) {
                if (cloudNote.deleted_at) {
                  await window.electronAPI.hardDeleteNote?.(local.id);
                  await this.settleNoteConflict(local.client_note_id);
                } else if (isCloudNoteNewer(cloudNote, local)) {
                  // 'error' rows carry unpushed work just like 'pending' ones.
                  if (local.sync_status !== "synced") {
                    await this.surfaceNoteConflict(local.client_note_id, cloudNote);
                  } else {
                    await window.electronAPI.upsertNoteFromCloud?.(
                      cloudNote as unknown as Record<string, unknown>,
                      resolvePulledNoteFolderId(
                        cloudNote,
                        privateSpace.id,
                        cloudToLocal,
                        personalFolderIn(privateSpace.id)
                      ),
                      privateSpace.id
                    );
                  }
                }
              }
              continue;
            }

            if (cloudNote.deleted_at) {
              if (local) {
                await window.electronAPI.hardDeleteNote?.(local.id);
                // A tombstone disambiguates a 404'd push as a genuine delete;
                // drop any streak so it can't resurrect the note in Personal,
                // and settle any conflict so the registry doesn't keep the
                // deleted note's full cloud snapshot forever.
                this.clear404(NOTE_UPDATE_404_KEY, local.client_note_id);
                await this.settleNoteConflict(local.client_note_id);
              }
              continue;
            }

            // A legacy shared note stays where it is filed here: the cloud has
            // one personal space and keeps no private folder (pushedFolderId).
            const space =
              legacyShared && local
                ? (ctx.byId.get(local.space_id) ?? null)
                : await this.resolveSpaceForCloudRow(cloudNote.space_id, ctx);
            if (!space) {
              parkedRows++;
              console.warn(`Parking note ${cloudNote.id}: unknown space ${cloudNote.space_id}`);
              continue;
            }
            const localFolderId =
              legacyShared && local
                ? local.folder_id
                : resolvePulledNoteFolderId(
                    cloudNote,
                    space.id,
                    cloudToLocal,
                    personalFolderIn(space.id)
                  );
            const folderUnknown =
              parksOnFolder && !!cloudNote.folder_id && !cloudToLocal.has(cloudNote.folder_id);

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
                  reconcilePending: true,
                  cloudNote,
                  cloudRevision: cloudNote.revision ?? null,
                  localFolderId,
                  localSpaceId: space.id,
                }
              );
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
            if (preRevision && local.sync_status !== "synced") {
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
            const cleanPreRevision = preRevision && local.sync_status === "synced";
            if (!local || cleanPreRevision || isCloudNoteNewer(cloudNote, local)) {
              if (local && local.sync_status !== "synced") {
                // A newer cloud copy over unpushed local edits ('pending' or
                // 'error'): surface the conflict to the editor banner instead
                // of silently dropping the local edit (plan §7.3).
                await this.surfaceNoteConflict(local.client_note_id, cloudNote);
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
                importUnder,
                importWrite
              );
              stopIfPullStale(applied);
              // The import leaves no note behind (D28): one main didn't store
              // holds the switch back.
              if (importUnder !== undefined && !applied) {
                parkedRows++;
                console.warn(`Parking note ${cloudNote.id}: it wasn't stored`);
                continue;
              }
              if (local) {
                // Applying cloud over a clean row settles any stale conflict,
                // including one left under the key this row just adopted. A
                // skipped upsert adopted nothing, and that key is another row's.
                await this.settleNoteConflict(local.client_note_id);
                if (applied && applied.client_note_id !== local.client_note_id) {
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
      if (advanceCursor) localStorage.setItem(cursorKey, syncStartedAt);
      if (advanceTeamCursor) localStorage.setItem("lastSyncedAt.notes.team", syncStartedAt);
      return parkedRows === 0;
    } catch (err) {
      if (!isAuthContextError(err)) console.error("Note pull failed:", err);
      return false;
    }
  }

  // Brings the account's cloud private notes into its default Private once,
  // then switches the account to device-only (privateNotesImport.ts). One run
  // per account at a time: a call while one runs gets that run's result.
  // syncAll calls it under its lock, once spaces have synced.
  importCloudPrivateNotes(accountId: string): Promise<PrivateNotesImportResult> {
    const running = this.privateNotesImports.get(accountId);
    if (running) return running;
    const run = this.runPrivateNotesImport(accountId).finally(() => {
      this.privateNotesImports.delete(accountId);
    });
    this.privateNotesImports.set(accountId, run);
    return run;
  }

  // Pinned to the sign-in that starts it: once that sign-in is replaced, main
  // refuses its requests and its writes. Backup plays no part, a sign-in does.
  private async runPrivateNotesImport(accountId: string): Promise<PrivateNotesImportResult> {
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return "failed";
    const wait = this.privateNotesImportWaits.get(accountId);
    if (isWaitingToImport(wait, authGeneration, Date.now())) return "failed";
    const isCurrent = (): boolean =>
      getValidatedAuthGeneration() === authGeneration &&
      getAuthRequestContextSnapshot().sessionUserId === accountId &&
      this.consent().shared;
    // Snapshots: no cursor is read or moved, so the regular passes' deltas go
    // on from where they were.
    const pullOptions: PullOptions = { includePersonal: true, importUnder: authGeneration };
    const outcome = await importCloudPrivateNotesOnce(accountId, {
      isCurrent,
      pushDeletes: async () => {
        await this.pushFolderDeletes();
        await this.pushNoteDeletes();
      },
      getState: () => PrivateNotesService.getState(authGeneration),
      pull: async () =>
        (await this.pullFolders(false, true, pullOptions)) &&
        (await this.pullNotes(false, true, false, pullOptions)),
      switchOnDevice: (pulledThrough) =>
        PrivateNotesService.switchOnDevice(pulledThrough, authGeneration),
      onSwitched: (state) => {
        if (isCurrent()) {
          this.emitSyncUiEvent("private-notes-on-device", { purgeAfter: state.purge_after });
        }
      },
    });
    const nextWait = nextImportWait(wait, authGeneration, outcome, Date.now());
    if (nextWait) this.privateNotesImportWaits.set(accountId, nextWait);
    else this.privateNotesImportWaits.delete(accountId);
    return outcome === "unsupported" ? "failed" : outcome;
  }

  private async syncConversations(): Promise<void> {
    await this.pushPendingConversations();
    if (!this.passIsCurrent()) return;
    await this.pushConversationDeletes();
    if (!this.passIsCurrent()) return;
    await this.pullConversations();
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
      const syncStartedAt = new Date().toISOString();

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
          if (local?.folder_delete_pending) continue;

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
      if (!snapshot) localStorage.setItem("lastSyncedAt.conversations", syncStartedAt);
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
      const syncStartedAt = new Date().toISOString();

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
      if (!snapshot) localStorage.setItem("lastSyncedAt.transcriptions", syncStartedAt);
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

    // Starts before the stored cursor (see SHARED_DICTIONARY_READ_OVERLAP_MS),
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

  private async buildLocalToCloudFolderMap(): Promise<{
    localToCloud: Map<number, string>;
    // Cloud-backed folders with unpushed changes: their migration PATCH
    // failed or hasn't run yet (folders push before notes in a pass), so
    // pushing a child note's folder_id + scope now could be rejected as out
    // of scope. Those notes defer and stay pending.
    blockedFolderIds: Set<number>;
  }> {
    const folders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
    return {
      localToCloud: new Map(folders.filter((f) => f.cloud_id).map((f) => [f.id, f.cloud_id!])),
      blockedFolderIds: new Set(
        folders.filter((f) => f.cloud_id && f.sync_status === "pending").map((f) => f.id)
      ),
    };
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
      folders.find((f) => f.is_default && f.name === "Personal" && f.space_id === spaceId)?.id ??
      null;
    return { cloudToLocal, personalFolderIn };
  }
}

export const syncService = new SyncService();
