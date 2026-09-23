import { SyncCancelledError, uncheckedSync, type SyncCheckpoint } from './syncContext';
import * as Sentry from '@sentry/react-native';
import { notesRepository, spacesRepository } from '@/data';
import {
  batchCreateFolders,
  updateFolder,
  deleteFolder,
  type FolderPushInput,
  type FolderUpdateInput,
} from '@/data/remote/notesApi';
import { isPermissionDenialCode, isSpaceAccessCode } from './pushErrorCodes';
import { createPushScopeResolver, createTeamSpaceFilter } from './pushScope';
import type { Folder } from '@/data';

// /api/folders/batch-create rejects bodies over 50 folders (zod .max(50)),
// the same cap the notes endpoint enforces — see pushNotes.ts.
const PUSH_BATCH_SIZE = 50;

// Bucket key for creates that carry no space: personal scope, or no scope
// fields at all on a pre-spaces backend. Server space ids are uuids, so the
// empty string can never collide with one.
const PERSONAL_SCOPE_KEY = '';

interface ApiErrorLike {
  status?: number;
  code?: string;
}

interface FolderCreateRow {
  pushed: Folder;
  localId: number;
  payload: FolderPushInput;
}

// The org turned cloud backup off (see policyBlocked in syncEngine.ts). Every
// row would fail identically, so bail out of the whole push immediately
// instead of retry-counting each one — see the matching guard in
// pushNotes.ts. Duck-typed so this file stays decoupled from apiClient.
function isPolicyCloudBackupBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ApiErrorLike;
  return e.status === 403 && e.code === 'POLICY_CLOUD_BACKUP_BLOCKED';
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as ApiErrorLike).code;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as ApiErrorLike).status;
}

/**
 * Why the server refused, when it said so with a code.
 *
 * - `spaceAccess`: the space is gone, archived, or no longer ours.
 * - `permission`: the space is ours but this folder isn't ours to write
 *   (folder_access_denied).
 * - `null`: no recognized code. Notably folder_name_taken (409, a collision
 *   with a same-named folder in the target scope) lands here on purpose — it
 *   resolves as soon as the user or another device renames one of the two, so
 *   the row keeps pendingSync and retries.
 *
 * Both coded kinds settle the same way for the rows they cover: stop retrying,
 * leave the local folder exactly as it is. Its notes recover one by one through
 * their own push errors and the pull's access-removed stubs.
 */
type FolderPushErrorKind = 'spaceAccess' | 'permission' | null;

function classifyFolderPushError(error: unknown): FolderPushErrorKind {
  const code = errorCode(error);
  if (isSpaceAccessCode(code)) return 'spaceAccess';
  if (isPermissionDenialCode(code)) return 'permission';
  return null;
}

function reportTerminalFolderPush(operation: 'create' | 'update', detail: string): void {
  Sentry.addBreadcrumb({
    category: 'sync',
    message: `pushFolders: ${operation} ${detail} refused (space access or permission); giving up, local folder left as-is`,
    level: 'warning',
  });
}

/**
 * Finds an already-synced duplicate of a pending default-folder create, so
 * the caller can adopt instead of push a create the server would reject with
 * folder_name_taken (409, retryable — see classifyFolderPushError) forever.
 * Reachable in practice: backfill mints a client id for a local default
 * folder (pendingSync=1, remote_id null) but the run ends before this push
 * lands; another device creates its own same-named default folder
 * server-side; the next run's pullFolders (backfill's one-shot flag is
 * already set, so it never runs again) inserts that as a SECOND local row —
 * matched only by client/remote id, never by name (see applyRemoteFolder) —
 * leaving two local "Personal" rows, one of them permanently unpushable.
 *
 * Scoped to the private space, same as initialBackfill's own name match
 * (Requirement 2) — a team folder is identified by cloud id only.
 */
function findDuplicateDefaultFolder(
  candidate: Folder,
  // A getter, not the map itself: JS evaluates call arguments eagerly, so
  // passing an already-built map would defeat the laziness getPrivateFoldersByName
  // exists for — every row would pay for the getFolders() read, not just
  // default-folder creates.
  getPrivateFoldersByName: () => Map<string, Folder>,
): Folder | null {
  if ((candidate.isDefault ?? 0) !== 1) return null;
  const match = getPrivateFoldersByName().get(candidate.name.toLowerCase());
  return match && match.id !== candidate.id ? match : null;
}

