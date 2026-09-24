import { LocalNotesRepository } from '../local/notesRepository';
import { randomUUID } from '@/lib/uuid';
import { requestSync } from '@/sync/syncEngine';
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
  NewSpeakerProfile,
} from '../types';

export class SyncedNotesRepository implements NotesRepository {
  private readonly local: LocalNotesRepository;

  constructor(local = new LocalNotesRepository()) {
    this.local = local;
  }

  // Reads — pass through to local
  getFolders(): Folder[] {
    return this.local.getFolders();
  }
  getFoldersIncludingDeleted(): Folder[] {
    return this.local.getFoldersIncludingDeleted();
  }
  getPrivateFolders(): Folder[] {
    return this.local.getPrivateFolders();
  }
  getFoldersBySpace(spaceId: number): Folder[] {
    return this.local.getFoldersBySpace(spaceId);
  }
  getFolderCounts(): Record<number, number> {
    return this.local.getFolderCounts();
  }
  getNotesByFolder(folderId: number): Note[] {
    return this.local.getNotesByFolder(folderId);
  }
  getNotesBySpace(spaceId: number): Note[] {
    return this.local.getNotesBySpace(spaceId);
  }
  getSpaceNotesWithoutFolder(spaceId: number): Note[] {
    return this.local.getSpaceNotesWithoutFolder(spaceId);
  }
  getAllNotes(): Note[] {
    return this.local.getAllNotes();
  }
  getNoteById(id: number): Note | null {
    return this.local.getNoteById(id);
  }
  searchNotes(query: string, folderId?: number): Note[] {
    return this.local.searchNotes(query, folderId);
  }
  getActions(): Action[] {
    return this.local.getActions();
  }
  getActionById(id: number): Action | null {
    return this.local.getActionById(id);
  }
  listConflictedNotes(): ConflictedNote[] {
    return this.local.listConflictedNotes();
  }

  // Writes — local-first, mark pending, nudge sync
  createFolder(name: string, spaceId?: number): Folder {
    const folder = this.local.createFolder(name, spaceId);
    const updated = this.local.setFolderClientId(folder.id, randomUUID());
    requestSync('after-write');
    return updated;
  }

  renameFolder(id: number, name: string): void {
    this.local.renameFolder(id, name);
    requestSync('after-write');
  }

  deleteFolder(id: number): void {
    this.local.deleteFolder(id);
    requestSync('after-write');
  }

  createNote(title: string, content: string, folderId?: number, spaceId?: number): Note {
    const note = this.local.createNote(title, content, folderId, spaceId);
    const updated = this.local.setNoteClientId(note.id, randomUUID());
    requestSync('after-write');
    return updated;
  }

  updateNote(id: number, updates: NoteUpdate): void {
    this.local.updateNote(id, updates);
    requestSync('after-write');
  }

  deleteNote(id: number): void {
    this.local.deleteNote(id);
    requestSync('after-write');
  }

  // Conflict resolution primitives (consumed by the future Keep/Refresh banner).
  resolveConflictKeepMine(noteId: number): void {
    this.local.resolveConflictKeepMine(noteId);
    requestSync('after-write');
  }

  resolveConflictUseServer(noteId: number): void {
    this.local.resolveConflictUseServer(noteId);
    requestSync('after-write');
  }

  moveNoteToFolder(noteId: number, folderId: number): void {
    this.local.moveNoteToFolder(noteId, folderId);
    requestSync('after-write');
  }

  moveNotesToFolder(fromFolderId: number, toFolderId: number): void {
    this.local.moveNotesToFolder(fromFolderId, toFolderId);
    requestSync('after-write');
  }

  deleteFolderCascade(folderId: number): void {
    this.local.deleteFolderCascade(folderId);
    requestSync('after-write');
  }

  // Both settle a push already in flight — pushFolders calls them mid-pass, so
  // neither may nudge sync again.
  finalizeFolderDelete(folderId: number): void {
    this.local.finalizeFolderDelete(folderId);
  }
  revertFolderDelete(folderId: number): void {
    this.local.revertFolderDelete(folderId);
  }
  isRemoteNoteHeldByFolderDelete(remote: Pick<RemoteNote, 'id' | 'client_note_id'>): boolean {
    return this.local.isRemoteNoteHeldByFolderDelete(remote);
  }

