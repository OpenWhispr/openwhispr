import type {
  folders,
  notes,
  actions,
  transcriptSegments,
  speakers,
  speakerProfiles,
} from '@/db/schema';
import type { TranscriptionStatus } from '@/lib/diarization/diarizer';

export type Note = typeof notes.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Action = typeof actions.$inferSelect;
export type Segment = typeof transcriptSegments.$inferSelect;
export type NewSegment = typeof transcriptSegments.$inferInsert;
export type Speaker = typeof speakers.$inferSelect;
export type NewSpeaker = typeof speakers.$inferInsert;
export type SpeakerProfileRow = typeof speakerProfiles.$inferSelect;
export type SpeakerProfileOwnerFlag = 0 | 1;
export type SpeakerProfile = Omit<SpeakerProfileRow, 'embedding' | 'isOwner'> & {
  embedding: number[];
  isOwner: SpeakerProfileOwnerFlag;
};
export type NewSpeakerProfile = Omit<
  typeof speakerProfiles.$inferInsert,
  'id' | 'embedding' | 'isOwner' | 'createdAt' | 'updatedAt'
> & {
  embedding: number[];
  isOwner?: SpeakerProfileOwnerFlag;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type NoteUpdate = Partial<
  Pick<
    Note,
    | 'title'
    | 'content'
    | 'folderId'
    | 'enhancedContent'
    | 'enhancementPrompt'
    | 'enhancedAtContentHash'
  >
>;
export type ActionUpdate = Partial<Pick<Action, 'name' | 'description' | 'prompt'>>;

// Meeting/diarization columns NoteUpdate cannot reach. These remain local-only; selected calendar
// context uses MeetingCalendarContextUpdate so public notes can sync it without syncing diarization.
// transcriptionStatus is intentionally NOT here: status changes go ONLY through the guarded transition
// path (store.transitionStatus / the service's advance()), never a bulk meta write that bypasses assertTransition.
export type MeetingNoteUpdate = Partial<
  Pick<
    Note,
    | 'noteType'
    | 'diarizationEnabled'
    | 'expectedSpeakerCount'
    | 'sourceFile'
    | 'audioDurationSeconds'
  >
>;
export type MeetingCalendarContextUpdate = Partial<Pick<Note, 'calendarEventId' | 'participants'>>;

/** Server-shaped folder used by sync apply paths. */
export interface RemoteFolder {
  id: string;
  client_folder_id: string | null;
  name: string;
  is_default: boolean;
  sort_order: number;
  deleted_at: string | null;
  updated_at: string;
  // Scope fields declared for a later task; not yet populated by pull/apply.
  space_id?: string | null;
  workspace_id?: string | null;
  previous_space_id?: string | null;
  /**
   * Redacted stub: the folder left the caller's reach. The server sends only
   * ids, scope and updated_at — `name`, `is_default`, `sort_order` and
   * `deleted_at` are absent despite this type declaring them, so a stub must
   * never reach an apply path (see pullFoldersTeam).
   */
  access_removed?: boolean;
}

/** Server-shaped note used by sync apply paths. */
export interface RemoteNote {
  id: string;
  client_note_id: string | null;
  title: string | null;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  note_type: string;
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: string | null;
  participants: string | null;
  calendar_event_id: string | null;
  /** Desktop-shape transcript JSON; decomposed into segments/speakers on apply. */
  transcript: string | null;
  deleted_at: string | null;
  updated_at: string;
  // Scope fields declared for a later task; not yet populated by pull/apply.
  space_id?: string | null;
  workspace_id?: string | null;
  previous_space_id?: string | null;
  user_id?: string | null;
  updated_by_user_id?: string | null;
  access_removed?: boolean;
}

/**
 * Scope context for a remote apply. Omitted entirely by the personal pull
 * passes, which own `space_id IS NULL` rows and must keep their existing
 * behavior.
 */
export interface ApplyRemoteOptions {
  /**
   * Local `spaces.id` this row belongs to. Always written on INSERT (falling
   * back to the private space when omitted, so no apply path leaves
   * `space_id` NULL); written on UPDATE only when explicitly provided, so a
   * personal-pass apply never relocates an existing row.
   */
  spaceId?: number;
}

export interface ApplyRemoteNoteOptions extends ApplyRemoteOptions {
  /**
   * Persist `user_id` / `updated_by_user_id` from the remote row. Team-pass
   * only: `scope=all` responses carry cloud ownership, the personal list
   * doesn't, so the personal pass must not write (or clear) these columns.
   */
  applyOwnership?: boolean;
}

export interface RemoteNoteCreateResult {
  id: string;
  client_note_id?: string | null;
  updated_at?: string | null;
}

/** A note parked after a push-time 409 note_version_conflict — the future Keep-mine/Use-server banner's data source. */
export interface ConflictedNote {
  id: number;
  title: string | null;
  /** null when the stashed JSON fails to parse (defensive — should not happen in practice); keep-mine still resolves such a row with no dependency on this. */
  conflictServerNote: RemoteNote | null;
}

export interface NotesRepository {
  // Existing methods
  getFolders(): Folder[];
  /**
   * Every folder row, soft-deleted ones included — unlike getFolders(). The
   * team pull pass resolves remote folder ids against this: a locally
   * soft-deleted folder is still a real row with a perfectly usable id, and
   * treating it as missing would park the crawl on every note filed there
   * until the pending delete finally pushes.
   */
  getFoldersIncludingDeleted(): Folder[];
  /**
   * Private-space folders only — what every personal folder surface shows
   * (browsing list, the move-note picker, rename/delete/create). Team-space
   * folders are reachable through the Spaces section instead: offering them as
   * personal targets would file a personal note into a folder the server
   * rejects, and deleting one would tombstone teammates' notes.
   */
  getPrivateFolders(): Folder[];
  /** Folders belonging to one space — the private space's own list is getPrivateFolders(). */
  getFoldersBySpace(spaceId: number): Folder[];
  getFolderCounts(): Record<number, number>;
  /** Defaults to the private space; pass `spaceId` to create the folder inside a team space. */
  createFolder(name: string, spaceId?: number): Folder;
  renameFolder(id: number, name: string): void;
  deleteFolder(id: number): void;
  getNotesByFolder(folderId: number): Note[];
  /** Mirrors getNotesByFolder — notes browsing/filtering by space (see FoldersScreen's Spaces section). */
  getNotesBySpace(spaceId: number): Note[];
  /**
   * Notes sitting directly in a space rather than in one of its folders. Browsing a space lists
   * its folders above its notes, so the note list must exclude what the folder rows already
   * account for — otherwise every foldered note appears twice.
   */
  getSpaceNotesWithoutFolder(spaceId: number): Note[];
  getAllNotes(): Note[];
  getNoteById(id: number): Note | null;
  /**
   * `spaceId` files the note directly into a space with no folder (browsing that space); otherwise
   * the note lands in `folderId` and inherits whichever space that folder belongs to.
   */
  createNote(title: string, content: string, folderId?: number, spaceId?: number): Note;
  updateNote(id: number, updates: NoteUpdate): void;
  deleteNote(id: number): void;
  moveNoteToFolder(noteId: number, folderId: number): void;
  moveNotesToFolder(fromFolderId: number, toFolderId: number): void;
  /**
   * Deletes a folder the way the server does — tombstoning its notes with it — journaling every
   * touched row first so the delete can be undone, and holding those notes out of the push queue
   * and every pull until pushFolders reports the server's verdict.
   */
  deleteFolderCascade(folderId: number): void;
  /** The server accepted the folder delete: purge the folder and its cascaded notes. */
  finalizeFolderDelete(folderId: number): void;
  /** The server refused the folder delete: restore every row the cascade touched. */
  revertFolderDelete(folderId: number): void;
  /** True while an in-flight folder delete owns this note, so no pull may apply over it. */
  isRemoteNoteHeldByFolderDelete(remote: Pick<RemoteNote, 'id' | 'client_note_id'>): boolean;
  /**
   * Re-homes a note into a different space: sets space_id to the target, clears folder_id (a
   * folder from the old space is never valid in the new one), and marks pending so the next push
   * carries the move. Which targets the UI may offer is canMoveBetweenSpaces' call — personal
   * content into any team space, team content only within its own workspace.
   */
  moveNoteToSpace(noteId: number, spaceId: number): void;
  searchNotes(query: string, folderId?: number): Note[];
  getActions(): Action[];
  getActionById(id: number): Action | null;
  createAction(name: string, description: string, prompt: string): Action;
  updateAction(id: number, updates: ActionUpdate): void;
  deleteAction(id: number): void;

  // Sync helpers
  getPendingFolders(): Folder[];
  getPendingNotes(): Note[];
  getPrivateNotesPendingDeletion(): Note[];
  applyRemoteFolder(remote: RemoteFolder, options?: ApplyRemoteOptions): void;
  applyRemoteNote(
    remote: RemoteNote,
    resolveFolder: (serverFolderId: string | null) => number | null,
    options?: ApplyRemoteNoteOptions,
  ): void;
  /**
   * Resolves the local row a remote note maps to, using the same matching rule
   * as applyRemoteNote (client_note_id when present, else remote_id). Lets the
   * team pull pass decide what to do with an access-removed stub, which carries
   * no content and so must never go through an apply path.
   */
  getNoteForRemote(remote: Pick<RemoteNote, 'id' | 'client_note_id'>): Note | null;
  /**
   * Resolves the local row a remote folder id maps to. Lets the team pull pass
   * decide what to do with an access-removed folder stub, which carries no
   * fields and so must never go through an apply path. Matching is by remote id
   * alone: a stub is only ever about a folder this device already synced.
   */
  getFolderByRemoteId(remoteId: string): Folder | null;
  /**
   * Re-homes a note into the private space as a brand-new personal note: fresh
   * client_note_id, no cloud identity (remote_id / cloud_updated_at / owner /
   * editor cleared), no folder, no parked conflict, still pending so the next
   * push re-creates it. Used when access to its space is revoked but the row
   * still holds unpushed local work.
   */
  forkNoteToPrivate(noteId: number): void;
  markFolderPushed(
    localId: number,
    remoteId: string,
    serverUpdatedAt: string,
    pushed?: Folder,
  ): void;
  /**
   * Clears a folder's pendingSync with no other changes — used when the server
   * permanently refused the push (space access lost, or the caller lacks
   * permission on this folder). The local row is deliberately left as-is; its
   * notes recover individually through their own push errors and pull stubs.
   */
  markFolderTerminal(localId: number): void;
  /**
   * Merges a locally-pending default folder into an already-synced duplicate
   * row a later pull inserted for the same server folder (see pushFolders.ts's
   * pre-create adoption check). `survivingLocalId` keeps its own local id —
   * every pre-existing note.folder_id already points at it — and is pointed at
   * `remoteId`/`serverUpdatedAt` with pendingSync cleared, exactly like
   * markFolderPushed. Notes filed under `duplicateLocalId` are re-parented onto
   * `survivingLocalId` with NO pendingSync change: the server's folder_id for
   * those notes is unchanged (both local rows already resolve to the same
   * server folder), so this is a pure local FK fixup, not a push-worthy edit.
   * `duplicateLocalId` is then removed.
   */
  adoptDuplicateFolder(
    survivingLocalId: number,
    duplicateLocalId: number,
    remoteId: string,
    serverUpdatedAt: string,
  ): void;
  /**
   * Acknowledges a push of `pushed`, the row exactly as it was serialized. The
   * row settles (pendingSync cleared) only if it is still unchanged; a note
   * edited or deleted while the request was in flight stays queued and merely
   * records the server revision as its next base.
   *
   * cloudUpdatedAt defaults to serverUpdatedAt when omitted. Pass it explicitly
   * as `null` when serverUpdatedAt is itself a local-clock fallback (the server
   * response omitted its own updated_at) — cloudUpdatedAt must only ever hold a
   * genuine server ack, never a value guaranteed to mismatch on the next push.
   */
  markNotePushed(
    pushed: Note,
    remoteId: string,
    serverUpdatedAt: string,
    cloudUpdatedAt?: string | null,
  ): void;
  /** Clears pendingSync with no other changes — used when a push was permanently rejected (e.g. HTTP 400) and retrying would never succeed. */
  markNoteTerminal(localId: number): void;
  /**
   * Abandons the local push attempt for a row the server refused on permission
   * grounds (note_access_denied / note_scope_change_denied): clears pendingSync
   * AND drops cloud_updated_at. The server row is untouched by the rejected
   * write, so the next pull's copy is the truth — and without clearing the base
   * that pull could otherwise be followed by a stale-base 409.
   */
  dropNotePushAttempt(localId: number): void;
  /**
   * Records a push-time 409 note_version_conflict: stores the server's current
   * copy in conflict_server_note and leaves pendingSync untouched (local edits
   * are preserved). The row is excluded from getPendingNotes until resolved.
   */
  parkNoteConflict(localId: number, serverNote: RemoteNote): void;
  /** Rows currently parked in conflict — data source for the future Keep-mine/Use-server banner. */
  listConflictedNotes(): ConflictedNote[];
  /** Keep the local edit: clear the conflict and adopt the stored server updated_at as the new base (so the next push wins); pendingSync stays set. */
  resolveConflictKeepMine(noteId: number): void;
  /** Use the server's copy: apply the stored server note over the local row, then clear the conflict and pendingSync. */
  resolveConflictUseServer(noteId: number): void;
  hardDeleteFolder(localId: number): void;
  hardDeleteNote(localId: number): void;
  getSyncState(key: string): string | null;
  setSyncState(key: string, value: string): void;
  /**
   * Removes the key entirely, so getSyncState reads `null` again — the exact
   * state a device that never synced is in. Used to reset a pull cursor (see
   * resetTeamCursors); writing an empty string instead would not do, because a
   * stored '' reads back as a non-null cursor that then drops out of the
   * request as falsy — putting the list endpoint into its tombstone-free browse
   * mode rather than replaying the delta crawl from epoch.
   */
  clearSyncState(key: string): void;

  // Initial backfill
  getFoldersMissingClientId(): Folder[];
  getNotesMissingClientId(): Note[];
  setFolderClientId(localId: number, clientFolderId: string): Folder;
  setNoteClientId(localId: number, clientNoteId: string): Note;

  // Private mode
  setNotePrivacy(localId: number, isPrivate: boolean): void;
  clearNoteRemoteId(localId: number): void;
  /** Forgets every remote id and re-dirties all rows when an anonymous session links to an account. */
  dropRemoteIdsForAccountLink(): void;
  clearNoteClientId(localId: number): void;

  // Account switch — wipe all syncable data
  wipeAllSyncableData(): void;

  // Transcript segments
  getSegments(noteId: number): Segment[];
  /** Atomically replaces ALL segments for a note (hard-deletes existing, then inserts). Use after a diarize/merge pass. */
  replaceSegments(noteId: number, segments: NewSegment[]): void;

  // Cross-device transcript sync (desktop <-> mobile via notes.transcript)
  /** Rebuilds a note's segments + speakers from desktop-shape transcript JSON and stores the raw string. */
  applyRemoteTranscript(noteId: number, raw: string): void;
  /** True when the note has locally-authored segment or speaker rows awaiting push. */
  hasDirtyTranscript(noteId: number): boolean;
  /** After a successful push: stores the serialized string and clears pendingSync on exactly the pushed rows. */
  markTranscriptPushed(
    noteId: number,
    raw: string,
    segmentIds: number[],
    speakerIds: number[],
  ): void;

  // Speakers
  getSpeakers(noteId: number): Speaker[];
  /**
   * INSERT-ONLY (no conflict resolution despite the name) — inserts new speaker rows for a note.
   * Re-diarize reconciliation (dedupe/merge by label, preserving locks) is M2's job and MUST go
   * through `speakerState.mergeSpeakerState` before persisting. Do not call this to update existing speakers.
   */
  upsertSpeakers(noteId: number, speakers: NewSpeaker[]): void;
  /**
   * Dumb sink: writes `updates` unconditionally and does NOT enforce the speaker lock.
   * Callers (M3 rename / M4 voiceprint) MUST route changes through `speakerState`
   * (`isLocked`/`applySuggested`/`lockSpeaker`/`mergeSpeakerState`) first, or a locked speaker can be clobbered.
   * Note: `Speaker.speakerLocked` is an integer (0/1) from SQLite — map to boolean before passing a row into `speakerState`.
   */
  updateSpeaker(id: number, updates: Partial<Speaker>): void;
  /**
   * User merge operation: relabel source segments to target and soft-delete the source speaker.
   * Dumb persistence sink — callers must build targetUpdates through speakerState policy helpers.
   */
  mergeSpeakers(
    noteId: number,
    sourceSpeakerId: number,
    targetSpeakerId: number,
    targetUpdates: Partial<Speaker>,
  ): void;

  // Speaker profiles — local only, never synced
  getSpeakerProfiles(): SpeakerProfile[];
  getSpeakerProfileById(id: number): SpeakerProfile | null;
  createSpeakerProfile(input: NewSpeakerProfile): SpeakerProfile;
  updateSpeakerProfile(id: number, updates: Partial<SpeakerProfile>): void;
  deleteSpeakerProfile(id: number): void;
  deleteAllSpeakerProfiles(): void;

  // Transcription status
  /** Read the note's current status (defaults to 'idle'). Used by the guarded transition path. */
  getTranscriptionStatus(noteId: number): TranscriptionStatus;
  /** Low-level status writer. Call ONLY inside a guarded transition (store.transitionStatus / service advance()). */
  setTranscriptionStatus(noteId: number, status: TranscriptionStatus): void;
  /** Update local-only meeting/diarization columns NoteUpdate cannot reach. */
  updateNoteMeta(noteId: number, updates: MeetingNoteUpdate): void;
  /** Update selected calendar context; public notes mark pending sync, private notes stay local-only. */
  updateNoteCalendarContext(noteId: number, updates: MeetingCalendarContextUpdate): void;
}
