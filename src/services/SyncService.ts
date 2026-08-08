import type {
  NoteItem,
  FolderItem,
  SpaceItem,
  TranscriptionItem,
  ConversationPreview,
} from "../types/electron";
import { NotesService, type CloudNote } from "./NotesService.js";
import { ConversationsService } from "./ConversationsService.js";
import { FoldersService } from "./FoldersService.js";
import { SpacesService, type MySpace } from "./SpacesService.js";
import { TranscriptionsService } from "./TranscriptionsService.js";
import { DictionaryService } from "./DictionaryService.js";
import { SnippetService, type CloudSnippetEntry } from "./SnippetService.js";
import { CloudApiError, isAuthContextError } from "./cloudApi.js";
import {
  assertAuthGenerationCurrent,
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
import { cloudBackupResumed, isCloudBackupAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import {
  buildNoteCreatePayload,
  buildNoteUpdatePayload,
  isCloudEntryNewer,
  normalizeTimestamp,
} from "../helpers/cloudSyncGuards.js";
import { resolveRendererCloudNoteCreate, type CloudNoteCreateResult } from "./noteCreateAck";
import {
  clearUpdate404,
  isPermissionDenialCode,
  isSpaceAccessErrorCode,
  keepPurgedSpaceEntry,
  normalizePurgedSpaceEntries,
  prunePurgedSpaceEntries,
  recordUpdate404,
  resolvePulledNoteFolderId,
  resolvePullCursorAdvance,
  revokedNoteForkUpdate,
  shouldSetOwnerFromCloud,
  UPDATE_404_FORK_THRESHOLD,
  type PurgedSpaceEntry,
  type PurgedSpaceReason,
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

// Extra fields pushed with note/folder payloads so the server files rows into
// the right space scope; `null` scope means the row must not push at all.
type PushScopeFields = { workspace_id?: string | null; space_id?: string | null };

// Per-pull-pass mapping of cloud spaces to local spaces.
interface SpaceSyncContext {
  byId: Map<number, SpaceItem>;
  byCloudSpaceId: Map<string, SpaceItem>;
  privateSpace: SpaceItem | null;
  // Guard: at most one mid-pass spaces re-pull per pass.
  refreshedSpaces: boolean;
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
// localStorage keys gating canSync(); a change in another window means sync
// may have just become possible (sign-in, subscription, backup enabled).
const CAN_SYNC_KEYS = ["isSignedIn", "cloudBackupEnabled", "isSubscribed"];

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
const FOLDER_UPDATE_404_KEY = "folderUpdate404Counts";

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

// Call BEFORE purgeSpace, from every purge path (sync revocation, sign-out,
// and the UI's delete-space flow).
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
  // One owner_user_id backfill probe per session (see backfillNoteOwners).
  private ownerBackfillChecked = false;
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private teamSpacesRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private teamSpacesRetryAttempt = 0;
  private openNoteSyncTimer: ReturnType<typeof setInterval> | null = null;

  canSync(): boolean {
    return (
      hasValidatedAuthContext() &&
      localStorage.getItem("isSignedIn") === "true" &&
      localStorage.getItem("cloudBackupEnabled") === "true" &&
      readIsSubscribed() &&
      isCloudBackupAllowed(usePolicyStore.getState())
    );
  }

  // Sharing a note is per-note consent: shared notes keep syncing even when
  // the global cloud-backup toggle is off, as long as the account can sync.
  private canSyncSharedNotes(): boolean {
    return (
      hasValidatedAuthContext() &&
      localStorage.getItem("isSignedIn") === "true" &&
      readIsSubscribed()
    );
  }

  // Team-space membership, like sharing, is per-space consent: team content
  // syncs while signed in + subscribed even when cloud backup is off (D7).
  private canSyncTeamSpaces(): boolean {
    return this.canSyncSharedNotes();
  }

  // Whether the API supports team scope (GET /api/me/teams deployed); probed
  // by syncSpaces and cached for the UI gate (useTeamSpacesCapability).
  private hasTeamSpacesCapability(): boolean {
    return readTeamSpacesCapability();
  }

  private cacheTeamSpacesCapability(available: boolean): void {
    writeTeamSpacesCapability(available);
    localStorage.setItem("teamSpacesCapability.probedAt", new Date().toISOString());
  }

  // Sign-out leaves no team content behind: purge every team space locally and
  // forget the capability probe + team cursors so the next account re-probes
  // and backfills from scratch. Never throws — a failed purge must not block
  // signing out.
  async purgeTeamSpacesForSignOut(): Promise<void> {
    // Wait for the sync lock: an in-flight pass (often in another window)
    // still holds a pre-purge space map, and its remaining rows would
    // re-insert team content after the purge — unreachable by any later
    // cleanup once the guard entries below are gone.
    try {
      await navigator.locks.request(SYNC_ALL_LOCK, () => this.purgeAllTeamSpaces());
    } catch (err) {
      console.error("Sign-out purge could not take the sync lock:", err);
      // Never block sign-out: purge unfenced rather than not at all.
      await this.purgeAllTeamSpaces();
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
      let localSpaces = (await window.electronAPI.getSpaces?.()) ?? [];
      const localTeamSpaces = localSpaces.filter((space) => space.kind === "team");
      if (localTeamSpaces.length === 0) {
        await assertAuthGenerationCurrent(authGeneration);
        return;
      }

      const remoteSpaces = await SpacesService.mySpacesForAuthValidation(authGeneration);
      await assertAuthGenerationCurrent(authGeneration);
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

  private async purgeAllTeamSpaces(): Promise<void> {
    try {
      const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
      for (const space of spaces) {
        if (space.kind !== "team") continue;
        try {
          // "revoked", not "deleted": the whole guard key is removed once the
          // sign-out purge completes, and if that removal ever fails a revoked
          // entry self-heals on the next pass instead of locking the space out.
          if (space.cloud_space_id) await markSpacePurged(space.cloud_space_id, "revoked");
          await window.electronAPI.purgeSpace?.(space.id, { mode: "destructive" });
        } catch (err) {
          console.error(`Purging space ${space.id} on sign-out failed:`, err);
        }
      }
    } catch (err) {
      console.error("Team space purge on sign-out failed:", err);
    }
    clearTeamSpacesCapability();
    localStorage.removeItem("teamSpacesCapability.probedAt");
    localStorage.removeItem("lastSyncedAt.notes.team");
    localStorage.removeItem("lastSyncedAt.folders.team");
    // The guard protected any pass still in flight during the purge; drop it
    // so the next account (possibly a member of the same spaces) starts clean.
    localStorage.removeItem(PURGED_SPACE_GUARD_KEY);
    // Pre-spaces guard key; stale entries are meaningless now.
    localStorage.removeItem("purgedTeamIds");
    // Both hold account-scoped/local numeric ids that collide across accounts.
    localStorage.removeItem("activeWorkspaceId");
    localStorage.removeItem("notesTree.expanded");
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
    const authGeneration = getValidatedAuthGeneration();
    if (authGeneration == null) return;
    // A pass already running may have synced past the data this request covers,
    // so flag a re-run instead of dropping it.
    if (this.syncing) {
      this.syncAllPending = true;
      return;
    }
    this.syncing = true;
    let teamSpacesReady = false;
    try {
      // Ambient passes skip when another window holds the lock — that pass
      // reads the same local DB and cloud state, so it covers this request.
      // Manual passes wait so a user action is never silently dropped.
      await navigator.locks.request(SYNC_ALL_LOCK, { ifAvailable: !waitForLock }, async (lock) => {
        if (!lock) return;
        teamSpacesReady = await this.syncSpaces(authGeneration);
        if (!hasValidatedAuthContext()) return;
        if (full) {
          await this.syncFolders();
          if (!hasValidatedAuthContext()) return;
          await this.syncNotes();
          if (!hasValidatedAuthContext()) return;
          await this.syncConversations();
          if (!hasValidatedAuthContext()) return;
          await this.syncTranscriptions();
          if (!hasValidatedAuthContext()) return;
          // Edits during the awaits above set dictionaryDirty (syncing is already
          // true), so re-run until clean rather than stalling until the next trigger.
          do {
            this.dictionaryDirty = false;
            await this.syncDictionary();
          } while (this.dictionaryDirty);
          do {
            this.snippetsDirty = false;
            await this.syncSnippets();
          } while (this.snippetsDirty);
        } else {
          // Backup is off: team-space content still syncs (membership is
          // consent, D7) and note deletes still propagate so revoked/deleted
          // shared notes stop being served (edits flow via debouncedPush).
          await this.syncFolders(true);
          if (!hasValidatedAuthContext()) return;
          await this.syncNotes(true);
        }
        if (!hasValidatedAuthContext()) return;
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
    const bypassThrottle = waitForLock || firstTeamSpacesProbe;
    if (
      !bypassThrottle &&
      (this.syncing || Date.now() - this.lastCompletedSyncAt() < AUTO_SYNC_THROTTLE_MS)
    ) {
      return;
    }
    void this.syncAll(waitForLock);
  }

  async syncDictionaryNow(): Promise<void> {
    if (!this.canSync()) return;
    // A sync already running will drain dictionaryDirty before it finishes, so
    // flag a re-run instead of dropping this request.
    if (this.syncing) {
      this.dictionaryDirty = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.dictionaryDirty = false;
        await this.syncDictionary();
      } while (this.dictionaryDirty);
    } catch (err) {
      console.error("Dictionary sync failed:", err);
    } finally {
      this.syncing = false;
    }
  }

  async syncSnippetsNow(): Promise<void> {
    if (!this.canSync()) return;
    if (this.syncing) {
      this.snippetsDirty = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.snippetsDirty = false;
        await this.syncSnippets();
      } while (this.snippetsDirty);
    } catch (err) {
      console.error("Snippets sync failed:", err);
    } finally {
      this.syncing = false;
    }
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
        if (isFolderNameTakenError(err)) {
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
      await this.createCloudFolder(folder, scope);
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
    if (readNoteConflictIds().has(note.client_note_id)) {
      // An unresolved conflict: the editor's debounced push would auto-resolve
      // it as local-wins (or 409-spam) before the user chose Keep or Refresh.
      return;
    }

    const { localToCloud, blockedFolderIds } = await this.buildLocalToCloudFolderMap();
    if (note.folder_id && blockedFolderIds.has(note.folder_id)) {
      // The folder's own changes haven't landed (e.g. a cross-space move that
      // 409'd on a name conflict): the server would reject this note's
      // folder_id as out of scope. Stay pending; the note retries after the
      // folder settles.
      return;
    }
    const ctx = await this.buildSpaceContext();
    const scope = this.resolvePushScope("note", note, ctx);
    if (!scope) return;
    const cloudFolderId = note.folder_id ? (localToCloud.get(note.folder_id) ?? null) : null;

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
          cloud.user_id ?? null
        );
      } else {
        await this.createCloudNote(note, cloudFolderId, scope);
      }
    } catch (err) {
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
    await resolveRendererCloudNoteCreate(note, cloud, (cloudId) => NotesService.delete(cloudId));
  }

  private async createCloudNote(
    note: NoteItem,
    cloudFolderId: string | null,
    scope: PushScopeFields
  ): Promise<void> {
    const cloud = await NotesService.create({
      client_note_id: note.client_note_id,
      ...buildNoteCreatePayload(note, cloudFolderId),
      ...scope,
      created_at: note.created_at,
    });
    await this.acknowledgeCloudNoteCreate(note, cloud);
  }

  // Batch-create fallback row push: recognized terminal rejections settle the
  // row by forking it to Personal; anything else re-queues as 'error'.
  private async pushFreshNote(
    note: NoteItem,
    scope: PushScopeFields,
    localToCloud: Map<number, string>,
    ctx: SpaceSyncContext
  ): Promise<void> {
    try {
      const cloudFolderId = note.folder_id ? (localToCloud.get(note.folder_id) ?? null) : null;
      await this.createCloudNote(note, cloudFolderId, scope);
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
    const note = await window.electronAPI.getNote?.(localId);
    if (!note) return null;
    if (note.cloud_id) return note.cloud_id;
    if (!this.canSyncSharedNotes()) return null;
    await this.pushNote(localId);
    const synced = await window.electronAPI.getNote?.(localId);
    return synced?.cloud_id ?? null;
  }

  private async pushConversation(id: number): Promise<void> {
    const full = await window.electronAPI.getAgentConversation?.(id);
    if (!full) return;

    if (full.cloud_id) {
      await ConversationsService.update(full.cloud_id, { title: full.title });
    } else {
      const cloud = await ConversationsService.create({
        client_conversation_id: String(full.id),
        title: full.title,
        created_at: full.created_at,
        updated_at: full.updated_at,
        messages: full.messages.map((m) => ({
          role: m.role,
          content: m.content,
          metadata: m.metadata
            ? typeof m.metadata === "string"
              ? JSON.parse(m.metadata)
              : m.metadata
            : null,
        })),
      });
      const linked = await window.electronAPI.markConversationSynced?.(full.id, cloud.id);
      if (linked?.success === false) {
        // The local row was purged while POST was in flight. It cannot carry a
        // delete tombstone, so retire the orphaned cloud row immediately.
        await ConversationsService.delete(cloud.id);
      }
    }
  }

  private async pushTranscription(id: number): Promise<void> {
    const t = await window.electronAPI.getTranscriptionById?.(id);
    if (!t || t.cloud_id) return;

    const cloud = await TranscriptionsService.create({
      client_transcription_id: t.client_transcription_id,
      text: t.text,
      raw_text: t.raw_text,
      provider: t.provider,
      model: t.model,
      audio_duration_ms: t.audio_duration_ms,
      status: t.status,
      created_at: t.created_at,
    });
    await window.electronAPI.markTranscriptionSynced?.(t.id, cloud.id);
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
      privateSpace: spaces.find((s) => s.kind === "private") ?? null,
      refreshedSpaces: false,
    };
  }

  // Maps a cloud row's space to its local row (space_id null → private space).
  // An unknown space means we gained access to it mid-pass: re-pull spaces
  // once, then park still-unmapped rows — space content never files into
  // Personal.
  private async resolveSpaceForCloudRow(
    cloudSpaceId: string | null | undefined,
    ctx: SpaceSyncContext
  ): Promise<SpaceItem | null> {
    if (!cloudSpaceId) return ctx.privateSpace;
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
    ctx.privateSpace = fresh.privateSpace;
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
  // it survives as a personal note with a forked identity, exactly like the
  // pull-side access_removed stub; never destroy the edits.
  private async handleRevokedNotePush(note: NoteItem, ctx: SpaceSyncContext): Promise<void> {
    const spaceName = ctx.byId.get(note.space_id)?.name ?? null;
    if (!ctx.privateSpace) {
      // The private space is a schema invariant. If a damaged database breaks
      // it, preserve the pending row rather than destroying unpushed edits.
      console.error(`Cannot relocate revoked note ${note.id}: private space is missing`);
      return;
    }
    await this.forkNoteToPrivate(note, ctx.privateSpace, "push", spaceName);
  }

  private read404Counts(key: string): Record<string, number> {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private write404Counts(key: string, counts: Record<string, number>): void {
    if (Object.keys(counts).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(counts));
    }
  }

  // Reset a row's consecutive-404 streak: the pull resolved it, a later push
  // settled, or it forked. Skips the write when the row wasn't being tracked.
  private clear404(key: string, clientId: string): void {
    const counts = this.read404Counts(key);
    const next = clearUpdate404(counts, clientId);
    if (next !== counts) this.write404Counts(key, next);
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
      this.read404Counts(NOTE_UPDATE_404_KEY),
      note.client_note_id,
      UPDATE_404_FORK_THRESHOLD
    );
    this.write404Counts(NOTE_UPDATE_404_KEY, next);
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
      this.read404Counts(FOLDER_UPDATE_404_KEY),
      folder.client_folder_id,
      UPDATE_404_FORK_THRESHOLD
    );
    this.write404Counts(FOLDER_UPDATE_404_KEY, next);
    if (fork) await this.handleRevokedFolderPush(folder, ctx);
  }

  // Applies the plan §7.2 fork (see revokedNoteForkUpdate) and surfaces the
  // relocation toast when the note actually moved.
  private async forkNoteToPrivate(
    note: NoteItem,
    privateSpace: SpaceItem,
    source: "push" | "pull",
    spaceName: string | null | undefined
  ): Promise<void> {
    const { update, relocated } = revokedNoteForkUpdate(note, privateSpace.id, source);
    await window.electronAPI.updateNote(note.id, update);
    if (relocated) this.dispatchNoteRelocated(note.title, spaceName);
  }

  // A folder PATCH was rejected because its team is gone or access was
  // revoked: the server row moved to a scope we can't write, so retrying
  // would fail forever. Preserve the dirty folder in Personal with a forked
  // identity so the next push re-creates it as personal (plan §7.2).
  private async handleRevokedFolderPush(folder: FolderItem, ctx: SpaceSyncContext): Promise<void> {
    if (!ctx.privateSpace) return;
    await window.electronAPI.relocateRevokedFolder?.(folder.id, ctx.privateSpace.id, true);
    this.dispatchNoteRelocated(folder.name, ctx.byId.get(folder.space_id)?.name);
  }

  // A note PATCH was denied (note_access_denied / note_scope_change_denied):
  // the server row is intact but this user may not change it. Preserve the
  // dirty local copy as a Personal fork with a new client identity — the
  // server row keeps the old one — then the caller snapshot-pulls the
  // untouched server note back into its original space.
  private async handleDeniedNoteUpdate(note: NoteItem, ctx: SpaceSyncContext): Promise<void> {
    if (!ctx.privateSpace) {
      console.error(`Cannot preserve denied note ${note.id}: private space is missing`);
      return;
    }
    const { update } = revokedNoteForkUpdate(note, ctx.privateSpace.id, "push");
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
    if (!ctx.privateSpace) {
      console.error(`Cannot preserve denied folder ${folder.id}: private space is missing`);
      return;
    }
    await window.electronAPI.relocateRevokedFolder?.(folder.id, ctx.privateSpace.id, true);
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
    if (!teamOnly) await this.adoptDefaultFolders();
    await this.pushPendingFolders(teamOnly);
    await this.pushFolderDeletes(teamOnly);
    if (!teamOnly && this.teamCursorLagging("folders")) {
      await this.pullFolders(true);
    }
    await this.pullFolders(teamOnly);
  }

  // Each platform seeds "Personal"/"Meetings" with its own random
  // client_folder_id, so the second device to sync would register them as
  // new folders and collide with the cloud's per-user unique folder name.
  // Before the first push, adopt the cloud identity of any same-named
  // default folder so both platforms converge on a single folder.
  private async adoptDefaultFolders(): Promise<void> {
    // Private space only — team folders never adopt by name.
    const pending = (await window.electronAPI.getPendingFolders?.("private")) ?? [];
    const unlinkedDefaults = pending.filter((f) => f.is_default && !f.cloud_id);
    if (unlinkedDefaults.length === 0) return;

    try {
      const { folders: cloudFolders } = await FoldersService.list();
      const cloudByName = new Map(
        cloudFolders
          .filter((f) => f.is_default && !f.deleted_at)
          .map((f) => [f.name.toLowerCase(), f])
      );
      for (const local of unlinkedDefaults) {
        const match = cloudByName.get(local.name.toLowerCase());
        if (!match) continue;
        await window.electronAPI.acknowledgeFolderCreate?.(
          local.id,
          local,
          local.cloud_id,
          match.client_folder_id ?? local.client_folder_id,
          match.id,
          match.updated_at
        );
      }
    } catch (err) {
      console.error("Default folder adoption failed:", err);
    }
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

  private async pushPendingFolders(teamOnly = false): Promise<void> {
    const pending =
      (await window.electronAPI.getPendingFolders?.(teamOnly ? "team" : undefined)) ?? [];
    if (pending.length === 0) return;

    const ctx = await this.buildSpaceContext();
    const pushable: Array<{ folder: FolderItem; scope: PushScopeFields }> = [];
    for (const folder of pending) {
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
        if (isFolderNameTakenError(err)) {
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
        const { created } = await FoldersService.batchCreate(
          fresh.map(({ folder, scope }) => ({
            name: folder.name,
            client_folder_id: folder.client_folder_id,
            is_default: !!folder.is_default,
            sort_order: folder.sort_order,
            ...scope,
          }))
        );
        // created preserves input order; the cloud may return an existing
        // folder with a different client_folder_id when a same-named
        // default already exists there — adopt its identity in that case.
        if (created.length !== fresh.length) {
          console.error(
            `Folder batch create returned ${created.length} folders for ${fresh.length} inputs; skipping identity adoption`
          );
          return;
        }
        for (const [i, cloudFolder] of created.entries()) {
          const local = fresh[i].folder;
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
  // row by forking it to Personal; anything else stays 'pending' for the next
  // pass.
  private async pushFreshFolder(
    folder: FolderItem,
    scope: PushScopeFields,
    ctx: SpaceSyncContext
  ): Promise<void> {
    try {
      await this.createCloudFolder(folder, scope);
    } catch (err) {
      if (isFolderNameTakenError(err)) {
        this.dispatchFolderNameTaken(folder.name);
      } else if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
        await this.handleRevokedFolderPush(folder, ctx);
        this.clear404(FOLDER_UPDATE_404_KEY, folder.client_folder_id);
      } else {
        console.error("Folder create sync failed:", err);
      }
    }
  }

  private async pullFolders(teamOnly = false, snapshot = false): Promise<boolean> {
    try {
      const cursorKey = teamOnly ? "lastSyncedAt.folders.team" : "lastSyncedAt.folders";
      const since = snapshot ? undefined : (localStorage.getItem(cursorKey) ?? undefined);
      const syncStartedAt = new Date().toISOString();
      const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
      const scope = teamCapable ? "all" : undefined;
      const { folders: cloudFolders } = await FoldersService.list(since, scope);
      const ctx = await this.buildSpaceContext();
      // Parked or failed rows must retry: they hold the cursor back (and fail
      // a backfill) so one bad row never drops the rest of the delta.
      let parkedRows = 0;

      for (const cloudFolder of cloudFolders) {
        try {
          const local = await window.electronAPI.getFolderByClientId?.(
            cloudFolder.client_folder_id ?? ""
          );

          // Redacted stub: the folder moved out of one of our teams. Clean
          // local copies (folder and child notes) are no longer ours to keep;
          // dirty ones move to the private space with forked identities so
          // unpushed work survives (plan §7.2).
          if (cloudFolder.access_removed) {
            if (!local) continue;
            if (ctx.privateSpace) {
              const preserveFolder = local.sync_status === "pending" && !local.deleted_at;
              const result = await window.electronAPI.relocateRevokedFolder?.(
                local.id,
                ctx.privateSpace.id,
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

          if (teamOnly && !cloudFolder.space_id) {
            // A personal row whose local copy still sits in a team space
            // announces a team→personal transition — apply it, or a later
            // edit's push would re-team the privatized folder.
            if (
              local &&
              !local.deleted_at &&
              ctx.byId.get(local.space_id)?.kind === "team" &&
              ctx.privateSpace
            ) {
              if (cloudFolder.deleted_at) {
                await window.electronAPI.hardDeleteFolder?.(local.id);
              } else if (
                // Pending rows are never overwritten by pull (D2), here too.
                local.sync_status !== "pending" &&
                isCloudEntryNewer(cloudFolder.updated_at, local.updated_at)
              ) {
                await window.electronAPI.upsertFolderFromCloud?.(
                  cloudFolder as unknown as Record<string, unknown>,
                  ctx.privateSpace.id
                );
              }
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
              await window.electronAPI.acknowledgeFolderCreate?.(
                nameMatch.id,
                nameMatch,
                nameMatch.cloud_id,
                cloudFolder.client_folder_id ?? nameMatch.client_folder_id,
                cloudFolder.id,
                cloudFolder.updated_at
              );
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
            await window.electronAPI.upsertFolderFromCloud?.(
              cloudFolder as unknown as Record<string, unknown>,
              space.id
            );
          }
        } catch (err) {
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
      if (advanceCursor) localStorage.setItem(cursorKey, syncStartedAt);
      if (advanceTeamCursor) localStorage.setItem("lastSyncedAt.folders.team", syncStartedAt);
      return parkedRows === 0;
    } catch (err) {
      console.error("Folder pull failed:", err);
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
    await this.pushNoteDeletes();
    await this.backfillNoteOwners(teamOnly);
    if (!teamOnly && this.teamCursorLagging("notes")) {
      await this.pullNotes(true);
    }
    // A parked pull left its cursors in place, so the next pass re-sees the
    // parked rows — typically after syncSpaces has mirrored the missing team.
    await this.pullNotes(teamOnly);
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

  private async pushPendingNotes(teamOnly = false): Promise<void> {
    const pending =
      (await window.electronAPI.getPendingNotes?.(teamOnly ? "team" : undefined)) ?? [];
    if (pending.length === 0) return;

    const { localToCloud, blockedFolderIds } = await this.buildLocalToCloudFolderMap();
    const ctx = await this.buildSpaceContext();
    const conflicted = readNoteConflictIds();
    const pushable: Array<{ note: NoteItem; scope: PushScopeFields }> = [];
    for (const note of pending) {
      if (conflicted.has(note.client_note_id)) {
        // An unresolved pull conflict: pushing now would auto-resolve it as
        // local-wins before the user chose Keep or Refresh (which clear the
        // registry entry and unblock the row).
        continue;
      }
      if (note.folder_id && blockedFolderIds.has(note.folder_id)) {
        // The folder's own changes haven't landed (e.g. a cross-space move
        // that 409'd on a name conflict): the server would reject the note's
        // folder_id as out of scope, stranding it in 'error'. Stay pending;
        // folder and notes push together once the conflict resolves.
        continue;
      }
      const scope = this.resolvePushScope("note", note, ctx);
      if (!scope) continue;
      pushable.push({ note, scope });
    }

    const migration = pushable.filter(({ note }) => note.cloud_id);
    const fresh = pushable.filter(({ note }) => !note.cloud_id);

    let denied = false;
    for (const { note, scope } of migration) {
      try {
        // Carry the full content: a pending row may hold edits that never
        // reached the server (offline debounced pushes fail silently), and
        // this PATCH marks the row synced — settling it without content
        // would strand the edit locally and hand the next pull a stale-but-
        // newer cloud copy to overwrite it with.
        const cloudFolderId = note.folder_id ? (localToCloud.get(note.folder_id) ?? null) : null;
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
          cloud.user_id ?? null
        );
        this.clear404(NOTE_UPDATE_404_KEY, note.client_note_id);
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (isNoteVersionConflictError(err)) {
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
      const chunk = fresh.slice(i, i + BATCH_SIZE);
      try {
        const { created } = await NotesService.batchCreate(
          chunk.map(({ note: n, scope }) => ({
            client_note_id: n.client_note_id,
            ...buildNoteCreatePayload(
              n,
              n.folder_id ? (localToCloud.get(n.folder_id) ?? null) : null
            ),
            created_at: n.created_at,
            ...scope,
          }))
        );
        for (const { client_note_id, id: cloudId, updated_at } of created) {
          const local = chunk.find(({ note }) => note.client_note_id === client_note_id);
          if (local) {
            await this.acknowledgeCloudNoteCreate(local.note, {
              id: cloudId,
              client_note_id,
              updated_at: updated_at ?? null,
            });
          }
        }
      } catch (err) {
        if (isAuthContextError(err)) throw err;
        if (isSpaceAccessError(err) || isPermissionDenialError(err)) {
          // A typed rejection can't be attributed to a row from the batch
          // response; create individually so one rejected note settles
          // terminally without stranding (or relocating) the rest.
          for (const { note, scope } of chunk) {
            await this.pushFreshNote(note, scope, localToCloud, ctx);
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

  private async pullNotes(teamOnly = false, snapshot = false): Promise<boolean> {
    try {
      const cursorKey = teamOnly ? "lastSyncedAt.notes.team" : "lastSyncedAt.notes";
      const since = snapshot ? undefined : (localStorage.getItem(cursorKey) ?? undefined);
      const syncStartedAt = new Date().toISOString();
      const ctx = await this.buildSpaceContext();
      const { cloudToLocal, defaultFolderId } = await this.buildCloudToLocalFolderMap(
        ctx.privateSpace?.id ?? null
      );
      const teamCapable = this.canSyncTeamSpaces() && this.hasTeamSpacesCapability();
      const scope = teamCapable ? "all" : undefined;

      let cursor: string | undefined = since;
      let cursorId: string | undefined;
      // Only rows that still need to be applied hold the delta cursor back.
      // Conflicts are durable in the local registry and resolve directly from
      // their stored cloud copy, so they must not re-pull the whole delta.
      let parkedRows = 0;
      while (true) {
        const { notes: cloudNotes } = since
          ? await NotesService.list(BATCH_SIZE, undefined, cursor, scope, cursorId)
          : await NotesService.list(BATCH_SIZE, cursor, undefined, scope, cursorId);
        if (cloudNotes.length === 0) break;

        for (const cloudNote of cloudNotes) {
          const local = await window.electronAPI.getNoteByClientId?.(
            cloudNote.client_note_id ?? ""
          );

          // A parent folder DELETE owns this note until its server result is
          // known. Do not turn a newer live row into a conflict or apply a
          // per-note tombstone; denial restores the journaled row in place,
          // while confirmation removes it with the folder cascade.
          if (local?.folder_delete_pending) continue;

          // Copy the cloud owner before any last-write-wins decision: an
          // unchanged note skips the upsert but must still gain its owner
          // (the owner_user_id backfill relies on this).
          if (local && shouldSetOwnerFromCloud(cloudNote, local)) {
            await window.electronAPI.setNoteOwnerFromCloud?.(local.id, cloudNote.user_id!);
          }

          // Redacted stub: the note moved out of one of our teams. Clean local
          // copies are no longer ours to keep; dirty ones ('pending' or
          // 'error') move to the private space so unpushed work survives
          // (plan §7.2).
          if (cloudNote.access_removed) {
            if (!local) continue;
            if (local.sync_status !== "synced" && !local.deleted_at && ctx.privateSpace) {
              await this.forkNoteToPrivate(
                local,
                ctx.privateSpace,
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

          if (teamOnly && !cloudNote.space_id) {
            // A personal row whose local copy still sits in a team space
            // announces a team→personal transition — apply it, or a later
            // edit's push would re-team the privatized note.
            if (local && !local.deleted_at && ctx.byId.get(local.space_id)?.kind === "team") {
              if (cloudNote.deleted_at) {
                await window.electronAPI.hardDeleteNote?.(local.id);
                await this.settleNoteConflict(local.client_note_id);
              } else if (isCloudEntryNewer(cloudNote.updated_at, local.updated_at)) {
                // 'error' rows carry unpushed work just like 'pending' ones.
                if (local.sync_status !== "synced") {
                  await this.surfaceNoteConflict(local.client_note_id, cloudNote);
                } else if (cloudNote.folder_id && !cloudToLocal.has(cloudNote.folder_id)) {
                  // Filing to the fallback would stick (the advanced cursor
                  // never re-pulls this row) — park until the folder arrives.
                  parkedRows++;
                  console.warn(
                    `Parking note ${cloudNote.id}: unknown folder ${cloudNote.folder_id}`
                  );
                } else if (ctx.privateSpace) {
                  await window.electronAPI.upsertNoteFromCloud?.(
                    cloudNote as unknown as Record<string, unknown>,
                    resolvePulledNoteFolderId(
                      cloudNote,
                      ctx.privateSpace.id,
                      cloudToLocal,
                      defaultFolderId
                    ),
                    ctx.privateSpace.id
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

          const space = await this.resolveSpaceForCloudRow(cloudNote.space_id, ctx);
          if (!space) {
            parkedRows++;
            console.warn(`Parking note ${cloudNote.id}: unknown space ${cloudNote.space_id}`);
            continue;
          }

          if (local?.deleted_at) continue;
          if (!local || isCloudEntryNewer(cloudNote.updated_at, local.updated_at)) {
            if (local && local.sync_status !== "synced") {
              // A newer cloud copy over unpushed local edits ('pending' or
              // 'error'): surface the conflict to the editor banner instead
              // of silently dropping the local edit (plan §7.3).
              await this.surfaceNoteConflict(local.client_note_id, cloudNote);
              continue;
            }
            if (cloudNote.folder_id && !cloudToLocal.has(cloudNote.folder_id)) {
              // The note's folder isn't known locally yet (created moments
              // ago, or its pull failed). Filing it to the fallback would
              // stick — the advanced cursor never re-pulls the row — so park
              // it like an unknown space until the folder arrives.
              parkedRows++;
              console.warn(`Parking note ${cloudNote.id}: unknown folder ${cloudNote.folder_id}`);
              continue;
            }
            await window.electronAPI.upsertNoteFromCloud?.(
              cloudNote as unknown as Record<string, unknown>,
              resolvePulledNoteFolderId(cloudNote, space.id, cloudToLocal, defaultFolderId),
              space.id
            );
            if (local) {
              // Applying cloud over a clean row settles any stale conflict.
              await this.settleNoteConflict(local.client_note_id);
            }
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
      if (advanceCursor) localStorage.setItem(cursorKey, syncStartedAt);
      if (advanceTeamCursor) localStorage.setItem("lastSyncedAt.notes.team", syncStartedAt);
      return parkedRows === 0;
    } catch (err) {
      console.error("Note pull failed:", err);
      return false;
    }
  }

  private async syncConversations(): Promise<void> {
    await this.pushPendingConversations();
    await this.pushConversationDeletes();
    await this.pullConversations();
  }

  private async pushPendingConversations(): Promise<void> {
    const pending = (await window.electronAPI.getPendingConversations?.()) ?? [];
    if (pending.length === 0) return;

    const migration = pending.filter((c) => c.cloud_id);
    const fresh = pending.filter((c) => !c.cloud_id);

    for (const conv of migration) {
      try {
        await ConversationsService.update(conv.cloud_id!, { title: conv.title });
        await window.electronAPI.markConversationSynced?.(conv.id, conv.cloud_id!);
      } catch (err) {
        console.error("Conversation migration sync failed:", err);
      }
    }

    for (const conv of fresh) {
      try {
        const full = await window.electronAPI.getAgentConversation?.(conv.id);
        if (!full) continue;
        const cloudConv = await ConversationsService.create({
          client_conversation_id: conv.client_conversation_id ?? String(conv.id),
          title: conv.title,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          messages: full.messages.map((m) => ({
            role: m.role,
            content: m.content,
            metadata: m.metadata
              ? typeof m.metadata === "string"
                ? JSON.parse(m.metadata)
                : m.metadata
              : null,
          })),
        });
        const linked = await window.electronAPI.markConversationSynced?.(conv.id, cloudConv.id);
        if (linked?.success === false) {
          await ConversationsService.delete(cloudConv.id);
        }
      } catch (err) {
        console.error("Conversation sync failed:", err);
      }
    }
  }

  private async pushConversationDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingConversationDeletes?.()) ?? [];
    for (const conv of deletes) {
      if (!conv.cloud_id) continue;
      try {
        await ConversationsService.delete(conv.cloud_id);
        await window.electronAPI.hardDeleteConversation?.(conv.id);
      } catch (err) {
        console.error("Conversation delete sync failed:", err);
      }
    }
  }

  private async pullConversations(snapshot = false): Promise<void> {
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

          if (cloudConv.deleted_at) {
            if (local) await window.electronAPI.hardDeleteConversation?.(local.id);
            continue;
          }

          // A live cloud row cannot override a local pending delete. The
          // tombstone stays queued for push; only the cloud tombstone branch
          // above is authoritative enough to hard-delete it locally.
          if (local?.deleted_at) continue;

          if (!local || isCloudEntryNewer(cloudConv.updated_at, local.updated_at)) {
            await window.electronAPI.upsertConversationFromCloud?.(
              cloudConv as unknown as Record<string, unknown>,
              (cloudConv.messages ?? []) as unknown as Array<Record<string, unknown>>
            );
          }
        }

        if (cloudConvs.length < BATCH_SIZE) break;
        const last = cloudConvs[cloudConvs.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor) break;
        cursor = next;
      }

      if (!snapshot) localStorage.setItem("lastSyncedAt.conversations", syncStartedAt);
    } catch (err) {
      console.error("Conversation pull failed:", err);
    }
  }

  private async syncTranscriptions(): Promise<void> {
    await this.pushPendingTranscriptions();
    await this.pushTranscriptionDeletes();
    await this.pullTranscriptions();
  }

  private async pushTranscriptionDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingTranscriptionDeletes?.()) ?? [];
    const withCloudId = deletes.filter((t) => t.cloud_id);
    if (withCloudId.length === 0) return;

    for (let i = 0; i < withCloudId.length; i += TRANSCRIPTION_BATCH_SIZE) {
      const chunk = withCloudId.slice(i, i + TRANSCRIPTION_BATCH_SIZE);
      try {
        const { deleted } = await TranscriptionsService.batchDelete(chunk.map((t) => t.cloud_id!));
        for (const cloudId of deleted) {
          const local = chunk.find((t) => t.cloud_id === cloudId);
          if (local) await window.electronAPI.hardDeleteTranscription?.(local.id);
        }
      } catch (err) {
        console.error("Transcription batch delete failed:", err);
      }
    }
  }

  private async pushPendingTranscriptions(): Promise<void> {
    const pending = ((await window.electronAPI.getPendingTranscriptions?.()) ?? []).filter(
      (t) => !!t.text?.trim()
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
          }))
        );
        for (const cloudT of created) {
          const local = chunk.find(
            (t) => t.client_transcription_id === cloudT.client_transcription_id
          );
          if (local) await window.electronAPI.markTranscriptionSynced?.(local.id, cloudT.id);
        }
      } catch (err) {
        console.error("Transcription batch create failed:", err);
      }
    }
  }

  private async pullTranscriptions(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.transcriptions") ?? undefined;
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
            if (local) await window.electronAPI.hardDeleteTranscription?.(local.id);
            continue;
          }

          if (!cloudT.text) continue;

          if (!local) {
            await window.electronAPI.upsertTranscriptionFromCloud?.(
              cloudT as unknown as Record<string, unknown>
            );
          }
        }

        if (cloudTs.length < TRANSCRIPTION_BATCH_SIZE) break;
        const last = cloudTs[cloudTs.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor) break;
        cursor = next;
      }

      localStorage.setItem("lastSyncedAt.transcriptions", syncStartedAt);
    } catch (err) {
      console.error("Transcription pull failed:", err);
    }
  }

  private async syncDictionary(): Promise<void> {
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

    await this.pushPendingDictionary();
    await this.pushDictionaryDeletes();
    await this.pullDictionary();
  }

  private async pushPendingDictionary(): Promise<void> {
    const pending = (await window.electronAPI.getPendingDictionary?.()) ?? [];
    if (pending.length === 0) return;

    const updates = pending.filter((e) => e.cloud_id);
    const creates = pending.filter((e) => !e.cloud_id);

    for (const entry of updates) {
      try {
        await DictionaryService.update(entry.cloud_id!, {
          word: entry.word,
          source: entry.source,
        });
        await window.electronAPI.markDictionarySynced?.(entry.id, entry.cloud_id!);
      } catch (err) {
        // 404: another device purged the cloud row. Clear the stale cloud_id so
        // the next push re-creates it via batchCreate instead of retrying PATCH.
        if (isHttpStatus(err, 404)) {
          await window.electronAPI.clearDictionaryCloudId?.(entry.id);
        } else {
          console.error("Dictionary update sync failed:", err);
        }
      }
    }

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
          }))
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
          // delete the freshly-created server row so we don't orphan it.
          const result = await window.electronAPI.markDictionarySynced?.(local.id, server.id);
          if (result && result.changes === 0) {
            try {
              await DictionaryService.delete(server.id);
            } catch (deleteErr) {
              console.error("Dictionary orphan cleanup failed:", deleteErr);
            }
          }
        }
        if (unmatched > 0) {
          console.warn(
            `Dictionary batch-create: ${unmatched}/${chunk.length} rows had no matching server response`
          );
        }
      } catch (err) {
        console.error("Dictionary batch create failed:", err);
      }
    }
  }

  private async pushDictionaryDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingDictionaryDeletes?.()) ?? [];
    for (const entry of deletes) {
      if (!entry.cloud_id) continue;
      try {
        await DictionaryService.delete(entry.cloud_id);
        await window.electronAPI.hardDeleteDictionary?.(entry.id);
      } catch (err) {
        // 404 means the row is already gone server-side — treat as success.
        if (isHttpStatus(err, 404)) {
          await window.electronAPI.hardDeleteDictionary?.(entry.id);
        } else {
          console.error("Dictionary delete sync failed:", err);
        }
      }
    }
  }

  private async pullDictionary(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.dictionary") ?? undefined;
      const sinceId = localStorage.getItem("lastSyncedAt.dictionary.id") ?? undefined;
      let changed = false;

      let cursor: string | undefined = since;
      let cursorId: string | undefined = sinceId;
      let maxUpdatedAt = normalizeTimestamp(since);
      let maxId = sinceId ?? "";

      while (true) {
        const { entries, hasMore } = await DictionaryService.list(
          cursor,
          DICTIONARY_BATCH_SIZE,
          cursorId
        );
        if (entries.length === 0) break;

        for (const cloudEntry of entries) {
          const local = await window.electronAPI.getDictionaryByClientId?.(
            cloudEntry.client_dict_id ?? ""
          );

          if (cloudEntry.deleted_at) {
            if (local) {
              await window.electronAPI.hardDeleteDictionary?.(local.id);
              changed = true;
            }
            continue;
          }

          // Last-writer-wins on normalized timestamps (see normalizeTimestamp).
          const cloudTs = normalizeTimestamp(cloudEntry.updated_at);
          const localTs = local ? normalizeTimestamp(local.updated_at) : "";
          if (!local || cloudTs > localTs) {
            await window.electronAPI.upsertDictionaryFromCloud?.(
              cloudEntry as unknown as Record<string, unknown>
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
        // Stall guard: if the (updated_at, id) cursor didn't advance after a
        // full page, bail rather than loop forever.
        if (last.updated_at === cursor && last.id === cursorId) break;
        cursor = last.updated_at;
        cursorId = last.id;
      }

      if (maxUpdatedAt) localStorage.setItem("lastSyncedAt.dictionary", maxUpdatedAt);
      if (maxId) localStorage.setItem("lastSyncedAt.dictionary.id", maxId);
      if (changed) await window.electronAPI.broadcastDictionaryUpdated?.();
    } catch (err) {
      console.error("Dictionary pull failed:", err);
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
    await this.pushSnippetDeletes();
    await this.pullSnippets();
  }

  private async pushPendingSnippets(): Promise<void> {
    const pending = (await window.electronAPI.getPendingSnippets?.()) ?? [];
    if (pending.length === 0) return;

    const updates = pending.filter((e) => e.cloud_id);
    const creates = pending.filter((e) => !e.cloud_id);

    for (const entry of updates) {
      try {
        const server = await SnippetService.update(entry.cloud_id!, {
          trigger: entry.trigger,
          replacement: entry.replacement,
        });
        await window.electronAPI.markSnippetSynced?.(
          entry.id,
          server.id,
          server.updated_at,
          entry.trigger,
          entry.replacement
        );
      } catch (err) {
        if (isHttpStatus(err, 404)) {
          // Cloud row purged elsewhere — drop the stale cloud_id so the next push
          // re-creates it via batchCreate.
          await window.electronAPI.clearSnippetCloudId?.(entry.id);
        } else if (isHttpStatus(err, 409)) {
          // Another snippet already holds this trigger, so the server keeps
          // rejecting the rename. Mark synced to stop re-pushing the doomed PATCH.
          await window.electronAPI.markSnippetSynced?.(
            entry.id,
            entry.cloud_id!,
            undefined,
            entry.trigger,
            entry.replacement
          );
        } else {
          console.error("Snippet update sync failed:", err);
        }
      }
    }

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
          }))
        );
        const byClientId = new Map(created.map((c) => [c.client_snippet_id, c]));
        let unmatched = 0;
        for (const local of chunk) {
          const server = byClientId.get(local.client_snippet_id);
          if (!server) {
            unmatched += 1;
            continue;
          }
          const result = await window.electronAPI.markSnippetSynced?.(
            local.id,
            server.id,
            server.updated_at,
            local.trigger,
            local.replacement
          );
          if (result && result.changes === 0) {
            try {
              await SnippetService.delete(server.id);
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
        console.error("Snippet batch create failed:", err);
      }
    }
  }

  private async pushSnippetDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingSnippetDeletes?.()) ?? [];
    for (const entry of deletes) {
      if (!entry.cloud_id) continue;
      try {
        await SnippetService.delete(entry.cloud_id);
        await window.electronAPI.hardDeleteSnippet?.(entry.id);
      } catch (err) {
        if (isHttpStatus(err, 404)) {
          await window.electronAPI.hardDeleteSnippet?.(entry.id);
        } else {
          console.error("Snippet delete sync failed:", err);
        }
      }
    }
  }

  private async pullSnippets(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.snippets") ?? undefined;
      const sinceId = localStorage.getItem("lastSyncedAt.snippets.id") ?? undefined;
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
            cloudEntry as unknown as Record<string, unknown>
          );

          if (cloudTs > maxUpdatedAt) {
            maxUpdatedAt = cloudTs;
            maxId = cloudEntry.id;
          } else if (cloudTs === maxUpdatedAt && cloudEntry.id > maxId) {
            maxId = cloudEntry.id;
          }

          if (cloudEntry.deleted_at) {
            if (local && !(local.sync_status === "pending" && !local.cloud_id)) {
              await window.electronAPI.hardDeleteSnippet?.(local.id);
              changed = true;
            }
            continue;
          }

          const localTs = local ? normalizeTimestamp(local.updated_at) : "";
          const shouldApply =
            !local ||
            cloudTs > localTs ||
            (local.sync_status !== "pending" &&
              (!local.cloud_id || local.cloud_id !== cloudEntry.id));
          if (shouldApply) {
            await window.electronAPI.upsertSnippetFromCloud?.(
              cloudEntry as unknown as Record<string, unknown>
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

      if (maxUpdatedAt) localStorage.setItem("lastSyncedAt.snippets", maxUpdatedAt);
      if (maxId) localStorage.setItem("lastSyncedAt.snippets.id", maxId);
      if (changed) await window.electronAPI.broadcastSnippetsUpdated?.();
    } catch (err) {
      console.error("Snippet pull failed:", err);
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

  private async buildCloudToLocalFolderMap(privateSpaceId: number | null): Promise<{
    cloudToLocal: Map<string, { id: number; space_id: number }>;
    defaultFolderId: number | null;
  }> {
    const folders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
    const cloudToLocal = new Map(
      folders
        .filter((f) => f.cloud_id)
        .map((f) => [f.cloud_id!, { id: f.id, space_id: f.space_id }])
    );
    const personalFolder = folders.find(
      (f) => f.is_default && f.name === "Personal" && f.space_id === privateSpaceId
    );
    return { cloudToLocal, defaultFolderId: personalFolder?.id ?? null };
  }
}

export const syncService = new SyncService();