  moveNoteToSpace(noteId: number, spaceId: number): void {
    this.local.moveNoteToSpace(noteId, spaceId);
    requestSync('after-write');
  }

  // Actions don't sync (out of scope v1)
  createAction(name: string, description: string, prompt: string): Action {
    return this.local.createAction(name, description, prompt);
  }
  updateAction(id: number, updates: ActionUpdate): void {
    this.local.updateAction(id, updates);
  }
  deleteAction(id: number): void {
    this.local.deleteAction(id);
  }

  // Sync internals — engine calls these directly
  getPendingFolders(): Folder[] {
    return this.local.getPendingFolders();
  }
  getPrivateNotesPendingDeletion(): Note[] {
    return this.local.getPrivateNotesPendingDeletion();
  }
  getPendingNotes(): Note[] {
    return this.local.getPendingNotes();
  }
  applyRemoteFolder(remote: RemoteFolder, options?: ApplyRemoteOptions): void {
    this.local.applyRemoteFolder(remote, options);
  }
  applyRemoteNote(
    remote: RemoteNote,
    resolveFolder: (serverFolderId: string | null) => number | null,
    options?: ApplyRemoteNoteOptions,
  ): void {
    this.local.applyRemoteNote(remote, resolveFolder, options);
  }
  getNoteForRemote(remote: Pick<RemoteNote, 'id' | 'client_note_id'>): Note | null {
    return this.local.getNoteForRemote(remote);
  }
  getFolderByRemoteId(remoteId: string): Folder | null {
    return this.local.getFolderByRemoteId(remoteId);
  }
  forkNoteToPrivate(noteId: number): void {
    this.local.forkNoteToPrivate(noteId);
  }
  markFolderPushed(
    localId: number,
    remoteId: string,
    serverUpdatedAt: string,
    pushed?: Folder,
  ): void {
    this.local.markFolderPushed(localId, remoteId, serverUpdatedAt, pushed);
  }
  markFolderTerminal(localId: number): void {
    this.local.markFolderTerminal(localId);
  }
  adoptDuplicateFolder(
    survivingLocalId: number,
    duplicateLocalId: number,
    remoteId: string,
    serverUpdatedAt: string,
  ): void {
    this.local.adoptDuplicateFolder(survivingLocalId, duplicateLocalId, remoteId, serverUpdatedAt);
  }
  markNotePushed(
    pushed: Note,
    remoteId: string,
    serverUpdatedAt: string,
    cloudUpdatedAt?: string | null,
  ): void {
    this.local.markNotePushed(pushed, remoteId, serverUpdatedAt, cloudUpdatedAt);
  }
  markNoteTerminal(localId: number): void {
    this.local.markNoteTerminal(localId);
  }
  dropNotePushAttempt(localId: number): void {
    this.local.dropNotePushAttempt(localId);
  }
  parkNoteConflict(localId: number, serverNote: RemoteNote): void {
    this.local.parkNoteConflict(localId, serverNote);
  }
  hardDeleteFolder(localId: number): void {
    this.local.hardDeleteFolder(localId);
  }
  hardDeleteNote(localId: number): void {
    this.local.hardDeleteNote(localId);
  }
  getSyncState(key: string): string | null {
    return this.local.getSyncState(key);
  }
  setSyncState(key: string, value: string): void {
    this.local.setSyncState(key, value);
  }
  clearSyncState(key: string): void {
    this.local.clearSyncState(key);
  }
  getFoldersMissingClientId(): Folder[] {
    return this.local.getFoldersMissingClientId();
  }
  getNotesMissingClientId(): Note[] {
    return this.local.getNotesMissingClientId();
  }
  setFolderClientId(localId: number, clientFolderId: string): Folder {
    return this.local.setFolderClientId(localId, clientFolderId);
  }
  setNoteClientId(localId: number, clientNoteId: string): Note {
    return this.local.setNoteClientId(localId, clientNoteId);
  }
  setNotePrivacy(localId: number, isPrivate: boolean): void {
    this.local.setNotePrivacy(localId, isPrivate);
    // Both publication and private-copy deletion need a sync retry.
    requestSync('after-write');
  }
  clearNoteRemoteId(localId: number): void {
    this.local.clearNoteRemoteId(localId);
  }
  dropRemoteIdsForAccountLink(): void {
    this.local.dropRemoteIdsForAccountLink();
  }
  clearNoteClientId(localId: number): void {
    this.local.clearNoteClientId(localId);
  }
  wipeAllSyncableData(): void {
    this.local.wipeAllSyncableData();
  }

