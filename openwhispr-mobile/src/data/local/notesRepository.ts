import { isManagedMeetingAudioUri } from '@/lib/transcriptAudio';
import {
  eq,
  ne,
  like,
  and,
  or,
  asc,
  desc,
  sql,
  count,
  isNotNull,
  isNull,
  inArray,
} from 'drizzle-orm';
import * as FileSystem from 'expo-file-system/legacy';
import { parseRemoteTranscript, serializeSegmentsForSync } from '@/lib/notes/remoteTranscript';
import { randomUUID } from '@/lib/uuid';
import {
  folderDeleteJournal,
  folders,
  notes,
  actions,
  syncState,
  dictionaryEntries,
  snippets,
  transcriptSegments,
  speakers,
  speakerProfiles,
  spaces,
} from '@/db/schema';
import { isTranscriptionStatus } from '@/lib/diarization/diarizer';
import {
  decodeEmbedding,
  encodeEmbedding,
  validateEmbedding,
} from '@/lib/diarization/embeddingCodec';
import type { TranscriptionStatus } from '@/lib/diarization/diarizer';
import type {
  NotesRepository,
  Note,
  Folder,
  Action,
  NoteUpdate,
  ActionUpdate,
  MeetingNoteUpdate,
  MeetingCalendarContextUpdate,
  ApplyRemoteOptions,
  ApplyRemoteNoteOptions,
  RemoteFolder,
  RemoteNote,
  ConflictedNote,
  Segment,
  NewSegment,
  Speaker,
  NewSpeaker,
  SpeakerProfile,
  SpeakerProfileRow,
  NewSpeakerProfile,
  SpeakerProfileOwnerFlag,
} from '../types';

type NotesDb = typeof import('@/db').db;
type SpeakerProfileDbEmbedding = typeof speakerProfiles.$inferInsert.embedding;

export const SPEAKER_PROFILE_OWNER_ALREADY_EXISTS_CODE =
  'SPEAKER_PROFILE_OWNER_ALREADY_EXISTS' as const;

export class SpeakerProfileOwnerAlreadyExistsError extends Error {
  readonly code = SPEAKER_PROFILE_OWNER_ALREADY_EXISTS_CODE;
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    super('An owner speaker profile already exists');
    this.name = 'SpeakerProfileOwnerAlreadyExistsError';
    this.cause = cause;
  }
}

export function isSpeakerProfileOwnerConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const isConstraint =
    code.startsWith('SQLITE_CONSTRAINT') ||
    message.includes('UNIQUE constraint failed') ||
    message.includes('constraint failed');
  return isConstraint && message.includes('speaker_profiles') && message.includes('is_owner');
}

export function mapSpeakerProfileOwnerConstraint(error: unknown): never {
  if (isSpeakerProfileOwnerConstraintError(error)) {
    throw new SpeakerProfileOwnerAlreadyExistsError(error);
  }
  throw error;
}

const parseSpeakerProfileOwnerFlag = (value: number): SpeakerProfileOwnerFlag => {
  if (value === 0 || value === 1) return value;
  throw new Error('Speaker profile isOwner must be 0 or 1');
};

const validateSpeakerProfileOwnerFlag = (value: number | undefined): void => {
  if (value === undefined) return;
  parseSpeakerProfileOwnerFlag(value);
};

const encodeSpeakerProfileEmbedding = (values: number[]): SpeakerProfileDbEmbedding =>
  encodeEmbedding(values) as unknown as SpeakerProfileDbEmbedding;

const getDefaultDb = (): NotesDb => {
  const { db } = require('@/db') as typeof import('@/db');
  return db;
};

// The columns pushNotes.ts serializes, plus the ones whose change re-queues the
// row (scope, privacy, a soft delete): a push acknowledgement settles the row
// only while every one of them still reads as it did when the payload was built.
const NOTE_PUSH_ACK_FIELDS: ReadonlyArray<keyof Note> = [
  'title',
  'content',
  'enhancedContent',
  'enhancementPrompt',
  'noteType',
  'sourceFile',
  'audioDurationSeconds',
  'folderId',
  'spaceId',
  'isPrivate',
  'participants',
  'calendarEventId',
  'deletedAt',
];

export class LocalNotesRepository implements NotesRepository {
  private readonly database: NotesDb;

  constructor(database?: NotesDb) {
    this.database = database ?? getDefaultDb();
  }

  private mapSpeakerProfile(row: SpeakerProfileRow): SpeakerProfile {
    return {
      ...row,
      isOwner: parseSpeakerProfileOwnerFlag(row.isOwner),
      embedding: decodeEmbedding(row.embedding),
    };
  }

  private getExpectedEmbeddingDimension(profileId?: number): number | undefined {
    // Speaker profiles currently share one FluidAudio embedding space. If a future
    // diarizer model changes dimensions, add a model/version key before relaxing
    // this cross-profile guard so legacy and new profiles are never matched together.
    const rows = this.database
      .select({ id: speakerProfiles.id, embedding: speakerProfiles.embedding })
      .from(speakerProfiles)
      .all();
    const reference =
      rows.find((row) => row.id !== profileId) ?? rows.find((row) => row.id === profileId);
    return reference ? decodeEmbedding(reference.embedding).length : undefined;
  }

  private validateSpeakerProfileEmbedding(values: number[], profileId?: number): void {
    validateEmbedding(values, this.getExpectedEmbeddingDimension(profileId));
  }

