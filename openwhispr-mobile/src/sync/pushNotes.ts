import { SyncCancelledError, uncheckedSync, type SyncCheckpoint } from './syncContext';
import * as Sentry from '@sentry/react-native';
import { notesRepository } from '@/data';
import {
  batchCreateNotes,
  updateNote,
  deleteNote,
  type NotePushInput,
} from '@/data/remote/notesApi';
import { serializeSegmentsForSync } from '@/lib/notes/remoteTranscript';
import { isPermissionDenialCode, isSpaceAccessCode } from './pushErrorCodes';
import { createPushScopeResolver, createTeamSpaceFilter } from './pushScope';
import { resetTeamCursors } from './teamCursors';
import { forgetNoteCreateAttempts, recordNoteCreateAttempts } from './noteCreateAttempts';
import type { Note, RemoteNote } from '@/data';

// The server rejects POST /api/notes/batch-create bodies over 50 notes (zod
// .max(50)); chunk so a large first sync doesn't 400 the whole batch at once.
// Same constant name as pushDictionary.ts / pushSnippets.ts, different value —
// theirs isn't pinned to a server-enforced cap.
const PUSH_BATCH_SIZE = 50;

// Bucket key for creates whose payload carries no space: an explicit-null
// (personal) scope, or no scope fields at all on a pre-spaces backend. Server
// space ids are uuids, so the empty string can never collide with one.
const PERSONAL_SCOPE_KEY = '';

/** Rows serialized into a transcript push, so their pendingSync can be cleared on success. */
interface PushedTranscript {
  raw: string;
  segmentIds: number[];
  speakerIds: number[];
}

interface ApiErrorLike {
  status?: number;
  code?: string;
  data?: unknown;
}

function isHttpStatus(error: unknown, status: number): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as ApiErrorLike).status === status;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as ApiErrorLike).code;
}

interface NoteVersionConflictData {
  note?: RemoteNote;
}

// A 409 the server tags `note_version_conflict` means our update carried a
// stale base_updated_at — someone else edited this note since we last synced.
// Distinct from the generic retry path (an untagged 409 falls through to
// classifyPushError below): returns the server's current copy so the caller
// can park the row instead of retrying the same doomed payload forever.
function noteVersionConflictServerNote(error: unknown): RemoteNote | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as ApiErrorLike;
  if (e.status !== 409 || e.code !== 'note_version_conflict') return undefined;
  return (e.data as NoteVersionConflictData | undefined)?.note;
}

// The org turned cloud backup off (see policyBlocked in syncEngine.ts). Every
// row would fail identically, so bail out of the whole push immediately
// instead of retry-counting each one — that would both mark pendingSync work
// as a generic failure and bury the signal inside "N operation(s) failed".
// Duck-typed (not `instanceof ApiError`) so this file stays decoupled from
// the real apiClient module, matching isHttpStatus above.
function isPolicyCloudBackupBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ApiErrorLike;
  return e.status === 403 && e.code === 'POLICY_CLOUD_BACKUP_BLOCKED';
}

type PushNoteErrorAction =
  | { type: 'retry' } // count as failure, retry on the next sync (default)
  | { type: 'terminal' } // server permanently rejected the row; give up on it
  | { type: 'resetRemoteId' } // target is gone server-side; re-create next sync
  | { type: 'spaceAccessLost' } // the row's space is gone/revoked/archived
  | { type: 'permissionDenied' }; // space is fine, this write is not allowed

// Code-aware first, status-based second, for create/update push failures.
//
// Codes (see pushErrorCodes.ts) describe *why* the server refused and outrank
// the status they arrive with — a space-access rejection is a 403/404/410, all
// of which the status rules below would otherwise mishandle:
// - space-access family: the space left our reach, so the row can never push
//   as-is; the caller re-homes it to personal.
// - permission denials: the server row was NOT modified, so the local attempt
//   is dropped and server truth is re-pulled.
//
// Statuses keep their pre-existing meaning whenever no code matches:
// - 400 (validation): the server will never accept this payload as-is — terminal.
// - 404 on update only: the target row is gone server-side — clear remoteId so the
//   next sync re-creates it instead of retrying the update forever.
// - Everything else (401/403, 5xx, network errors, and an untagged 409) retries
//   on the next sync. A 409 coded `note_version_conflict` never reaches this
//   function — noteVersionConflictServerNote intercepts it in the update catch
//   block above and parks the row instead.
function classifyPushError(error: unknown, operation: 'create' | 'update'): PushNoteErrorAction {
  const code = errorCode(error);
  if (isSpaceAccessCode(code)) return { type: 'spaceAccessLost' };
  if (isPermissionDenialCode(code)) return { type: 'permissionDenied' };
  if (isHttpStatus(error, 400)) return { type: 'terminal' };
  if (operation === 'update' && isHttpStatus(error, 404)) return { type: 'resetRemoteId' };
  return { type: 'retry' };
}