  // Transcript segments — writes dirty the parent note (see LocalNotesRepository),
  // so nudge sync like other note writes; reads pass through.
  getSegments(noteId: number): Segment[] {
    return this.local.getSegments(noteId);
  }
  replaceSegments(noteId: number, segments: NewSegment[]): void {
    this.local.replaceSegments(noteId, segments);
    requestSync('after-write');
  }

  // Cross-device transcript sync — pass through
  applyRemoteTranscript(noteId: number, raw: string): void {
    this.local.applyRemoteTranscript(noteId, raw);
  }
  hasDirtyTranscript(noteId: number): boolean {
    return this.local.hasDirtyTranscript(noteId);
  }
  markTranscriptPushed(
    noteId: number,
    raw: string,
    segmentIds: number[],
    speakerIds: number[],
  ): void {
    this.local.markTranscriptPushed(noteId, raw, segmentIds, speakerIds);
  }

  // Speakers — rename/merge dirty the parent note, so nudge sync; reads pass through.
  getSpeakers(noteId: number): Speaker[] {
    return this.local.getSpeakers(noteId);
  }
  upsertSpeakers(noteId: number, rows: NewSpeaker[]): void {
    this.local.upsertSpeakers(noteId, rows);
  }
  updateSpeaker(id: number, updates: Partial<Speaker>): void {
    this.local.updateSpeaker(id, updates);
    requestSync('after-write');
  }
  mergeSpeakers(
    noteId: number,
    sourceSpeakerId: number,
    targetSpeakerId: number,
    targetUpdates: Partial<Speaker>,
  ): void {
    this.local.mergeSpeakers(noteId, sourceSpeakerId, targetSpeakerId, targetUpdates);
    requestSync('after-write');
  }

  // Speaker profiles — local only, pass through
  getSpeakerProfiles(): SpeakerProfile[] {
    return this.local.getSpeakerProfiles();
  }
  getSpeakerProfileById(id: number): SpeakerProfile | null {
    return this.local.getSpeakerProfileById(id);
  }
  createSpeakerProfile(input: NewSpeakerProfile): SpeakerProfile {
    return this.local.createSpeakerProfile(input);
  }
  updateSpeakerProfile(id: number, updates: Partial<SpeakerProfile>): void {
    this.local.updateSpeakerProfile(id, updates);
  }
  deleteSpeakerProfile(id: number): void {
    this.local.deleteSpeakerProfile(id);
  }
  deleteAllSpeakerProfiles(): void {
    this.local.deleteAllSpeakerProfiles();
  }

  // Transcription status — local only, pass through
  getTranscriptionStatus(noteId: number): TranscriptionStatus {
    return this.local.getTranscriptionStatus(noteId);
  }

  setTranscriptionStatus(noteId: number, status: TranscriptionStatus): void {
    this.local.setTranscriptionStatus(noteId, status);
  }

  updateNoteMeta(noteId: number, updates: MeetingNoteUpdate): void {
    this.local.updateNoteMeta(noteId, updates);
  }

  updateNoteCalendarContext(noteId: number, updates: MeetingCalendarContextUpdate): void {
    const note = this.local.getNoteById(noteId);
    this.local.updateNoteCalendarContext(noteId, updates);
    if (note && note.isPrivate !== 1) requestSync('after-write');
  }
}