// `teamOnly` restricts the push to rows whose local space is `kind === 'team'`
// (see createTeamSpaceFilter) — used by the team-only sync pass in
// syncEngine.ts when the personal paygate is closed. Default false pushes
// every pending row exactly as before.
export async function pushFolders(
  teamOnly = false,
  checkpoint: SyncCheckpoint = uncheckedSync,
): Promise<void> {
  checkpoint();
  let pending = notesRepository.getPendingFolders();
  if (teamOnly) {
    const isTeamRow = createTeamSpaceFilter();
    // A pending delete is exempt from the filter: DELETE carries no body, so
    // scope never applies to one (see the delete loop below), and full-mode
    // pushFolders() never filters deletes by space either — a delete must
    // flow the same way in both modes. This also covers a row whose space was
    // revoked earlier in this same run (syncSpaces soft-deletes it), which
    // would otherwise make isTeamRow stop recognizing a genuinely team-owned
    // delete and silently hold it forever.
    pending = pending.filter((f) => f.deletedAt != null || isTeamRow(f.spaceId));
  }
  if (pending.length === 0) return;

  // Creates are bucketed by the scope their payload carries, never mixed —
  // see pushNotes.ts. The server validates every distinct space in the body
  // before inserting anything, so a batch spanning two spaces would let one
  // revoked space settle rows belonging to a healthy one (and to personal).
  const createsByScope = new Map<string, FolderCreateRow[]>();
  const updates: {
    pushed: Folder;
    localId: number;
    remoteId: string;
    payload: FolderUpdateInput;
  }[] = [];
  const deletes: { localId: number; remoteId: string }[] = [];
  let failed = 0;
  let skippedPendingSpace = 0;

  // Read once per pass — see pushNotes.ts. Rows queued for deletion never
  // reach it: DELETE carries no body, so scope does not apply to one.
  const resolveScope = createPushScopeResolver();

  // Lazily built (and only once): a duplicate default folder is a rare
  // recovery case, so most passes never pay for the extra getFolders() read.
  let privateFoldersByName: Map<string, Folder> | null = null;
  const getPrivateFoldersByName = (): Map<string, Folder> => {
    if (privateFoldersByName === null) {
      const privateSpaceId = spacesRepository.getPrivateSpace().id;
      privateFoldersByName = new Map();
      for (const existing of notesRepository.getFolders()) {
        if (existing.spaceId === privateSpaceId && existing.remoteId) {
          privateFoldersByName.set(existing.name.toLowerCase(), existing);
        }
      }
    }
    return privateFoldersByName;
  };

  for (const f of pending) {
    if (f.deletedAt) {
      if (f.remoteId) deletes.push({ localId: f.id, remoteId: f.remoteId });
      // Never reached the server, so there is no verdict to wait for: settle the
      // whole cascade — folder, its journaled notes, and the journal — right now.
      else notesRepository.finalizeFolderDelete(f.id);
      continue;
    }
    const scope = resolveScope(f.spaceId);
    if (!scope) {
      // Its space isn't pushable right now: a team skeleton with no cloud id
      // yet, or a space this device just lost. Keep pendingSync and retry once
      // the space resolves. Not a failure.
      skippedPendingSpace += 1;
      continue;
    }
    if (!f.remoteId) {
      if (!f.clientFolderId) {
        Sentry.captureMessage('pushFolders: missing clientFolderId', 'warning');
        continue;
      }
      const duplicate = findDuplicateDefaultFolder(f, getPrivateFoldersByName);
      if (duplicate) {
        // duplicate.remoteId is guaranteed non-null: only rows with one are
        // ever added to privateFoldersByName.
        notesRepository.adoptDuplicateFolder(
          f.id,
          duplicate.id,
          duplicate.remoteId as string,
          duplicate.updatedAt ?? new Date().toISOString(),
        );
        Sentry.addBreadcrumb({
          category: 'sync',
          message: `pushFolders: adopted duplicate default folder "${f.name}" (local ${duplicate.id} → ${f.id}) instead of creating`,
          level: 'info',
        });
        continue;
      }
      const create: FolderCreateRow = {
        pushed: f,
        localId: f.id,
        payload: {
          name: f.name,
          client_folder_id: f.clientFolderId,
          is_default: (f.isDefault ?? 0) === 1,
          sort_order: f.sortOrder ?? 0,
          ...scope,
        },
      };
      const scopeKey = scope.space_id ?? PERSONAL_SCOPE_KEY;
      const bucket = createsByScope.get(scopeKey);
      if (bucket) bucket.push(create);
      else createsByScope.set(scopeKey, [create]);
      continue;
    }
    // Updates deliberately carry NO scope fields. There is no folder-level
    // base_updated_at to make a scope claim conditional, and mobile has no
    // folder-move feature, so a rename that also asserted scope could only ever
    // reverse a move made elsewhere. Omitted keys leave the server's scope
    // untouched. The resolver is still consulted above: a folder whose space
    // isn't pushable waits, exactly like a note.
    updates.push({
      pushed: f,
      localId: f.id,
      remoteId: f.remoteId,
      payload: { name: f.name, sort_order: f.sortOrder ?? 0 },
    });
  }

  if (skippedPendingSpace > 0) {
    Sentry.addBreadcrumb({
      category: 'sync',
      message: `pushFolders: skipped ${skippedPendingSpace} row(s) whose space is not pushable (no cloud id yet, or no longer resolvable)`,
      level: 'info',
    });
  }

  // One scope bucket at a time, chunked within the bucket: /api/folders/batch-create
  // caps a body at 50 folders, and a chunk must carry a single scope so a
  // rejection is attributable to exactly the space whose rows were in flight.
  for (const [scopeKey, scopedCreates] of createsByScope) {
    const personalScope = scopeKey === PERSONAL_SCOPE_KEY;
    for (let i = 0; i < scopedCreates.length; i += PUSH_BATCH_SIZE) {
      const chunk = scopedCreates.slice(i, i + PUSH_BATCH_SIZE);
      try {
        checkpoint(true);
        const created = await batchCreateFolders(chunk.map((c) => c.payload));
        checkpoint();
        // Match by client_folder_id first — batch responses aren't guaranteed to
        // preserve request order (or to include every row on a partial rejection).
        // Fall back to positional index only when a response row carries no
        // client_folder_id. Mirrors pushNotes.ts's create-response matching.
        const byClientId = new Map(
          created
            .filter((server) => server.client_folder_id)
            .map((server) => [server.client_folder_id as string, server]),
        );
        let unmatched = 0;
        for (let j = 0; j < chunk.length; j += 1) {
          const create = chunk[j];
          const server =
            byClientId.get(create.payload.client_folder_id) ??
            (!created[j]?.client_folder_id ? created[j] : undefined);
          if (!server?.id) {
            unmatched += 1;
            continue;
          }
          notesRepository.markFolderPushed(
            create.localId,
            server.id,
            server.updated_at,
            create.pushed,
          );
        }
        if (unmatched > 0) {
          Sentry.captureMessage(
            `pushFolders: ${unmatched}/${chunk.length} create rows had no matching server response`,
            'warning',
          );
        }
      } catch (e) {
        if (e instanceof SyncCancelledError) throw e;
        checkpoint();
        if (isPolicyCloudBackupBlocked(e)) throw e;
        let kind = classifyFolderPushError(e);
        // A personal-scope chunk has no space to lose. The server can still
        // answer with a space-access code (batch-create also checks the SOURCE
        // space of any existing row a client_folder_id matches), but that is
        // evidence about a space these rows aren't being pushed into, so it
        // must never settle them — retry instead. A per-row permission denial
        // is evidence about this very write, so it still settles.
        if (kind === 'spaceAccess' && personalScope) {
          Sentry.addBreadcrumb({
            category: 'sync',
            message:
              'pushFolders: personal-scope create chunk returned a space-access code; retrying instead of settling',
            level: 'warning',
          });
          kind = null;
        }
        if (kind !== null) {
          // batch-create is all-or-nothing with no per-row detail, so the chunk
          // settles together — bounded to this one scope.
          for (const c of chunk) notesRepository.markFolderTerminal(c.localId);
          reportTerminalFolderPush('create', `${chunk.length} row(s)`);
        } else {
          failed += 1;
          Sentry.captureException(e, { tags: { sync: 'pushFolders.create' } });
        }
      }
    }
  }

  for (const u of updates) {
    try {
      checkpoint(true);
      const server = await updateFolder(u.remoteId, u.payload);
      checkpoint();
      notesRepository.markFolderPushed(u.localId, server.id, server.updated_at, u.pushed);
    } catch (e) {
      if (e instanceof SyncCancelledError) throw e;
      checkpoint();
      if (isPolicyCloudBackupBlocked(e)) throw e;
      if (classifyFolderPushError(e) !== null) {
        notesRepository.markFolderTerminal(u.localId);
        reportTerminalFolderPush('update', `for folder ${u.localId}`);
      } else {
        failed += 1;
        Sentry.captureException(e, { tags: { sync: 'pushFolders.update' } });
      }
    }
  }

  for (const d of deletes) {
    try {
      checkpoint(true);
      await deleteFolder(d.remoteId);
      checkpoint();
      notesRepository.finalizeFolderDelete(d.localId);
    } catch (e) {
      if (e instanceof SyncCancelledError) throw e;
      checkpoint();
      if (isPolicyCloudBackupBlocked(e)) throw e;
      // Coded refusals are classified BEFORE the bare-404 check: space_not_found
      // and team_not_found also arrive as 404s, and those mean "the scope is not
      // ours", not "the folder is already deleted" — finalizing on one would
      // destroy local notes over a scope problem.
      //
      // A coded refusal is final — a member deleting a space folder the server
      // reserves for admins, or a space that is archived or no longer ours.
      // Unlike a create or an update, a delete cannot be left "as-is": the
      // folder and its notes are already tombstoned locally, so giving up
      // without undoing would hide them forever.
      if (classifyFolderPushError(e) !== null) {
        notesRepository.revertFolderDelete(d.localId);
        Sentry.addBreadcrumb({
          category: 'sync',
          message: `pushFolders: delete ${d.remoteId} refused (space access or permission); folder and its notes restored`,
          level: 'warning',
        });
        continue;
      }
      // An uncoded 404: the folder row itself is already gone server-side, so
      // the delete it was asking for has effectively happened.
      if (errorStatus(e) === 404) {
        notesRepository.finalizeFolderDelete(d.localId);
        continue;
      }
      // Anything else (offline, 5xx) is transient: leave the cascade in place so
      // the next pass retries the delete.
      failed += 1;
      Sentry.captureException(e, { tags: { sync: 'pushFolders.delete' } });
    }
  }

  if (failed > 0) {
    throw new Error(`pushFolders: ${failed} operation(s) failed`);
  }
}