/** Rows the create/update paths share, for the code-aware recovery helpers below. */
interface PushedNoteRow {
  localId: number;
  /** The row as it was serialized, so the ack can tell whether it changed in flight. */
  pushed: Note;
  /** Whether the row still holds unpushed work worth preserving. */
  dirty: boolean;
}

type NoteCreateRow = PushedNoteRow & {
  payload: NotePushInput;
  fallbackUpdatedAt: string;
  pushedTranscript: PushedTranscript | null;
};

// The space this row belongs to is gone, archived, or no longer ours. Unpushed
// work survives as a fresh personal note (still pending, so it re-creates as
// personal next pass — exactly what the pull-side access-removed stub does);
// a row with nothing left to push simply stops retrying.
function recoverSpaceAccessLost(rows: PushedNoteRow[], operation: 'create' | 'update'): void {
  for (const row of rows) {
    if (row.dirty) notesRepository.forkNoteToPrivate(row.localId);
    else notesRepository.markNoteTerminal(row.localId);
  }
  Sentry.addBreadcrumb({
    category: 'sync',
    message: `pushNotes: ${rows.length} ${operation} row(s) rejected — space access lost; dirty rows forked to personal`,
    level: 'warning',
  });
}

// The space is still ours but this specific write isn't allowed (someone
// else's note, or a scope change we may not make). The server row was never
// touched, so the local attempt is abandoned and the team cursors are reset so
// the next sync re-crawls server truth over whatever this device believed.
function recoverPermissionDenied(rows: PushedNoteRow[], operation: 'create' | 'update'): void {
  for (const row of rows) notesRepository.dropNotePushAttempt(row.localId);
  resetTeamCursors();
  Sentry.addBreadcrumb({
    category: 'sync',
    message: `pushNotes: ${rows.length} ${operation} row(s) denied by permission; team cursors reset`,
    level: 'warning',
  });
}

/**
 * Decides what to put in a note's `transcript` push field.
 *
 * When local segments/speakers are dirty, mobile is authoritative → serialize
 * them and report the row ids so pendingSync can be cleared on success. When
 * clean, `onCreate` echoes the stored raw (batch-create has no COALESCE, so
 * omitting would null the server copy on go-public re-create); update omits the
 * key entirely so the server's COALESCE keeps its possibly-richer transcript.
 */
function transcriptForPush(
  n: Note,
  onCreate: boolean,
): { field: string | undefined; pushed: PushedTranscript | null } {
  if (notesRepository.hasDirtyTranscript(n.id)) {
    const segments = notesRepository.getSegments(n.id);
    const speakers = notesRepository.getSpeakers(n.id);
    const raw = serializeSegmentsForSync(segments, speakers, n.transcript);
    return {
      field: raw,
      pushed: { raw, segmentIds: segments.map((s) => s.id), speakerIds: speakers.map((s) => s.id) },
    };
  }
  return { field: onCreate ? (n.transcript ?? undefined) : undefined, pushed: null };
}

/**
 * Whether the row still holds unpushed work, which is what space-access
 * recovery keys off. getPendingNotes admits a row for either reason, and a note
 * whose only unpushed work is an edited transcript still has work worth
 * forking. `pushed` is non-null exactly when hasDirtyTranscript(n.id) was true,
 * so this reuses the query transcriptForPush already ran.
 */
function isDirtyForPush(n: Note, transcript: { pushed: PushedTranscript | null }): boolean {
  return n.pendingSync === 1 || transcript.pushed !== null;
}

function assertNotPrivate(n: Note): boolean {
  if (n.isPrivate === 1) {
    Sentry.captureMessage(`pushNotes: blocked private note id=${n.id}`, 'fatal');
    return false;
  }
  return true;
}

function serverFolderId(localFolderId: number | null): string | null {
  if (localFolderId == null) return null;
  const folder = notesRepository.getFolders().find((f) => f.id === localFolderId);
  return folder?.remoteId ?? null;
}

function calendarContextPayload(
  n: Note,
): Pick<NotePushInput, 'participants' | 'calendar_event_id'> {
  if (n.isPrivate === 1) return {};
  // Nulls are valid for creates. The current API update path treats null as "leave unchanged",
  // so a future detach-event UI also needs server support for explicit clears.
  return {
    participants: n.participants,
    calendar_event_id: n.calendarEventId,
  };
}