  // New locally-created notes/folders default into the device's private space.
  // The migration guarantees exactly one 'private' space exists.
  private getPrivateSpaceId(): number {
    const row = this.database
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.kind, 'private'))
      .get();
    if (!row) {
      throw new Error('Private space not found — the migration should have seeded it');
    }
    return row.id;
  }

  getFolders(): Folder[] {
    return this.database
      .select()
      .from(folders)
      .where(isNull(folders.deletedAt))
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .all();
  }

  getFoldersIncludingDeleted(): Folder[] {
    return this.database
      .select()
      .from(folders)
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .all();
  }

  getPrivateFolders(): Folder[] {
    return this.getFoldersBySpace(this.getPrivateSpaceId());
  }

  getFoldersBySpace(spaceId: number): Folder[] {
    return this.database
      .select()
      .from(folders)
      .where(and(eq(folders.spaceId, spaceId), isNull(folders.deletedAt)))
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .all();
  }

  getFolderCounts(): Record<number, number> {
    const rows = this.database
      .select({ folderId: notes.folderId, count: count() })
      .from(notes)
      .where(and(isNotNull(notes.folderId), isNull(notes.deletedAt)))
      .groupBy(notes.folderId)
      .all();
    return Object.fromEntries(rows.map((r) => [r.folderId!, r.count]));
  }

  createFolder(name: string, spaceId?: number): Folder {
    return this.database
      .insert(folders)
      .values({
        name,
        spaceId: spaceId ?? this.getPrivateSpaceId(),
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .returning()
      .get();
  }

  renameFolder(id: number, name: string): void {
    this.database
      .update(folders)
      .set({ name, pendingSync: 1, updatedAt: sql`datetime('now')` })
      .where(eq(folders.id, id))
      .run();
  }

  deleteFolder(id: number): void {
    this.database
      .update(folders)
      .set({
        deletedAt: sql`datetime('now')`,
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(folders.id, id))
      .run();
  }

  getNotesByFolder(folderId: number): Note[] {
    return this.database
      .select()
      .from(notes)
      .where(and(eq(notes.folderId, folderId), isNull(notes.deletedAt)))
      .orderBy(desc(notes.updatedAt))
      .all();
  }

  getNotesBySpace(spaceId: number): Note[] {
    return this.database
      .select()
      .from(notes)
      .where(and(eq(notes.spaceId, spaceId), isNull(notes.deletedAt)))
      .orderBy(desc(notes.updatedAt))
      .all();
  }

  getSpaceNotesWithoutFolder(spaceId: number): Note[] {
    return this.database
      .select()
      .from(notes)
      .where(and(eq(notes.spaceId, spaceId), isNull(notes.folderId), isNull(notes.deletedAt)))
      .orderBy(desc(notes.updatedAt))
      .all();
  }

  getAllNotes(): Note[] {
    return this.database
      .select()
      .from(notes)
      .where(isNull(notes.deletedAt))
      .orderBy(desc(notes.updatedAt))
      .all();
  }

  getNoteById(id: number): Note | null {
    return this.database.select().from(notes).where(eq(notes.id, id)).get() ?? null;
  }

  createNote(title: string, content: string, folderId?: number, spaceId?: number): Note {
    // Created straight into a space (browsing it with no folder open): the note
    // sits in the space itself rather than in any folder.
    const targetFolderId = spaceId != null ? null : (folderId ?? 1);
    return this.database
      .insert(notes)
      .values({
        title,
        content,
        folderId: targetFolderId,
        // A note always belongs to whatever space holds its folder — filing a
        // team folder's note into the private space would strand it.
        spaceId:
          targetFolderId != null
            ? (this.getFolderSpaceId(targetFolderId) ?? this.getPrivateSpaceId())
            : (spaceId ?? this.getPrivateSpaceId()),
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .returning()
      .get();
  }

  /**
   * Deletes a folder the way the server will. `deleteFolder` on the API tombstones every note
   * still inside the folder, so the client applies that same cascade instead of re-homing the
   * notes into a folder the server knows nothing about.
   *
   * The folder and each cascaded note are journaled first with their prior state, then held:
   * excluded from the note push queue (getPendingNotes) and skipped by every pull
   * (isRemoteNoteHeldByFolderDelete), so nothing races the server's verdict. pushFolders then
   * calls finalizeFolderDelete or revertFolderDelete once it knows.
   */
  deleteFolderCascade(folderId: number): void {
    const folder = this.database.select().from(folders).where(eq(folders.id, folderId)).get();
    // Already tombstoned means a cascade is in flight (or finished): journaling
    // it twice would collide on idx_folder_delete_journal_entity.
    if (!folder || folder.deletedAt != null) return;

    const children = this.database
      .select()
      .from(notes)
      .where(and(eq(notes.folderId, folderId), isNull(notes.deletedAt)))
      .all();

    this.database
      .insert(folderDeleteJournal)
      .values([
        {
          folderId,
          entityType: 'folder' as const,
          entityId: folder.id,
          originalDeletedAt: folder.deletedAt,
          originalPendingSync: folder.pendingSync,
          originalUpdatedAt: folder.updatedAt,
        },
        ...children.map((note) => ({
          folderId,
          entityType: 'note' as const,
          entityId: note.id,
          originalDeletedAt: note.deletedAt,
          originalPendingSync: note.pendingSync,
          originalUpdatedAt: note.updatedAt,
        })),
      ])
      .run();

    if (children.length > 0) {
      // pendingSync is cleared as well as the tombstone written: an individual
      // push for one of these would 404 against the row the server's cascade
      // already tombstoned, and burn its remoteId doing so.
      this.database
        .update(notes)
        .set({
          deletedAt: sql`datetime('now')`,
          pendingSync: 0,
          updatedAt: sql`datetime('now')`,
        })
        .where(
          inArray(
            notes.id,
            children.map((note) => note.id),
          ),
        )
        .run();
    }

    this.database
      .update(folders)
      .set({
        deletedAt: sql`datetime('now')`,
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(folders.id, folderId))
      .run();
  }

  /** True while a pending folder delete owns this note — see deleteFolderCascade. */
  isRemoteNoteHeldByFolderDelete(remote: Pick<RemoteNote, 'id' | 'client_note_id'>): boolean {
    const local = this.getNoteForRemote(remote);
    return local != null && this.isNoteHeldByFolderDelete(local.id);
  }

  /** The server accepted the delete: drop the folder and its cascaded notes for good. */
  finalizeFolderDelete(folderId: number): void {
    for (const noteId of this.journaledNoteIds(folderId)) this.hardDeleteNote(noteId);
    this.clearFolderDeleteJournal(folderId);
    this.hardDeleteFolder(folderId);
  }

  /** The server refused the delete: put every row this cascade touched back as it was. */
  revertFolderDelete(folderId: number): void {
    const rows = this.database
      .select()
      .from(folderDeleteJournal)
      .where(eq(folderDeleteJournal.folderId, folderId))
      .all();

    for (const row of rows) {
      const restored = {
        deletedAt: row.originalDeletedAt,
        pendingSync: row.originalPendingSync,
        updatedAt: row.originalUpdatedAt,
      };
      if (row.entityType === 'folder') {
        this.database.update(folders).set(restored).where(eq(folders.id, row.entityId)).run();
      } else {
        this.database.update(notes).set(restored).where(eq(notes.id, row.entityId)).run();
      }
    }
    this.clearFolderDeleteJournal(folderId);
  }

  private isNoteHeldByFolderDelete(noteId: number): boolean {
    return (
      this.database
        .select({ id: folderDeleteJournal.id })
        .from(folderDeleteJournal)
        .where(
          and(eq(folderDeleteJournal.entityType, 'note'), eq(folderDeleteJournal.entityId, noteId)),
        )
        .get() != null
    );
  }

  private journaledNoteIds(folderId: number): number[] {
    return this.database
      .select({ entityId: folderDeleteJournal.entityId })
      .from(folderDeleteJournal)
      .where(
        and(eq(folderDeleteJournal.folderId, folderId), eq(folderDeleteJournal.entityType, 'note')),
      )
      .all()
      .map((row) => row.entityId);
  }

  private clearFolderDeleteJournal(folderId: number): void {
    this.database
      .delete(folderDeleteJournal)
      .where(eq(folderDeleteJournal.folderId, folderId))
      .run();
  }

  private getFolderSpaceId(folderId: number): number | null {
    return (
      this.database
        .select({ spaceId: folders.spaceId })
        .from(folders)
        .where(eq(folders.id, folderId))
        .get()?.spaceId ?? null
    );
  }

  updateNote(id: number, updates: NoteUpdate): void {
    this.database
      .update(notes)
      .set({ ...updates, pendingSync: 1, updatedAt: sql`datetime('now')` })
      .where(eq(notes.id, id))
      .run();
  }

  // FK cascade is inert (no PRAGMA foreign_keys=ON), so child diarization rows and the persisted
  // meeting WAV must be removed explicitly on EVERY delete path (soft delete, hard delete,
  // remote-delete apply, and full wipe) — otherwise they orphan in the DB and on disk.
  private deleteNoteChildrenAndAudio(id: number): void {
    const row = this.database
      .select({ sourceFile: notes.sourceFile })
      .from(notes)
      .where(eq(notes.id, id))
      .get();
    if (row?.sourceFile && isManagedMeetingAudioUri(id, row.sourceFile)) {
      FileSystem.deleteAsync(row.sourceFile, { idempotent: true }).catch(() => {});
    }
    this.database.delete(transcriptSegments).where(eq(transcriptSegments.noteId, id)).run();
    this.database.delete(speakers).where(eq(speakers.noteId, id)).run();
  }

  deleteNote(id: number): void {
    this.deleteNoteChildrenAndAudio(id);
    // Soft-delete the note row. Explicit user intent (delete) supersedes any
    // parked conflict — clear conflictServerNote too, otherwise getPendingNotes
    // would keep excluding this row and the delete would never push, silently
    // wedging the note in a soft-deleted-but-never-synced local limbo forever.
    this.database
      .update(notes)
      .set({
        deletedAt: sql`datetime('now')`,
        pendingSync: 1,
        conflictServerNote: null,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(notes.id, id))
      .run();
  }

  moveNoteToFolder(noteId: number, folderId: number): void {
    this.database
      .update(notes)
      .set({ folderId, pendingSync: 1, updatedAt: sql`datetime('now')` })
      .where(eq(notes.id, noteId))
      .run();
  }

  moveNotesToFolder(fromFolderId: number, toFolderId: number): void {
    this.database
      .update(notes)
      .set({ folderId: toFolderId, pendingSync: 1, updatedAt: sql`datetime('now')` })
      .where(eq(notes.folderId, fromFolderId))
      .run();
  }

  moveNoteToSpace(noteId: number, spaceId: number): void {
    // A folder from the old space is never valid in the new one (including moving back to
    // Personal) — see MoveToFolderSheet, which hides the folder picker in this flow entirely.
    //
    // Deliberately does NOT clear conflict_server_note, unlike deleteNote/setNotePrivacy. Those
    // clear it safely because neither one needs a content PATCH against the row's existing
    // server identity: delete carries no body to conflict on, and setNotePrivacy severs/reissues
    // the identity entirely (a fresh create under a new client_note_id, not a PATCH against the
    // old base). A space move is still a PATCH against the SAME identity/base_updated_at — if the
    // park were cleared here, the next push would carry the move using the stale pre-conflict
    // base, draw another 409 from the server, and get re-parked right back: a futile
    // clear-then-re-park cycle. So the row stays excluded from getPendingNotes (the move is
    // queued via pendingSync but genuinely un-pushable) until the user resolves the conflict —
    // resolveConflictKeepMine rebases onto the server's stored updated_at and the queued move
    // rides along on the next push; resolveConflictUseServer discards the local row's pending
    // state (including this move) in favor of the server's copy. No separate signal is needed
    // here: the conflict banner is already visible on this exact note in the editor.
    this.database
      .update(notes)
      .set({ spaceId, folderId: null, pendingSync: 1, updatedAt: sql`datetime('now')` })
      .where(eq(notes.id, noteId))
      .run();
  }

  searchNotes(query: string, folderId?: number): Note[] {
    const pattern = `%${query}%`;
    const textMatch = or(like(notes.title, pattern), like(notes.content, pattern));
    const notDeleted = isNull(notes.deletedAt);
    const condition = folderId
      ? and(textMatch, eq(notes.folderId, folderId), notDeleted)
      : and(textMatch, notDeleted);
    return this.database.select().from(notes).where(condition).orderBy(desc(notes.updatedAt)).all();
  }

  getActions(): Action[] {
    return this.database
      .select()
      .from(actions)
      .orderBy(asc(actions.sortOrder), asc(actions.name))
      .all();
  }

  getActionById(id: number): Action | null {
    return this.database.select().from(actions).where(eq(actions.id, id)).get() ?? null;
  }

  createAction(name: string, description: string, prompt: string): Action {
    return this.database.insert(actions).values({ name, description, prompt }).returning().get();
  }

  updateAction(id: number, updates: ActionUpdate): void {
    this.database
      .update(actions)
      .set({ ...updates, updatedAt: sql`datetime('now')` })
      .where(eq(actions.id, id))
      .run();
  }

  deleteAction(id: number): void {
    this.database
      .delete(actions)
      .where(and(eq(actions.id, id), eq(actions.isDefault, 0)))
      .run();
  }

  // Sync helpers

  getPendingFolders(): Folder[] {
    return this.database.select().from(folders).where(eq(folders.pendingSync, 1)).all();
  }

  getPrivateNotesPendingDeletion(): Note[] {
    return this.database
      .select()
      .from(notes)
      .where(
        and(eq(notes.isPrivate, 1), or(isNotNull(notes.remoteId), isNotNull(notes.clientNoteId))),
      )
      .all();
  }

  getPendingNotes(): Note[] {
    const hasDirtySegment = sql`EXISTS (
      SELECT 1 FROM ${transcriptSegments}
      WHERE ${transcriptSegments.noteId} = ${notes.id}
        AND ${transcriptSegments.pendingSync} = 1
        AND ${transcriptSegments.deletedAt} IS NULL
    )`;
    const hasDirtySpeaker = sql`EXISTS (
      SELECT 1 FROM ${speakers}
      WHERE ${speakers.noteId} = ${notes.id}
        AND ${speakers.pendingSync} = 1
        AND ${speakers.deletedAt} IS NULL
    )`;

    return (
      this.database
        .select()
        .from(notes)
        // A row parked with a conflict (see parkNoteConflict) stays out of the
        // push queue entirely until resolveConflictKeepMine/UseServer clears it —
        // otherwise pushNotes would retry the same stale base_updated_at forever.
        .where(
          and(
            isNull(notes.conflictServerNote),
            // A note cascaded by an in-flight folder delete is owned by that
            // operation until the server rules on it (see deleteFolderCascade).
            sql`NOT EXISTS (
            SELECT 1 FROM ${folderDeleteJournal}
            WHERE ${folderDeleteJournal.entityType} = 'note'
              AND ${folderDeleteJournal.entityId} = ${notes.id}
          )`,
            or(
              eq(notes.pendingSync, 1),
              and(eq(notes.isPrivate, 0), or(hasDirtySegment, hasDirtySpeaker)),
            ),
          ),
        )
        .all()
    );
  }

  applyRemoteFolder(remote: RemoteFolder, options: ApplyRemoteOptions = {}): void {
    const matchCondition = remote.client_folder_id
      ? or(eq(folders.clientFolderId, remote.client_folder_id), eq(folders.remoteId, remote.id))
      : eq(folders.remoteId, remote.id);
    const local = this.database.select().from(folders).where(matchCondition).get();

    // Server-deleted row we've never seen locally → nothing to do.
    if (!local && remote.deleted_at) return;

    if (!local) {
      this.database
        .insert(folders)
        .values({
          name: remote.name,
          isDefault: remote.is_default ? 1 : 0,
          sortOrder: remote.sort_order,
          clientFolderId: remote.client_folder_id,
          remoteId: remote.id,
          deletedAt: remote.deleted_at,
          pendingSync: 0,
          // Never leave space_id NULL: the personal pass owns the private
          // space, the team pass passes the space it resolved.
          spaceId: options.spaceId ?? this.getPrivateSpaceId(),
          updatedAt: remote.updated_at,
        })
        .run();
      return;
    }

    if (local.pendingSync === 1) return;

    if (remote.deleted_at) {
      this.database.delete(folders).where(eq(folders.id, local.id)).run();
      return;
    }

    this.database
      .update(folders)
      .set({
        name: remote.name,
        isDefault: remote.is_default ? 1 : 0,
        sortOrder: remote.sort_order,
        clientFolderId: remote.client_folder_id ?? local.clientFolderId,
        remoteId: remote.id,
        deletedAt: null,
        pendingSync: 0,
        // Only the team pass relocates an existing folder; without an explicit
        // space the row keeps whatever space it already sits in.
        ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
        updatedAt: remote.updated_at,
      })
      .where(eq(folders.id, local.id))
      .run();
  }

  getNoteForRemote(remote: Pick<RemoteNote, 'id' | 'client_note_id'>): Note | null {
    const matchCondition = remote.client_note_id
      ? or(eq(notes.clientNoteId, remote.client_note_id), eq(notes.remoteId, remote.id))
      : eq(notes.remoteId, remote.id);
    return this.database.select().from(notes).where(matchCondition).get() ?? null;
  }

  // Cloud ownership columns are populated only by the team pass (scope=all
  // rows carry them). Each field is written only when the remote row actually
  // supplies it, so a response that omits one never clears what we already know.
  private remoteOwnershipValues(
    remote: RemoteNote,
    applyOwnership: boolean | undefined,
  ): { ownerUserId?: string | null; updatedByUserId?: string | null } {
    if (!applyOwnership) return {};
    return {
      ...(remote.user_id !== undefined ? { ownerUserId: remote.user_id } : {}),
      ...(remote.updated_by_user_id !== undefined
        ? { updatedByUserId: remote.updated_by_user_id }
        : {}),
    };
  }

  forkNoteToPrivate(noteId: number): void {
    // A brand-new personal identity: the old server row is no longer ours, so
    // dropping remote_id/cloud_updated_at plus minting a new client_note_id
    // makes the next push re-create this note instead of retrying a write the
    // server would reject. left_team/conflict_server_note are cleared because
    // both are claims against the identity we just discarded.
    this.database
      .update(notes)
      .set({
        spaceId: this.getPrivateSpaceId(),
        folderId: null,
        clientNoteId: randomUUID(),
        remoteId: null,
        cloudUpdatedAt: null,
        ownerUserId: null,
        updatedByUserId: null,
        leftTeam: 0,
        conflictServerNote: null,
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(notes.id, noteId))
      .run();
  }

  applyRemoteNote(
    remote: RemoteNote,
    resolveFolder: (serverFolderId: string | null) => number | null,
    options: ApplyRemoteNoteOptions = {},
  ): void {
    const local = this.getNoteForRemote(remote);
    // A parent folder delete owns this note until its server result is known:
    // applying a tombstone or a newer remote row here would race finalize/revert.
    if (local && this.isNoteHeldByFolderDelete(local.id)) return;

    // Server-deleted row we've never seen locally → nothing to do.
    if (!local && remote.deleted_at) return;

    // Locally-private row: server has no authority over this note. Most
    // common case: we just deleted the cloud copy on going-private, and the
    // pull is now bringing back the tombstone — which would hard-delete the
    // local row if we let it. Skip.
    if (local?.isPrivate === 1) {
      if (remote.access_removed) return;
      if (remote.deleted_at) {
        this.database
          .update(notes)
          .set({ remoteId: null, clientNoteId: null, cloudUpdatedAt: null })
          .where(eq(notes.id, local.id))
          .run();
        return;
      }
      // A create can reach the server even if its response was lost before the
      // privacy toggle. Recover its identity for deletion without importing content.
      if (!local.remoteId) {
        this.database
          .update(notes)
          .set({ remoteId: remote.id })
          .where(eq(notes.id, local.id))
          .run();
      }
      return;
    }

    // Row parked in conflict (see parkNoteConflict): never implicitly clear it —
    // that's resolveConflictKeepMine/UseServer's job. But if the server has
    // moved on since the conflict was recorded, refresh the stashed copy so a
    // future banner always offers the latest server version.
    if (local?.conflictServerNote != null) {
      const stored = this.parseStoredConflictNote(local.conflictServerNote);
      if (!stored || stored.updated_at !== remote.updated_at) {
        this.database
          .update(notes)
          .set({ conflictServerNote: JSON.stringify(remote) })
          .where(eq(notes.id, local.id))
          .run();
      }
      return;
    }

    const localFolderId = resolveFolder(remote.folder_id);

    if (!local) {
      const inserted = this.database
        .insert(notes)
        .values({
          title: remote.title ?? 'Untitled',
          content: remote.content,
          folderId: localFolderId,
          noteType: remote.note_type,
          sourceFile: remote.source_file,
          audioDurationSeconds: remote.audio_duration_seconds,
          calendarEventId: remote.calendar_event_id ?? null,
          participants: remote.participants ?? null,
          enhancedContent: remote.enhanced_content,
          enhancementPrompt: remote.enhancement_prompt,
          clientNoteId: remote.client_note_id,
          remoteId: remote.id,
          deletedAt: remote.deleted_at,
          pendingSync: 0,
          isPrivate: 0,
          // Never leave space_id NULL: the personal pass owns the private
          // space, the team pass passes the space it resolved.
          spaceId: options.spaceId ?? this.getPrivateSpaceId(),
          ...this.remoteOwnershipValues(remote, options.applyOwnership),
          cloudUpdatedAt: remote.updated_at,
          updatedAt: remote.updated_at,
        })
        .returning()
        .get();
      if (remote.transcript != null) {
        this.applyRemoteTranscript(inserted.id, remote.transcript);
      }
      return;
    }

    // Pending local change → skip apply. Preserves local delete vs remote edit.
    if (local.pendingSync === 1) return;

    if (remote.deleted_at) {
      this.deleteNoteChildrenAndAudio(local.id);
      this.database.delete(notes).where(eq(notes.id, local.id)).run();
      return;
    }

    this.applyRemoteNoteToExisting(local, remote, localFolderId, options);
  }

  // Shared by applyRemoteNote's normal update path and resolveConflictUseServer
  // (which bypasses the pendingSync guard above by calling this directly).
  // Always clears conflictServerNote: on the normal path it's already null
  // (the guard above returns early otherwise), so this is a no-op there.
  private applyRemoteNoteToExisting(
    local: Note,
    remote: RemoteNote,
    localFolderId: number | null,
    options: ApplyRemoteNoteOptions & { forceTranscript?: boolean } = {},
  ): void {
    this.database
      .update(notes)
      .set({
        title: remote.title ?? 'Untitled',
        content: remote.content,
        folderId: localFolderId,
        noteType: remote.note_type,
        sourceFile: remote.source_file,
        audioDurationSeconds: remote.audio_duration_seconds,
        calendarEventId: remote.calendar_event_id ?? null,
        participants: remote.participants ?? null,
        enhancedContent: remote.enhanced_content,
        enhancementPrompt: remote.enhancement_prompt,
        clientNoteId: remote.client_note_id ?? local.clientNoteId,
        remoteId: remote.id,
        deletedAt: null,
        pendingSync: 0,
        conflictServerNote: null,
        // Only the team pass relocates an existing note; without an explicit
        // space the row keeps whatever space it already sits in.
        ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
        ...this.remoteOwnershipValues(remote, options.applyOwnership),
        cloudUpdatedAt: remote.updated_at,
        updatedAt: remote.updated_at,
      })
      .where(eq(notes.id, local.id))
      .run();

    // Rebuild the transcript when the server sent a different one. Normally
    // gated on !hasDirtyTranscript (un-pushed local edits are authoritative
    // during an ordinary pull) — options.forceTranscript (resolveConflictUseServer
    // only) bypasses that: the user explicitly chose the server's copy, so a
    // dirty local transcript must not survive to silently re-push over it.
    const transcriptChanged = remote.transcript != null && remote.transcript !== local.transcript;
    const shouldRebuild =
      transcriptChanged && (options.forceTranscript || !this.hasDirtyTranscript(local.id));
    if (shouldRebuild) {
      this.applyRemoteTranscript(local.id, remote.transcript as string);
    } else if (options.forceTranscript) {
      // No rebuild happened (remote carries no transcript, or it already
      // matches local's), but there may still be locally-dirty segments/speakers
      // left over — clear them so they don't resurface in getPendingNotes and
      // push stale content over the server copy the user just chose.
      this.clearDirtyTranscriptRows(local.id);
    }
  }

  // Marks any pendingSync=1 segments/speakers for a note as clean without
  // touching their content — used by resolveConflictUseServer to make sure a
  // dirty local transcript doesn't resurface in getPendingNotes after the user
  // chose the server's copy (mirrors the pendingSync:0 outcome of a normal
  // applyRemoteTranscript rebuild, but without discarding/replacing rows when
  // there's no remote transcript to rebuild from).
  private clearDirtyTranscriptRows(noteId: number): void {
    this.database
      .update(transcriptSegments)
      .set({ pendingSync: 0 })
      .where(and(eq(transcriptSegments.noteId, noteId), eq(transcriptSegments.pendingSync, 1)))
      .run();
    this.database
      .update(speakers)
      .set({ pendingSync: 0 })
      .where(and(eq(speakers.noteId, noteId), eq(speakers.pendingSync, 1)))
      .run();
  }

  private parseStoredConflictNote(raw: string): RemoteNote | null {
    try {
      return JSON.parse(raw) as RemoteNote;
    } catch {
      return null;
    }
  }

  getFolderByRemoteId(remoteId: string): Folder | null {
    return this.database.select().from(folders).where(eq(folders.remoteId, remoteId)).get() ?? null;
  }

  private resolveFolderByRemoteId(serverFolderId: string | null): number | null {
    if (!serverFolderId) return null;
    return this.getFolderByRemoteId(serverFolderId)?.id ?? null;
  }

  markFolderPushed(
    localId: number,
    remoteId: string,
    serverUpdatedAt: string,
    pushed?: Folder,
  ): void {
    const current = this.database.select().from(folders).where(eq(folders.id, localId)).get();
    if (!current || (pushed && current.clientFolderId !== pushed.clientFolderId)) return;
    const unchanged =
      !pushed ||
      (['name', 'sortOrder', 'spaceId', 'deletedAt', 'updatedAt'] as const).every(
        (key) => current[key] === pushed[key],
      );
    this.database
      .update(folders)
      .set(unchanged ? { remoteId, pendingSync: 0, updatedAt: serverUpdatedAt } : { remoteId })
      .where(eq(folders.id, localId))
      .run();
  }

  markFolderTerminal(localId: number): void {
    // Stop re-attempting, but keep the local row exactly as the user left it
    // (mirrors markNoteTerminal). A later rename re-flags pendingSync.
    this.database.update(folders).set({ pendingSync: 0 }).where(eq(folders.id, localId)).run();
  }

  adoptDuplicateFolder(
    survivingLocalId: number,
    duplicateLocalId: number,
    remoteId: string,
    serverUpdatedAt: string,
  ): void {
    this.database.transaction((tx) => {
      // No pendingSync bump: both rows already resolve to the same server
      // folder once this transaction commits, so the note's remote folder_id
      // is unaffected — this only fixes up which LOCAL row it points at.
      tx.update(notes)
        .set({ folderId: survivingLocalId })
        .where(eq(notes.folderId, duplicateLocalId))
        .run();
      tx.update(folders)
        .set({ remoteId, pendingSync: 0, updatedAt: serverUpdatedAt })
        .where(eq(folders.id, survivingLocalId))
        .run();
      tx.delete(folders).where(eq(folders.id, duplicateLocalId)).run();
    });
  }

  // serverUpdatedAt drives local bookkeeping (`updatedAt`) and, by default,
  // also seeds/refreshes `cloudUpdatedAt` (the base echoed back as
  // base_updated_at on the next update). The two diverge for the batch-create
  // caller only: older backends (pre-2026-07-28) omit `updated_at` from the
  // create response, so pushNotes.ts falls back to a local-clock value for
  // `updatedAt` bookkeeping — but that local-clock value is NOT a real server
  // ack and must never become the sync base (it's guaranteed to mismatch the
  // server's real updated_at, false-409-parking the row on its very next
  // edit). That caller passes cloudUpdatedAt explicitly as `null` to opt out;
  // the PATCH-update caller always has a genuine RemoteNote.updated_at, so it
  // relies on the default (identical to today's behavior).
  markNotePushed(
    pushed: Note,
    remoteId: string,
    serverUpdatedAt: string,
    cloudUpdatedAt: string | null = serverUpdatedAt,
  ): void {
    const current = this.getNoteById(pushed.id);
    // Forked or re-identified while the request was in flight: the ack names
    // a server row this note no longer corresponds to.
    if (!current || current.clientNoteId !== pushed.clientNoteId) return;

    // The network request may have been in flight while the user edited or
    // deleted the note (mirrors markTranscriptPushed). Only settle the row when
    // what was serialized is still what is stored; otherwise keep it queued and
    // record the server revision so the follow-up push PATCHes the right base
    // instead of re-creating the note.
    const unchanged = NOTE_PUSH_ACK_FIELDS.every((field) => current[field] === pushed[field]);
    this.database
      .update(notes)
      .set(
        unchanged
          ? { remoteId, pendingSync: 0, updatedAt: serverUpdatedAt, cloudUpdatedAt }
          : { remoteId, cloudUpdatedAt },
      )
      .where(eq(notes.id, pushed.id))
      .run();
  }

  markNoteTerminal(localId: number): void {
    // Clear pendingSync so the row stops re-attempting; preserve the local state
    // so the user still sees their attempted change. They can edit it to fix and
    // retry — that will re-flag pending.
    this.database.update(notes).set({ pendingSync: 0 }).where(eq(notes.id, localId)).run();
  }

  dropNotePushAttempt(localId: number): void {
    // The server refused this write on permission grounds, so its own row is
    // whatever it was before — the next pull carries the truth. Clearing
    // cloud_updated_at alongside pendingSync means that pull re-seeds the sync
    // base instead of leaving a base this device can no longer trust.
    this.database
      .update(notes)
      .set({ pendingSync: 0, cloudUpdatedAt: null })
      .where(eq(notes.id, localId))
      .run();
  }

  parkNoteConflict(localId: number, serverNote: RemoteNote): void {
    // pendingSync is intentionally left untouched — the local edit stays
    // queued, but getPendingNotes excludes this row while conflictServerNote
    // is set, so pushNotes won't retry the stale base_updated_at.
    this.database
      .update(notes)
      .set({ conflictServerNote: JSON.stringify(serverNote) })
      .where(eq(notes.id, localId))
      .run();
  }

  listConflictedNotes(): ConflictedNote[] {
    const rows = this.database
      .select({ id: notes.id, title: notes.title, conflictServerNote: notes.conflictServerNote })
      .from(notes)
      // Explicit user intent (delete/go-private) always clears conflictServerNote
      // (see deleteNote/setNotePrivacy), but filter defensively too: a
      // soft-deleted or private row must never reach the future banner.
      .where(
        and(isNotNull(notes.conflictServerNote), isNull(notes.deletedAt), eq(notes.isPrivate, 0)),
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      // null when the stashed JSON fails to parse (should not happen — this
      // repository only ever writes its own JSON.stringify output — but stay
      // defensive). The row is still surfaced (rather than silently dropped)
      // so the banner can offer keep-mine, which clears the park with no
      // dependency on parseable data; see resolveConflictKeepMine.
      conflictServerNote: row.conflictServerNote
        ? this.parseStoredConflictNote(row.conflictServerNote)
        : null,
    }));
  }

  resolveConflictKeepMine(noteId: number): void {
    const row = this.database
      .select({ conflictServerNote: notes.conflictServerNote })
      .from(notes)
      .where(eq(notes.id, noteId))
      .get();
    if (!row?.conflictServerNote) return;
    const stored = this.parseStoredConflictNote(row.conflictServerNote);
    // Clear the park even when the stashed JSON is corrupt: keep-mine needs no
    // data from the copy (it just stops retrying with the old base). Without
    // this, a corrupt stash would permanently wedge the row — invisible to a
    // naive listConflictedNotes and forever excluded from getPendingNotes.
    // Adopting the server's updated_at as the new base is a no-op when there's
    // nothing to parse; cloudUpdatedAt is simply left as-is.
    this.database
      .update(notes)
      .set({
        conflictServerNote: null,
        pendingSync: 1,
        ...(stored ? { cloudUpdatedAt: stored.updated_at } : {}),
      })
      .where(eq(notes.id, noteId))
      .run();
  }

  resolveConflictUseServer(noteId: number): void {
    const local = this.database.select().from(notes).where(eq(notes.id, noteId)).get();
    if (!local?.conflictServerNote) return;
    const remote = this.parseStoredConflictNote(local.conflictServerNote);
    // Corrupt stashed JSON: unlike keep-mine, there is no local-only fallback
    // here — "use server" has nothing to apply, so leave the row parked rather
    // than guessing.
    if (!remote) return;
    if (remote.deleted_at) {
      // The server's authoritative state (as of the conflict) is "deleted".
      // "Use server's copy" must mean accepting that, not resurrecting a
      // zombie local row that still points remoteId at a gone server note —
      // the delta-cursor pull may never re-deliver that tombstone once our
      // watermark has moved past it. Mirrors applyRemoteNote's own tombstone
      // path (deleteNoteChildrenAndAudio + hard delete).
      this.deleteNoteChildrenAndAudio(local.id);
      this.database.delete(notes).where(eq(notes.id, local.id)).run();
      return;
    }
    // Bypasses applyRemoteNote's pendingSync/conflict guards on purpose — the
    // user explicitly chose the server's copy, so the local edit is discarded.
    // forceTranscript additionally bypasses the hasDirtyTranscript guard so a
    // dirty local transcript doesn't survive to silently re-push over the
    // server copy just chosen.
    const localFolderId = this.resolveFolderByRemoteId(remote.folder_id);
    this.applyRemoteNoteToExisting(local, remote, localFolderId, { forceTranscript: true });
  }

  hardDeleteFolder(localId: number): void {
    this.database.delete(folders).where(eq(folders.id, localId)).run();
  }

  hardDeleteNote(localId: number): void {
    this.deleteNoteChildrenAndAudio(localId);
    this.database.delete(notes).where(eq(notes.id, localId)).run();
  }

  getSyncState(key: string): string | null {
    const row = this.database.select().from(syncState).where(eq(syncState.key, key)).get();
    return row?.value ?? null;
  }

  setSyncState(key: string, value: string): void {
    this.database
      .insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value } })
      .run();
  }

  clearSyncState(key: string): void {
    this.database.delete(syncState).where(eq(syncState.key, key)).run();
  }

  getFoldersMissingClientId(): Folder[] {
    return this.database.select().from(folders).where(isNull(folders.clientFolderId)).all();
  }

  getNotesMissingClientId(): Note[] {
    return this.database.select().from(notes).where(isNull(notes.clientNoteId)).all();
  }

  setFolderClientId(localId: number, clientFolderId: string): Folder {
    return this.database
      .update(folders)
      .set({ clientFolderId, pendingSync: 1 })
      .where(eq(folders.id, localId))
      .returning()
      .get();
  }

  setNoteClientId(localId: number, clientNoteId: string): Note {
    return this.database
      .update(notes)
      .set({ clientNoteId, pendingSync: 1 })
      .where(eq(notes.id, localId))
      .returning()
      .get();
  }

  setNotePrivacy(localId: number, isPrivate: boolean): void {
    // Private rows stop uploading immediately, but keep their identifiers until
    // cloud deletion succeeds. Explicit privacy changes also supersede a parked
    // conflict so later publication can proceed under a fresh server identity.
    this.database
      .update(notes)
      .set({
        isPrivate: isPrivate ? 1 : 0,
        conflictServerNote: null,
        ...(isPrivate
          ? { pendingSync: 0, updatedAt: sql`datetime('now')` }
          : {
              pendingSync: 1,
              clientNoteId: randomUUID(),
              remoteId: null,
              cloudUpdatedAt: null,
              updatedAt: sql`datetime('now')`,
            }),
      })
      .where(eq(notes.id, localId))
      .run();
  }

  clearNoteRemoteId(localId: number): void {
    this.database
      .update(notes)
      .set({ remoteId: null, cloudUpdatedAt: null })
      .where(eq(notes.id, localId))
      .run();
  }

  /**
   * Called when an anonymous onboarding session links to an account. The server
   * migrates billing only, so every remote id here still names a row it keeps
   * under the anonymous user: forget them and re-dirty the rows so the next push
   * re-creates everything under the account instead of PATCHing ids it does not
   * own. Client ids are kept — this is the same content, not a fork.
   */
  dropRemoteIdsForAccountLink(): void {
    this.database
      .update(notes)
      .set({
        remoteId: null,
        cloudUpdatedAt: null,
        ownerUserId: null,
        updatedByUserId: null,
        pendingSync: 1,
      })
      .run();
    for (const table of [folders, transcriptSegments, speakers, dictionaryEntries, snippets]) {
      this.database.update(table).set({ remoteId: null, pendingSync: 1 }).run();
    }
  }

  clearNoteClientId(localId: number): void {
    this.database.update(notes).set({ clientNoteId: null }).where(eq(notes.id, localId)).run();
  }

  wipeAllSyncableData(): void {
    // Free persisted meeting WAVs + diarization rows (FK cascade is inert) before wiping notes.
    const rows = this.database
      .select({ id: notes.id, sourceFile: notes.sourceFile })
      .from(notes)
      .all();
    for (const row of rows) {
      if (row.sourceFile && isManagedMeetingAudioUri(row.id, row.sourceFile)) {
        FileSystem.deleteAsync(row.sourceFile, { idempotent: true }).catch(() => {});
      }
    }
    this.database.delete(transcriptSegments).run();
    this.database.delete(speakers).run();
    this.database.delete(speakerProfiles).run();
    // Deleting notes/folders wholesale also drops every per-note conflict
    // stash (conflict_server_note lives on the notes row itself).
    this.database.delete(notes).run();
    this.database.delete(folders).run();
    // Team spaces belong to the account that's being switched away from; the
    // private space is device-local (getPrivateSpaceId() must keep resolving
    // to it) and is deliberately left alone — see the class-level comment above.
    this.database.delete(spaces).where(eq(spaces.kind, 'team')).run();
    this.database.delete(dictionaryEntries).run();
    this.database.delete(snippets).run();
    // Wholesale, not per-key: also clears the team cursors/capability flag/park
    // keys (teamCursors.ts, teamSpacesCapability.ts, pullParkTracker.ts) —
    // every sync_state row is per-account bookkeeping with no reason to
    // survive a user switch. The caller re-seeds sync.user_id right after.
    this.database.delete(syncState).run();
  }

  // Transcript segments

  getSegments(noteId: number): Segment[] {
    return this.database
      .select()
      .from(transcriptSegments)
      .where(and(eq(transcriptSegments.noteId, noteId), isNull(transcriptSegments.deletedAt)))
      .orderBy(asc(transcriptSegments.sortOrder), asc(transcriptSegments.startMs))
      .all();
  }

  replaceSegments(noteId: number, segments: NewSegment[]): void {
    this.database.transaction((tx) => {
      tx.delete(transcriptSegments).where(eq(transcriptSegments.noteId, noteId)).run();
      segments.forEach((seg, index) => {
        tx.insert(transcriptSegments)
          .values({ ...seg, noteId, sortOrder: seg.sortOrder ?? index, pendingSync: 1 })
          .run();
      });
    });
    this.markNoteTranscriptDirty(noteId);
  }

  // A transcript edit (segments/speakers) must dirty the parent note so the sync
  // engine's note-level `getPendingNotes` picks it up. Gated on privacy: private
  // notes never sync, and marking one would trip pushNotes' private-note guard.
  private markNoteTranscriptDirty(noteId: number): void {
    const row = this.database
      .select({ isPrivate: notes.isPrivate })
      .from(notes)
      .where(eq(notes.id, noteId))
      .get();
    if (!row || row.isPrivate === 1) return;
    this.database
      .update(notes)
      .set({ pendingSync: 1, updatedAt: sql`datetime('now')` })
      .where(eq(notes.id, noteId))
      .run();
  }

  // Cross-device transcript sync (desktop <-> mobile via notes.transcript)

  applyRemoteTranscript(noteId: number, raw: string): void {
    const parsed = parseRemoteTranscript(raw);
    this.database.transaction((tx) => {
      // Only rebuild rows when the raw actually parses; a malformed string still
      // updates notes.transcript (so the equality check converges) but never
      // destroys local segments.
      if (parsed) {
        const existingSpeakers = tx
          .select()
          .from(speakers)
          .where(and(eq(speakers.noteId, noteId), isNull(speakers.deletedAt)))
          .all();
        const existingSpeakerByLabel = new Map(
          existingSpeakers.map((speaker) => [speaker.speakerLabel, speaker]),
        );

        tx.delete(transcriptSegments).where(eq(transcriptSegments.noteId, noteId)).run();
        tx.delete(speakers).where(eq(speakers.noteId, noteId)).run();
        parsed.speakers.forEach((speaker, index) => {
          const existing = existingSpeakerByLabel.get(speaker.speakerLabel);
          tx.insert(speakers)
            .values({
              ...speaker,
              noteId,
              // Voice-profile links and colors are device-local. Preserve them
              // when the wire speaker identity survives a remote transcript edit.
              profileId: existing?.profileId ?? null,
              color: existing?.color ?? null,
              sortOrder: speaker.sortOrder ?? index,
              pendingSync: 0,
            })
            .run();
        });
        parsed.segments.forEach((segment, index) => {
          tx.insert(transcriptSegments)
            .values({ ...segment, noteId, sortOrder: segment.sortOrder ?? index, pendingSync: 0 })
            .run();
        });
      }
      tx.update(notes).set({ transcript: raw }).where(eq(notes.id, noteId)).run();
    });
  }

  hasDirtyTranscript(noteId: number): boolean {
    const dirtySegment = this.database
      .select({ id: transcriptSegments.id })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.noteId, noteId),
          eq(transcriptSegments.pendingSync, 1),
          isNull(transcriptSegments.deletedAt),
        ),
      )
      .get();
    if (dirtySegment) return true;
    const dirtySpeaker = this.database
      .select({ id: speakers.id })
      .from(speakers)
      .where(
        and(eq(speakers.noteId, noteId), eq(speakers.pendingSync, 1), isNull(speakers.deletedAt)),
      )
      .get();
    return !!dirtySpeaker;
  }

  markTranscriptPushed(
    noteId: number,
    raw: string,
    segmentIds: number[],
    speakerIds: number[],
  ): void {
    // The network request may have been in flight while the user edited the
    // transcript. IDs alone are insufficient (a speaker rename keeps its ID),
    // so only acknowledge the snapshot when the current wire representation is
    // still identical. Otherwise keep the parent queued for the next sync.
    const currentRaw = serializeSegmentsForSync(
      this.getSegments(noteId),
      this.getSpeakers(noteId),
      this.getNoteById(noteId)?.transcript,
    );
    if (currentRaw !== raw) {
      this.markNoteTranscriptDirty(noteId);
      return;
    }

    this.database.transaction((tx) => {
      tx.update(notes).set({ transcript: raw }).where(eq(notes.id, noteId)).run();
      if (segmentIds.length > 0) {
        tx.update(transcriptSegments)
          .set({ pendingSync: 0 })
          .where(inArray(transcriptSegments.id, segmentIds))
          .run();
      }
      if (speakerIds.length > 0) {
        tx.update(speakers).set({ pendingSync: 0 }).where(inArray(speakers.id, speakerIds)).run();
      }
    });
  }

  // Speakers

  getSpeakers(noteId: number): Speaker[] {
    return this.database
      .select()
      .from(speakers)
      .where(and(eq(speakers.noteId, noteId), isNull(speakers.deletedAt)))
      .orderBy(asc(speakers.sortOrder))
      .all();
  }

  upsertSpeakers(noteId: number, rows: NewSpeaker[]): void {
    this.database.transaction((tx) => {
      rows.forEach((row, index) => {
        tx.insert(speakers)
          .values({ ...row, noteId, sortOrder: row.sortOrder ?? index, pendingSync: 1 })
          .run();
      });
    });
  }

  updateSpeaker(id: number, updates: Partial<Speaker>): void {
    this.database
      .update(speakers)
      .set({ ...updates, pendingSync: 1, updatedAt: sql`datetime('now')` })
      .where(eq(speakers.id, id))
      .run();
    const row = this.database
      .select({ noteId: speakers.noteId })
      .from(speakers)
      .where(eq(speakers.id, id))
      .get();
    if (row) this.markNoteTranscriptDirty(row.noteId);
  }

  mergeSpeakers(
    noteId: number,
    sourceSpeakerId: number,
    targetSpeakerId: number,
    targetUpdates: Partial<Speaker>,
  ): void {
    if (sourceSpeakerId === targetSpeakerId) {
      throw new Error('Cannot merge a speaker into itself');
    }

    const source = this.database
      .select()
      .from(speakers)
      .where(
        and(
          eq(speakers.id, sourceSpeakerId),
          eq(speakers.noteId, noteId),
          isNull(speakers.deletedAt),
        ),
      )
      .get();
    const target = this.database
      .select()
      .from(speakers)
      .where(
        and(
          eq(speakers.id, targetSpeakerId),
          eq(speakers.noteId, noteId),
          isNull(speakers.deletedAt),
        ),
      )
      .get();

    if (!source) throw new Error('Source speaker not found');
    if (!target) throw new Error('Target speaker not found');

    this.database.transaction((tx) => {
      tx.update(transcriptSegments)
        .set({
          speakerLabel: target.speakerLabel,
          pendingSync: 1,
          updatedAt: sql`datetime('now')`,
        })
        .where(
          and(
            eq(transcriptSegments.noteId, noteId),
            eq(transcriptSegments.speakerLabel, source.speakerLabel),
            isNull(transcriptSegments.deletedAt),
          ),
        )
        .run();

      tx.update(speakers)
        .set({ ...targetUpdates, pendingSync: 1, updatedAt: sql`datetime('now')` })
        .where(
          and(eq(speakers.id, target.id), eq(speakers.noteId, noteId), isNull(speakers.deletedAt)),
        )
        .run();

      tx.update(speakers)
        .set({
          deletedAt: sql`datetime('now')`,
          pendingSync: 1,
          updatedAt: sql`datetime('now')`,
        })
        .where(
          and(eq(speakers.id, source.id), eq(speakers.noteId, noteId), isNull(speakers.deletedAt)),
        )
        .run();
    });
    this.markNoteTranscriptDirty(noteId);
  }

  // Speaker profiles

  getSpeakerProfiles(): SpeakerProfile[] {
    return this.database
      .select()
      .from(speakerProfiles)
      .orderBy(asc(speakerProfiles.id))
      .all()
      .map((row) => this.mapSpeakerProfile(row));
  }

  getSpeakerProfileById(id: number): SpeakerProfile | null {
    const row = this.database
      .select()
      .from(speakerProfiles)
      .where(eq(speakerProfiles.id, id))
      .get();
    return row ? this.mapSpeakerProfile(row) : null;
  }

  createSpeakerProfile(input: NewSpeakerProfile): SpeakerProfile {
    validateSpeakerProfileOwnerFlag(input.isOwner);
    this.validateSpeakerProfileEmbedding(input.embedding);
    try {
      const row = this.database
        .insert(speakerProfiles)
        .values({ ...input, embedding: encodeSpeakerProfileEmbedding(input.embedding) })
        .returning()
        .get();
      return this.mapSpeakerProfile(row);
    } catch (error) {
      mapSpeakerProfileOwnerConstraint(error);
    }
  }

  updateSpeakerProfile(id: number, updates: Partial<SpeakerProfile>): void {
    const { embedding, ...rest } = updates;
    delete rest.id;
    validateSpeakerProfileOwnerFlag(rest.isOwner);
    const dbUpdates: Partial<typeof speakerProfiles.$inferInsert> = { ...rest };
    if (embedding !== undefined) {
      this.validateSpeakerProfileEmbedding(embedding, id);
      dbUpdates.embedding = encodeSpeakerProfileEmbedding(embedding);
    }

    try {
      this.database
        .update(speakerProfiles)
        .set({ ...dbUpdates, updatedAt: sql`datetime('now')` })
        .where(eq(speakerProfiles.id, id))
        .run();
    } catch (error) {
      mapSpeakerProfileOwnerConstraint(error);
    }
  }

  deleteSpeakerProfile(id: number): void {
    this.database.transaction((tx) => {
      tx.update(speakers)
        .set({
          profileId: null,
          pendingSync: 1,
          updatedAt: sql`datetime('now')`,
        })
        .where(
          and(
            eq(speakers.profileId, id),
            eq(speakers.speakerLocked, 0),
            or(isNull(speakers.speakerLockSource), ne(speakers.speakerLockSource, 'user')),
          ),
        )
        .run();
      tx.delete(speakerProfiles).where(eq(speakerProfiles.id, id)).run();
    });
  }

  deleteAllSpeakerProfiles(): void {
    this.database.transaction((tx) => {
      tx.update(speakers)
        .set({
          profileId: null,
          pendingSync: 1,
          updatedAt: sql`datetime('now')`,
        })
        .where(
          and(
            isNotNull(speakers.profileId),
            eq(speakers.speakerLocked, 0),
            or(isNull(speakers.speakerLockSource), ne(speakers.speakerLockSource, 'user')),
          ),
        )
        .run();
      tx.delete(speakerProfiles).run();
    });
  }

  // Transcription status

  getTranscriptionStatus(noteId: number): TranscriptionStatus {
    const row = this.database
      .select({ status: notes.transcriptionStatus })
      .from(notes)
      .where(eq(notes.id, noteId))
      .get();
    return row && isTranscriptionStatus(row.status ?? '')
      ? (row.status as TranscriptionStatus)
      : 'idle';
  }

  setTranscriptionStatus(noteId: number, status: TranscriptionStatus): void {
    this.database
      .update(notes)
      .set({ transcriptionStatus: status, updatedAt: sql`datetime('now')` })
      .where(eq(notes.id, noteId))
      .run();
  }

  updateNoteMeta(noteId: number, updates: MeetingNoteUpdate): void {
    this.database
      .update(notes)
      .set({ ...updates, updatedAt: sql`datetime('now')` })
      .where(eq(notes.id, noteId))
      .run();
  }

  updateNoteCalendarContext(noteId: number, updates: MeetingCalendarContextUpdate): void {
    const row = this.database
      .select({ isPrivate: notes.isPrivate })
      .from(notes)
      .where(eq(notes.id, noteId))
      .get();

    this.database
      .update(notes)
      .set({
        ...updates,
        ...(row?.isPrivate === 1 ? {} : { pendingSync: 1 }),
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(notes.id, noteId))
      .run();
  }
}