function fallbackUpdatedAt(n: Note): string {
  return n.updatedAt ?? n.createdAt ?? new Date().toISOString();
}

// `teamOnly` restricts the push to rows whose local space is `kind === 'team'`
// (see createTeamSpaceFilter) — used by the team-only sync pass in
// syncEngine.ts when the personal paygate is closed. Default false pushes
// every pending row exactly as before.
function isStillUploadable(pushed: Note): boolean {
  const current = notesRepository.getNoteById(pushed.id);
  return (
    !!current &&
    current.isPrivate !== 1 &&
    !current.deletedAt &&
    current.clientNoteId === pushed.clientNoteId
  );
}

export async function pushNotes(
  teamOnly = false,
  checkpoint: SyncCheckpoint = uncheckedSync,
): Promise<void> {
  checkpoint();
  let pending = notesRepository.getPendingNotes().filter(assertNotPrivate);
  if (teamOnly) {
    const isTeamRow = createTeamSpaceFilter();
    // A pending delete is exempt from the filter: DELETE carries no body, so
    // scope never applies to one (see the delete loop below), and full-mode
    // pushNotes() never filters deletes by space either — a delete must flow
    // the same way in both modes. This also covers a row whose space was
    // revoked earlier in this same run (syncSpaces soft-deletes it), which
    // would otherwise make isTeamRow stop recognizing a genuinely team-owned
    // delete and silently hold it forever.
    pending = pending.filter((n) => n.deletedAt != null || isTeamRow(n.spaceId));
  }
  if (pending.length === 0) return;

  // Creates are bucketed by the scope their payload carries, never mixed into
  // one queue: batch-create is all-or-nothing with no per-row detail, so a
  // chunk spanning two spaces would make a rejection from one of them
  // indistinguishable from a rejection of the other's rows (and of any
  // personal rows riding along). One bucket per scope keeps a space-access
  // error attributable to exactly the space whose rows were in flight.
  const createsByScope = new Map<string, NoteCreateRow[]>();
  const updates: (PushedNoteRow & {
    remoteId: string;
    payload: Omit<NotePushInput, 'client_note_id'>;
    pushedTranscript: PushedTranscript | null;
  })[] = [];
  const deletes: { localId: number; remoteId: string }[] = [];
  let failed = 0;
  let skippedPendingSpace = 0;

  // Read once per pass: the capability flag and the space rows can't change
  // mid-push. Rows queued for deletion never reach it — DELETE carries no
  // body, so scope does not apply to one.
  const resolveScope = createPushScopeResolver();

  for (const n of pending) {
    if (n.deletedAt) {
      if (n.remoteId) deletes.push({ localId: n.id, remoteId: n.remoteId });
      else notesRepository.hardDeleteNote(n.id);
      continue;
    }

    // A note's scope comes from its OWN space, never its folder's — the folder
    // may be soft-deleted, or (transiently) sit in a different space.
    const scope = resolveScope(n.spaceId);
    if (!scope) {
      // Its space isn't pushable right now: a team skeleton with no cloud id
      // yet, or a space this device just lost. Leave pendingSync set and try
      // again once the space resolves (or the team pull forks the row); this is
      // not a failure.
      skippedPendingSpace += 1;
      continue;
    }

    const folderId = serverFolderId(n.folderId);

    if (!n.remoteId) {
      if (!n.clientNoteId) {
        Sentry.captureMessage('pushNotes: missing clientNoteId', 'warning');
        continue;
      }
      const transcript = transcriptForPush(n, true);
      const create: NoteCreateRow = {
        localId: n.id,
        pushed: n,
        dirty: isDirtyForPush(n, transcript),
        fallbackUpdatedAt: fallbackUpdatedAt(n),
        pushedTranscript: transcript.pushed,
        payload: {
          client_note_id: n.clientNoteId,
          title: n.title,
          content: n.content,
          enhanced_content: n.enhancedContent,
          enhancement_prompt: n.enhancementPrompt,
          note_type: n.noteType ?? 'personal',
          // Local file:// paths (e.g. meeting WAVs) are device-local and meaningless cross-device, so
          // never sync them. Cross-device sourceFile handling is M6's concern.
          source_file: n.sourceFile?.startsWith('file://') ? null : n.sourceFile,
          audio_duration_seconds: n.audioDurationSeconds,
          folder_id: folderId,
          ...scope,
          ...calendarContextPayload(n),
          ...(transcript.field !== undefined ? { transcript: transcript.field } : {}),
          created_at: n.createdAt ?? undefined,
          // No updated_at: the server stamps its own clock. The local value is
          // the last edit, which can be hours old by the time the row uploads
          // (offline, unsubscribed onboarding, an account link re-creating
          // every row). Desktop's delta cursor is wall-clock, so a create
          // carrying that stale stamp lands behind the cursor and is never
          // pulled there.
        },
      };
      const scopeKey = scope.space_id ?? PERSONAL_SCOPE_KEY;
      const bucket = createsByScope.get(scopeKey);
      if (bucket) bucket.push(create);
      else createsByScope.set(scopeKey, [create]);
      continue;
    }

    const transcript = transcriptForPush(n, false);
    updates.push({
      localId: n.id,
      pushed: n,
      dirty: isDirtyForPush(n, transcript),
      remoteId: n.remoteId,
      pushedTranscript: transcript.pushed,
      payload: {
        title: n.title,
        content: n.content,
        enhanced_content: n.enhancedContent,
        enhancement_prompt: n.enhancementPrompt,
        folder_id: folderId,
        ...calendarContextPayload(n),
        ...(transcript.field !== undefined ? { transcript: transcript.field } : {}),
        updated_at: n.updatedAt ?? undefined,
        // base_updated_at is omitted (never null/empty) for rows created
        // before this feature — the server only 409s when the field is present
        // and mismatched. Scope rides along with it and only with it: a scope
        // claim is an assertion about where the row lives, which another
        // device may have changed since our last sync, so it must be
        // conditional on the same base. Unguarded, a queued local edit would
        // reverse a teammate's move. Without a base the keys are omitted
        // entirely, the server leaves the stored scope alone, and the local
        // move propagates on the next push once a pull re-seeds the base.
        ...(n.cloudUpdatedAt ? { ...scope, base_updated_at: n.cloudUpdatedAt } : {}),
      },
    });
  }

  if (skippedPendingSpace > 0) {
    Sentry.addBreadcrumb({
      category: 'sync',
      message: `pushNotes: skipped ${skippedPendingSpace} row(s) whose space is not pushable (no cloud id yet, or no longer resolvable)`,
      level: 'info',
    });
  }

  // One scope bucket at a time, chunked within the bucket (not a single
  // `if (creates.length > 0)` guard) so a >50-note first sync doesn't send one
  // oversized request — see PUSH_BATCH_SIZE above. Each chunk gets its own
  // try/catch, mirroring pushDictionary.ts / pushSnippets.ts: a thrown chunk
  // (terminal or retryable) does not abort the remaining chunks or buckets.
  for (const [scopeKey, scopedCreates] of createsByScope) {
    const personalScope = scopeKey === PERSONAL_SCOPE_KEY;
    for (let i = 0; i < scopedCreates.length; i += PUSH_BATCH_SIZE) {
      const chunk = scopedCreates
        .slice(i, i + PUSH_BATCH_SIZE)
        .filter((row) => isStillUploadable(row.pushed));
      if (chunk.length === 0) continue;
      try {
        checkpoint(true);
        recordNoteCreateAttempts(chunk.map((create) => create.payload.client_note_id));
        const created = await batchCreateNotes(chunk.map((c) => c.payload));
        checkpoint();
        const byClientId = new Map(
          created
            .filter((server) => server.client_note_id)
            .map((server) => [server.client_note_id as string, server]),
        );
        let unmatched = 0;
        for (let j = 0; j < chunk.length; j += 1) {
          const create = chunk[j];
          const server =
            byClientId.get(create.payload.client_note_id) ??
            (!created[j]?.client_note_id ? created[j] : undefined);
          if (!server?.id) {
            unmatched += 1;
            continue;
          }
          notesRepository.markNotePushed(
            create.pushed,
            server.id,
            // Local bookkeeping (updatedAt) can fall back to the local clock —
            // but the 4th arg (cloudUpdatedAt, the sync base) must not: pass
            // `null` explicitly rather than let it default to that same
            // fallback, or an older backend omitting updated_at here would seed
            // a base guaranteed to mismatch and false-409-park this row on its
            // very next edit.
            server.updated_at ?? create.fallbackUpdatedAt,
            server.updated_at ?? null,
          );
          forgetNoteCreateAttempts([create.payload.client_note_id]);
          if (create.pushedTranscript) {
            const { raw, segmentIds, speakerIds } = create.pushedTranscript;
            notesRepository.markTranscriptPushed(create.localId, raw, segmentIds, speakerIds);
          }
        }
        if (unmatched > 0) {
          Sentry.captureMessage(
            `pushNotes: ${unmatched}/${chunk.length} create rows had no matching server response`,
            'warning',
          );
        }
      } catch (e) {
        if (e instanceof SyncCancelledError) throw e;
        checkpoint();
        if (isPolicyCloudBackupBlocked(e)) throw e;
        let action = classifyPushError(e, 'create');
        // A chunk carries exactly one scope, so a space-access rejection maps
        // to that space and nothing else. A personal-scope chunk can still
        // draw one — batch-create also checks the SOURCE space of any existing
        // row a client_note_id matches, so a note the server already files in
        // a space we've lost trips it — but the target scope here is personal,
        // so forking would re-home rows on evidence about a space they are not
        // being pushed into. Retry instead and let the pull side (access
        // stub/fork) settle the row it actually concerns.
        if (action.type === 'spaceAccessLost' && personalScope) {
          Sentry.addBreadcrumb({
            category: 'sync',
            message:
              'pushNotes: personal-scope create chunk returned a space-access code; retrying instead of forking',
            level: 'warning',
          });
          action = { type: 'retry' };
        }
        // batch-create is all-or-nothing and the response carries no per-row
        // detail, so a terminal rejection settles every row in the chunk — the
        // same blast radius the 400 path has always had, now bounded to a
        // single scope. The loop keeps running either way, so later chunks and
        // buckets still get their turn.
        if (action.type === 'terminal') {
          for (const c of chunk) notesRepository.markNoteTerminal(c.localId);
          Sentry.addBreadcrumb({
            category: 'sync',
            message: `pushNotes: ${chunk.length} create row(s) permanently rejected (400); giving up`,
            level: 'warning',
          });
        } else if (action.type === 'spaceAccessLost') {
          recoverSpaceAccessLost(chunk, 'create');
        } else if (action.type === 'permissionDenied') {
          recoverPermissionDenied(chunk, 'create');
        } else {
          failed += 1;
          Sentry.captureException(e, { tags: { sync: 'pushNotes.create' } });
        }
      }
    }
  }

  for (const u of updates) {
    if (!isStillUploadable(u.pushed)) continue;
    try {
      checkpoint(true);
      const server = await updateNote(u.remoteId, u.payload);
      checkpoint();
      notesRepository.markNotePushed(u.pushed, server.id, server.updated_at);
      if (u.pushedTranscript) {
        const { raw, segmentIds, speakerIds } = u.pushedTranscript;
        notesRepository.markTranscriptPushed(u.localId, raw, segmentIds, speakerIds);
      }
    } catch (e) {
      if (e instanceof SyncCancelledError) throw e;
      checkpoint();
      if (isPolicyCloudBackupBlocked(e)) throw e;
      const conflictNote = noteVersionConflictServerNote(e);
      if (conflictNote) {
        // Park it: keep the local edit queued (pendingSync untouched) and stash
        // the server's copy for a future Keep-mine/Use-server banner (Task 10),
        // instead of retrying the same stale base_updated_at forever. Counted
        // separately from `failed` — this is an expected, handled outcome.
        notesRepository.parkNoteConflict(u.localId, conflictNote);
        Sentry.addBreadcrumb({
          category: 'sync',
          message: `pushNotes: update for note ${u.localId} parked as a version conflict (409)`,
          level: 'warning',
        });
        continue;
      }
      const action = classifyPushError(e, 'update');
      if (action.type === 'terminal') {
        notesRepository.markNoteTerminal(u.localId);
        Sentry.addBreadcrumb({
          category: 'sync',
          message: `pushNotes: update for note ${u.localId} permanently rejected (400); giving up`,
          level: 'warning',
        });
      } else if (action.type === 'spaceAccessLost') {
        recoverSpaceAccessLost([u], 'update');
      } else if (action.type === 'permissionDenied') {
        recoverPermissionDenied([u], 'update');
      } else if (action.type === 'resetRemoteId') {
        // Target row was tombstoned/purged on the server. Clear the stale
        // remoteId so the next push re-creates instead of retrying the 404.
        notesRepository.clearNoteRemoteId(u.localId);
        Sentry.captureException(e, { tags: { sync: 'pushNotes.update.404' } });
      } else {
        failed += 1;
        Sentry.captureException(e, { tags: { sync: 'pushNotes.update' } });
      }
    }
  }

  for (const d of deletes) {
    try {
      checkpoint(true);
      await deleteNote(d.remoteId);
      checkpoint();
      notesRepository.hardDeleteNote(d.localId);
    } catch (e) {
      if (e instanceof SyncCancelledError) throw e;
      checkpoint();
      if (isPolicyCloudBackupBlocked(e)) throw e;
      failed += 1;
      Sentry.captureException(e, { tags: { sync: 'pushNotes.delete' } });
    }
  }

  if (failed > 0) {
    throw new Error(`pushNotes: ${failed} operation(s) failed`);
  }
}
